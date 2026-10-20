package reader

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func methodAnnotationLocation(content string, start, end int) json.RawMessage {
	return json.RawMessage(jsonText(map[string]any{"type": "method-analysis", "contentHash": sourceKey(content), "start": start, "end": end, "quote": "法😀"}))
}

func TestMethodAnnotationsCRUDAndUndoPreserveVersionAndUTF16Location(t *testing.T) {
	for _, kind := range []string{"pdf", "epub"} {
		t.Run(kind, func(t *testing.T) {
			s := methodFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET type=? WHERE id='doc'", kind); err != nil {
				t.Fatal(err)
			}
			location := methodAnnotationLocation("**法😀**", 0, 3)
			a := Annotation{Kind: "note", Location: location, Quote: "法😀", Note: "用户笔记", Color: "#e6b94c"}
			saved := undoMark(t, s, "method-client", a)
			if saved.ID == "" || saved.Quote != a.Quote || string(saved.Location) != string(location) {
				t.Fatalf("method position changed on creation: %+v", saved)
			}
			original, _ := annotationSnapshot(s.Store.DB, "doc")
			// A new analysis version must not make old notes impossible to edit.
			if err := saveMethodAnalysis(s.Store.DB, MethodAnalysis{DocumentID: "doc", Status: "complete", Content: "new Markdown"}); err != nil {
				t.Fatal(err)
			}
			path := "/api/documents/doc/annotations/" + saved.ID
			w := undoRequest(t, s, "method-client", "PATCH", path, map[string]any{"note": "改后的笔记", "color": "#5b9fe8", "tags": []string{"方法"}})
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var edited Annotation
			if err := json.Unmarshal(w.Body.Bytes(), &edited); err != nil || edited.Note != "改后的笔记" || string(edited.Location) != string(location) || edited.Quote != "法😀" {
				t.Fatalf("method edit lost its source: %+v %v", edited, err)
			}
			editedSnapshot, _ := annotationSnapshot(s.Store.DB, "doc")
			if w = undoRequest(t, s, "method-client", "DELETE", path, nil); w.Code != 204 {
				t.Fatal(w.Body.String())
			}
			undoLast(t, s, "method-client")
			restored, _ := annotationSnapshot(s.Store.DB, "doc")
			if !reflect.DeepEqual(restored, editedSnapshot) {
				t.Fatal("delete undo lost analysis version, quote, tags or edited note")
			}
			undoLast(t, s, "method-client")
			restored, _ = annotationSnapshot(s.Store.DB, "doc")
			if !reflect.DeepEqual(restored, original) {
				t.Fatal("edit undo lost the original method annotation")
			}
			list := request(t, s, "GET", "/api/documents/doc/annotations", nil)
			var items []Annotation
			if err := json.Unmarshal(list.Body.Bytes(), &items); err != nil || len(items) != 1 || string(items[0].Location) != string(location) {
				t.Fatalf("method location did not round-trip: %s %v", list.Body.String(), err)
			}
			undoLast(t, s, "method-client")
			restored, _ = annotationSnapshot(s.Store.DB, "doc")
			if len(restored) != 0 {
				t.Fatal("create undo left a method annotation")
			}
		})
	}
}

func TestMethodAnnotationsNeverMergeWithSourceOrOtherAnalysisVersions(t *testing.T) {
	for _, kind := range []string{"pdf", "epub"} {
		t.Run(kind, func(t *testing.T) {
			s := methodFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET type=? WHERE id='doc'", kind); err != nil {
				t.Fatal(err)
			}
			source := pdfUnderline("source", []annotationRect{{.1, .2, .3, .02}}, "法😀")
			if kind == "epub" {
				source = epubUnderline("source", 0, 3, "法😀")
			}
			if _, err := s.Store.saveAnnotation(source); err != nil {
				t.Fatal(err)
			}
			for _, content := range []string{"**法😀**", "new **法😀**"} {
				method := Annotation{Kind: "underline", DocumentID: "doc", Location: methodAnnotationLocation(content, 0, 3), Quote: "法😀", Color: "#e6b94c"}
				if _, merged := mergeUnderline(source, method); merged {
					t.Fatal("merged method analysis into original source")
				}
				if _, merged := mergeUnderline(method, source); merged {
					t.Fatal("merged original source into method analysis")
				}
				undoMark(t, s, "methods", method)
			}
			before, _ := annotationSnapshot(s.Store.DB, "doc")
			if len(before) != 3 {
				t.Fatalf("source/version annotations collapsed: %v", before)
			}
			if err := s.Store.compactUnderlines(); err != nil {
				t.Fatal(err)
			}
			after, _ := annotationSnapshot(s.Store.DB, "doc")
			if !reflect.DeepEqual(before, after) {
				t.Fatal("startup underline repair changed method annotations")
			}
		})
	}
}

