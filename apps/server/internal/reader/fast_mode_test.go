package reader

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestCodexFastRejectionPreservesStandardCapabilities(t *testing.T) {
	s := testServer(t)
	enabled := true
	c := AIConfig{Primary: "codex", Models: map[string]string{"codex": "model"}, CodexFastMode: &enabled, Capabilities: map[string]Capability{}}
	c.Capabilities["codex"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(c, "codex"), CheckedAt: now()}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	g := s.generationService(c)
	connection := g.connections["codex"]
	connection.Adapter = adapterFunc(func(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error) {
		return GenerateResult{}, generationError(ErrorCapability, "fast service tier unavailable")
	})
	g.connections["codex"] = connection
	_, err := g.Generate(t.Context(), AIInput{Chat: &chatInput{}, Prompt: "question"}, true, nil)
	if err == nil || !strings.Contains(err.Error(), "关闭快速模式") {
		t.Fatalf("%v", err)
	}
	if cap := s.aiConfig().Capabilities["codex"]; !cap.Text || !cap.Vision {
		t.Fatalf("standard capabilities were lost: %+v", cap)
	}
	// A standard/background request still follows the existing failure policy.
	_, _ = g.Generate(t.Context(), AIInput{Prompt: "background"}, false, nil)
	if cap := s.aiConfig().Capabilities["codex"]; cap.Text || cap.Vision {
		t.Fatalf("standard failure was ignored: %+v", cap)
	}
}

func TestCodexFastModePersistsWithoutChangingModelsOrEffort(t *testing.T) {
	s := testServer(t)
	enabled := true
	c := AIConfig{Primary: "codex", Models: map[string]string{"codex": "model"}, Efforts: map[string]map[string]string{"codex": {"model": "high"}}, CodexFastMode: &enabled}
	for _, value := range []*bool{&enabled, nil} {
		c.CodexFastMode = value
		if r := request(t, s, "PUT", "/api/ai/config", configJSON(c)); r.Code != 200 {
			t.Fatal(r.Body)
		}
		got := s.aiConfig()
		if got.CodexFastMode == nil || !*got.CodexFastMode || got.Models["codex"] != "model" || got.Efforts["codex"]["model"] != "high" {
			t.Fatalf("saved configuration changed: %+v", got)
		}
	}
	disabled := false
	c.CodexFastMode = &disabled
	if r := request(t, s, "PUT", "/api/ai/config", configJSON(c)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	if got := s.aiConfig().CodexFastMode; got == nil || *got {
		t.Fatal("explicitly disabling fast mode was not saved")
	}
}

func TestCodexFastModeReachesChatAndResetsCachedSession(t *testing.T) {
	s, capture := chatFixture(t)
	c := s.aiConfig()
	c.Efforts = map[string]map[string]string{"codex": {"test-model": "high"}}
	for i, enabled := range []bool{true, true, false, false} {
		c.CodexFastMode = &enabled
		if err := s.writeAIConfig(c); err != nil {
			t.Fatal(err)
		}
		if body := sendChat(t, s, "doc", "explain", "source"); !strings.Contains(body, "event: done") || strings.Contains(body, "event: error") {
			t.Fatalf("turn %d: %s", i, body)
		}
	}
	pids, _ := capturedTurns(t, capture)
	if len(pids) != 4 || pids[0] != pids[1] || pids[1] == pids[2] || pids[2] != pids[3] {
		t.Fatalf("fast toggle did not isolate provider sessions: %v", pids)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	turn := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var req struct {
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			t.Fatal(err)
		}
		if req.Method != "turn/start" {
			continue
		}
		value, present := req.Params["serviceTier"]
		if !present || (turn < 2 && value != "fast") || (turn >= 2 && value != nil) {
			t.Fatalf("turn %d: serviceTier = %v (present %v)", turn, value, present)
		}
		turn++
	}
}

func TestCodexFastModeDoesNotAffectNonChatTasks(t *testing.T) {
	s, capture := chatFixture(t)
	c := s.aiConfig()
	enabled := true
	c.CodexFastMode = &enabled
	for _, task := range []modelTask{taskChat, taskTranslation} {
		service := s.taskGenerationService(c, task)
		if _, err := service.connections["codex"].Adapter.Stream(t.Context(), GenerateRequest{Input: AIInput{Prompt: "background task"}}, nil); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var req struct {
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			t.Fatal(err)
		}
		if req.Method == "turn/start" {
			if _, present := req.Params["serviceTier"]; present {
				t.Fatalf("background task must inherit CLI service tier: %s", line)
			}
		}
	}
}
