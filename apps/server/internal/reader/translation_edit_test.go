package reader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func translationEditBody(block TranslationBlock, index int, target string) *strings.Reader {
	data, _ := json.Marshal(map[string]any{
		"index": index, "target": target, "sourceHash": block.SourceHash,
		"source": block.Sentences[index].Source, "expectedTarget": block.Sentences[index].Target,
	})
	return strings.NewReader(string(data))
}

func savedEditableBlock(t *testing.T, s *Server, block PDFBlock) TranslationBlock {
	t.Helper()
	saved := completeTranslation(block, []TranslationSentence{
		{Source: "First sentence.", Target: "第一句。"},
		{Source: "Second sentence.", Target: "第二句。"},
	})
	if err := s.saveTranslation("doc", saved); err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestTranslationEditsRejectStaleSentenceAndSource(t *testing.T) {
	s, _, m := translationFixture(t)
	saved := savedEditableBlock(t, s, m.Blocks[0])
	path := "/api/documents/doc/translations/" + saved.BlockID
	if got := request(t, s, "PUT", path, translationEditBody(saved, 0, "改过的第一句。")); got.Code != 200 {
		t.Fatal(got.Body.String())
	}
	if got := request(t, s, "PUT", path, translationEditBody(saved, 0, "过期的第一句。")); got.Code != 409 {
		t.Fatalf("stale editor overwrote saved text: %d %s", got.Code, got.Body.String())
	}
	// A stale block snapshot may still edit a different, unchanged sentence.
	if got := request(t, s, "PUT", path, translationEditBody(saved, 1, "改过的第二句。")); got.Code != 200 {
		t.Fatal(got.Body.String())
	}
	items, _ := s.translations("doc", m)
	if items[0].Sentences[0].Target != "改过的第一句。" || items[0].Sentences[1].Target != "改过的第二句。" {
		t.Fatalf("lost another sentence's edit: %+v", items[0])
	}
	// A replacement may segment the same source differently without changing
	// its sourceHash. The old sentence index must not target that new sentence.
	replaced := completeTranslation(m.Blocks[0], []TranslationSentence{{Source: m.Blocks[0].Text, Target: "第一句。"}})
	if err := s.saveTranslation("doc", replaced); err != nil {
		t.Fatal(err)
	}
	if got := request(t, s, "PUT", path, translationEditBody(saved, 0, "错位修改")); got.Code != 409 {
		t.Fatalf("edited resegmented source: %d %s", got.Code, got.Body.String())
	}
	wrongHash := replaced
	wrongHash.SourceHash = "outdated-source"
	if got := request(t, s, "PUT", path, translationEditBody(wrongHash, 0, "错误版本")); got.Code != 409 {
		t.Fatalf("edited different source version: %d %s", got.Code, got.Body.String())
	}
}

func TestConcurrentTranslationEditsPreserveOneWinner(t *testing.T) {
	s, _, m := translationFixture(t)
	saved := savedEditableBlock(t, s, m.Blocks[0])
	start := make(chan struct{})
	results := make(chan int, 12)
	var requests sync.WaitGroup
	for range cap(results) {
		requests.Add(1)
		go func() {
			defer requests.Done()
			<-start
			response := request(t, s, "PUT", "/api/documents/doc/translations/"+saved.BlockID, translationEditBody(saved, 0, "并发修改"))
			results <- response.Code
		}()
	}
	close(start)
	requests.Wait()
	close(results)
	winners := 0
	for code := range results {
		if code == 200 {
			winners++
		} else if code != 409 {
			t.Fatalf("unexpected response: %d", code)
		}
	}
	if winners != 1 {
		t.Fatalf("expected one compare-and-save winner, got %d", winners)
	}
}

func TestForceTranslationJoinsOldWorkerBeforeReset(t *testing.T) {
	s, p, m := translationFixture(t)
	savedEditableBlock(t, s, m.Blocks[0])
	p.Status, p.Phase = "running", "translating"
	p.Translating = &ProcessingStage{Status: "running", Detail: "old request"}
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	s.activeProcessing = map[string]*documentTask{"doc": task}
	chat, finishChat, err := s.beginDocumentTask(context.Background(), "doc")
	if err != nil {
		t.Fatal(err)
	}
	defer finishChat()
	go func() {
		<-ctx.Done()
		// A provider can publish its final completion while cancellation joins.
		_ = s.saveTranslation("doc", completeTranslation(m.Blocks[1], []TranslationSentence{{Source: m.Blocks[1].Text, Target: "旧模型的结果"}}))
		p.Translating = &ProcessingStage{Status: "complete"}
		aggregateProcessing(&p)
		_ = s.Store.saveProcessing(p)
		s.finishProcessingTask("doc", task)
	}()
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	if ctx.Err() == nil || chat.Err() != nil {
		t.Fatal("replacement did not cancel only processing")
	}
	items, _ := s.translations("doc", m)
	for _, item := range items {
		if item.Status != "pending" || len(item.Sentences) != 0 {
			t.Fatalf("old worker overwrote replacement: %+v", item)
		}
	}
	latest, _ := s.Store.processing("doc")
	if latest.Status != "queued" || latest.Translating.Status != "queued" {
		t.Fatalf("old worker lost queue request: %+v", latest)
	}
}

func TestForceTranslationRollsBackResetAndQueueTogether(t *testing.T) {
	for _, failure := range []string{"second block", "queue"} {
		t.Run(failure, func(t *testing.T) {
			s, _, m := translationFixture(t)
			saved := savedEditableBlock(t, s, m.Blocks[0])
			if err := s.saveTranslation("doc", completeTranslation(m.Blocks[1], []TranslationSentence{{Source: m.Blocks[1].Text, Target: "保留第二段"}})); err != nil {
				t.Fatal(err)
			}
			trigger := "CREATE TRIGGER reject_reset BEFORE UPDATE ON translations WHEN NEW.block_id='p1-b2' BEGIN SELECT RAISE(FAIL, 'test save failure'); END"
			if failure == "queue" {
				trigger = "CREATE TRIGGER reject_queue BEFORE UPDATE ON document_processing BEGIN SELECT RAISE(FAIL, 'test queue failure'); END"
			}
			if _, err := s.Store.DB.Exec(trigger); err != nil {
				t.Fatal(err)
			}
			updates := make(chan TranslationBlock, 4)
			s.translationSubscribers = map[string]map[chan TranslationBlock]struct{}{"doc": {updates: {}}}
			before, _ := s.Store.processing("doc")
			response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true}`))
			if response.Code != 500 {
				t.Fatalf("save failure not surfaced: %d %s", response.Code, response.Body.String())
			}
			items, _ := s.translations("doc", m)
			if items[0].Status != "complete" || items[0].Sentences[0].Target != saved.Sentences[0].Target || items[1].Status != "complete" {
				t.Fatalf("failed replacement cleared saved text: %+v", items)
			}
			after, _ := s.Store.processing("doc")
			if before.UpdatedAt != after.UpdatedAt || len(updates) != 0 {
				t.Fatal("failed transaction published queue state or SSE changes")
			}
		})
	}
}

func TestForceBookTranslationKeepsUnrequestedParagraphsIdle(t *testing.T) {
	s, _, m := translationFixture(t)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	savedEditableBlock(t, s, m.Blocks[0])
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	items, _ := s.translations("doc", m)
	if items[0].Status != "pending" || items[1].Status != "idle" {
		t.Fatalf("replacement expanded the requested book scope: %+v", items)
	}
}

func TestForceTranslationPreservesPendingBookChapterParsing(t *testing.T) {
	s, p, m := translationFixture(t)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	savedEditableBlock(t, s, m.Blocks[0])
	p.Phase, p.Status = "learning", "running"
	p.Chapter = &PageRange{From: 3, To: 4}
	p.Translating = nil
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	worker, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	task := &documentTask{cancel: cancelWorker, done: make(chan struct{})}
	s.activeProcessing = map[string]*documentTask{"doc": task}
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"force":true}`))
	if response.Code != 409 || worker.Err() != nil {
		t.Fatalf("replacement interrupted pending chapter parsing: %d %v", response.Code, worker.Err())
	}
	latest, err := s.Store.processing("doc")
	if err != nil || latest.Phase != "learning" || latest.Status != "running" || latest.Chapter == nil || *latest.Chapter != *p.Chapter {
		t.Fatalf("chapter request was lost: %+v %v", latest, err)
	}
	items, _ := s.translations("doc", m)
	if items[0].Status != "complete" {
		t.Fatal("rejected replacement reset the existing chapter's translation")
	}
	s.finishProcessingTask("doc", task)
}

func TestForceEPUBTranslationKeepsUnrequestedChaptersIdle(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var doc Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &doc) != nil {
		t.Fatal(response.Body.String())
	}
	source, err := s.readTranslationSource(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.translations(doc.ID, source)
	if err != nil || len(items) < 2 {
		t.Fatalf("need at least two EPUB paragraphs: %v", err)
	}
	// Importing an EPUB authorizes no chapter, even though all spine text is
	// already available locally.
	path := "/api/documents/" + doc.ID + "/translations"
	if response := request(t, s, "POST", path, strings.NewReader(`{"force":true}`)); response.Code != 404 {
		t.Fatalf("unrequested book became translatable in full: %d", response.Code)
	}
	first := items[0]
	first.Status = "complete"
	first.Sentences = []TranslationSentence{{Source: source.translationParagraphs()[0].Source, Target: "已经请求过的译文"}}
	if err := s.saveTranslation(doc.ID, first); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "POST", path, strings.NewReader(`{"force":true}`))
	if response.Code != 202 {
		t.Fatal(response.Body.String())
	}
	items, err = s.translations(doc.ID, source)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		want := "idle"
		if item.BlockID == first.BlockID {
			want = "pending"
		}
		if item.Status != want {
			t.Fatalf("replacement expanded EPUB chapter scope: %s=%s, want %s", item.BlockID, item.Status, want)
		}
	}
}

func TestForceTranslationCancellationKeepsSavedText(t *testing.T) {
	s, _, m := translationFixture(t)
	savedEditableBlock(t, s, m.Blocks[0])
	worker, cancelWorker := context.WithCancel(context.Background())
	defer cancelWorker()
	task := &documentTask{cancel: cancelWorker, done: make(chan struct{})}
	s.activeProcessing = map[string]*documentTask{"doc": task}
	ctx, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:17840/api/documents/doc/translations", strings.NewReader(`{"force":true}`))
		req.Header.Set("Authorization", "Bearer "+s.Token)
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, req)
		done <- response
	}()
	select {
	case <-worker.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("worker cancellation was not requested")
	}
	cancelRequest()
	select {
	case response := <-done:
		if response.Code != 408 {
			t.Fatalf("unexpected canceled response: %d", response.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled replacement kept waiting")
	}
	s.finishProcessingTask("doc", task)
	items, _ := s.translations("doc", m)
	if items[0].Status != "complete" || len(items[0].Sentences) != 2 {
		t.Fatal("canceled replacement cleared saved text")
	}
}
