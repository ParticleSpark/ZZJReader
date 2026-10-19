package reader

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAutoCopySelectionPreference(t *testing.T) {
	s := testServer(t)
	for _, enabled := range []bool{true, false} {
		body, _ := json.Marshal(map[string]any{"autoCopySelection": enabled, "appearance": "dark"})
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(string(body)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		w = request(t, s, "GET", "/api/settings", nil)
		var saved map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil || saved["autoCopySelection"] != enabled || saved["appearance"] != "dark" {
			t.Fatalf("preference did not survive reload: %s", w.Body.String())
		}
	}
	for _, invalid := range []string{`"true"`, `1`, `null`} {
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"autoCopySelection":`+invalid+`}`))
		if w.Code != 400 {
			t.Fatalf("non-boolean preference accepted: %s", invalid)
		}
	}
	w := request(t, s, "GET", "/api/settings", nil)
	if !strings.Contains(w.Body.String(), `"autoCopySelection":false`) || !strings.Contains(w.Body.String(), `"appearance":"dark"`) {
		t.Fatalf("invalid settings replaced saved preferences: %s", w.Body.String())
	}
}

func TestChatFullDocumentPreference(t *testing.T) {
	s := testServer(t)
	for _, enabled := range []bool{true, false} {
		body, _ := json.Marshal(map[string]any{"chatFullDocument": enabled, "autoCopySelection": true})
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(string(body)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		w = request(t, s, "GET", "/api/settings", nil)
		var saved map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil || saved["chatFullDocument"] != enabled || saved["autoCopySelection"] != true {
			t.Fatalf("full document preference did not survive reload: %s", w.Body.String())
		}
	}
	for _, invalid := range []string{`"true"`, `1`, `null`} {
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"chatFullDocument":`+invalid+`}`))
		if w.Code != 400 {
			t.Fatalf("non-boolean preference accepted: %s", invalid)
		}
	}
	w := request(t, s, "GET", "/api/settings", nil)
	if !strings.Contains(w.Body.String(), `"chatFullDocument":false`) || !strings.Contains(w.Body.String(), `"autoCopySelection":true`) {
		t.Fatalf("invalid settings replaced saved preferences: %s", w.Body.String())
	}
}
