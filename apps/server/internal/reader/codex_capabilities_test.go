package reader

import (
	"encoding/json"
	"os"
	"testing"
)

// Opt-in end-to-end check of the settings endpoints, model selection and saved
// results. Only a fixed prompt and generated color chart are sent to the CLI.
func TestLiveCodexCapabilities(t *testing.T) {
	if os.Getenv("READER_TEST_CODEX") != "1" {
		t.Skip("set READER_TEST_CODEX=1 to use local subscription")
	}
	s := testServer(t)
	for _, stage := range []string{"text", "vision"} {
		w := request(t, s, "POST", "/api/ai/test/codex?capability="+stage, nil)
		var cap Capability
		if err := json.Unmarshal(w.Body.Bytes(), &cap); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || !cap.Text || stage == "vision" && !cap.Vision || cap.Error != "" {
			t.Fatalf("%s: status=%d text=%t vision=%t error=%q", stage, w.Code, cap.Text, cap.Vision, cap.Error)
		}
		saved := s.aiConfig().Capabilities["codex"]
		if saved.Text != cap.Text || saved.Vision != cap.Vision || saved.CheckedAt != cap.CheckedAt {
			t.Fatalf("%s result not persisted", stage)
		}
		t.Logf("%s capability passed and persisted", stage)
	}
}