func TestMethodAnnotationValidationDoesNotChangeReadingProgress(t *testing.T) {
	s := methodFixture(t)
	base := map[string]any{"type": "method-analysis", "contentHash": sourceKey("body"), "start": 0, "end": 3, "quote": "法😀"}
	for _, invalid := range []map[string]any{
		{"contentHash": "bad"}, {"contentHash": strings.Repeat("A", 64)}, {"start": nil}, {"end": nil},
		{"start": -1}, {"end": 0}, {"end": 1.5}, {"start": 3}, {"end": 9007199254740992.0}, {"quote": 1},
	} {
		location := map[string]any{}
		for key, value := range base {
			location[key] = value
		}
		for key, value := range invalid {
			location[key] = value
		}
		body := jsonText(map[string]any{"kind": "highlight", "location": location, "quote": "法😀"})
		w := request(t, s, "POST", "/api/documents/doc/annotations", strings.NewReader(body))
		if w.Code != 400 {
			t.Fatalf("invalid method location accepted %s: %d", jsonText(location), w.Code)
		}
	}
	for _, kind := range []string{"highlight", "underline", "note", "question", "bookmark"} {
		body := jsonText(map[string]any{"kind": kind, "location": base, "quote": "法😀"})
		if w := request(t, s, "POST", "/api/documents/doc/annotations", strings.NewReader(body)); w.Code != 201 {
			t.Fatalf("method %s rejected: %s", kind, w.Body.String())
		}
	}
	progress := jsonText(map[string]any{"progress": base, "percentage": .5})
	if w := request(t, s, "PATCH", "/api/documents/doc", strings.NewReader(progress)); w.Code != 400 {
		t.Fatal("method position was stored as PDF reading progress", w.Body.String())
	}
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	body := jsonText(map[string]any{"kind": "note", "location": base, "quote": "法😀"})
	if w := request(t, s, "POST", "/api/documents/doc/annotations", strings.NewReader(body)); w.Code != 400 {
		t.Fatal("method location accepted for unsupported library", w.Body.String())
	}
}

func TestMethodReferencesKeepAIProvenanceAcrossChatAndHistory(t *testing.T) {
	s := methodFixture(t)
	api, calls := fakeAPI(t, func(int, apiCall) string { return "应以原文核对该解读。" })
	methodAPIConfig(t, s, api.URL)
	location := methodAnnotationLocation("**法😀**", 0, 3)
	refs := json.RawMessage(jsonText([]chatReference{
		{Text: "法😀", Location: location, Kind: "selection"},
		{Text: "First page defines the problem.", Location: json.RawMessage(`{"type":"pdf","page":1}`), Kind: "section"},
	}))
	context := "旧客户端误标为论文原文：法😀\nFirst page defines the problem."
	send := func(text string, references json.RawMessage, full bool) {
		t.Helper()
		body := jsonText(map[string]any{"provider": "api", "prompt": "核对这个解释", "context": text, "references": references, "fullDocument": full})
		w := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(body))
		if w.Code != 200 || !strings.Contains(w.Body.String(), "event: done") {
			t.Fatalf("method reference chat: %d %s", w.Code, w.Body.String())
		}
	}
	send(context, refs, true)
	first := jsonText(calls()[0].Messages)
	for _, want := range []string{methodReferenceNotice, "method-analysis", sourceKey("**法😀**"), "法😀", "[第 1 页]", "[第 2 页]", "47 examples"} {
		if !strings.Contains(first, want) {
			t.Errorf("missing source provenance or original paper evidence %q", want)
		}
	}
	messages, err := s.Store.chatHistory("doc")
	if err != nil || len(messages) != 2 || messages[0].Context != context || string(messages[0].References) != string(refs) {
		t.Fatalf("method reference/context did not persist unchanged: %+v %v", messages, err)
	}
	// A later turn may have no active selection. Its restored history must
	// still distinguish generated interpretation from quoted original evidence.
	send("", nil, false)
	second := jsonText(calls()[1].Messages)
	if !strings.Contains(second, methodReferenceNotice) || !strings.Contains(second, sourceKey("**法😀**")) {
		t.Fatal("history promoted method analysis to original-paper evidence")
	}
	list := request(t, s, "GET", "/api/documents/doc/messages", nil)
	var restored []Message
	if err = json.Unmarshal(list.Body.Bytes(), &restored); err != nil || len(restored) != 4 || string(restored[0].References) != string(refs) {
		t.Fatalf("reference source/location did not round-trip: %s %v", list.Body.String(), err)
	}
	invalid := jsonText(map[string]any{"provider": "api", "prompt": "invalid", "context": "body", "references": []chatReference{{Text: "method", Location: json.RawMessage(`{"type":"method-analysis","contentHash":"bad","start":0,"end":3}`)}}})
	if w := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(invalid)); w.Code != 400 || len(calls()) != 2 {
		t.Fatal("invalid method reference reached the provider", w.Code)
	}
	// Legacy original-source references retain their previous acceptance rules.
	d, _ := s.Store.Document("doc")
	if !validMethodAnalysisReferences(json.RawMessage(`[{"text":"legacy","location":{"type":"pdf","page":0}}]`), d) {
		t.Fatal("method validation changed legacy source reference acceptance")
	}
}
