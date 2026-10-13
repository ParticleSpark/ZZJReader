package reader

import (
	"encoding/json"
	"strings"
	"testing"
)

const (
	codexUpgradeHint    = "Codex CLI 版本过旧，当前模型需要更新版本；请更新 Codex 后重试"
	codexGenericHint    = "Codex 未完成回答，请检查登录、网络、模型或额度"
	codexVersionMessage = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
)

func TestCodexProviderError(t *testing.T) {
	messageJSON := func(message string) json.RawMessage {
		b, err := json.Marshal(map[string]any{"code": -32603, "message": message})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	envelope, err := json.Marshal(map[string]any{"error": map[string]string{"message": codexVersionMessage, "code": "invalid_request_error"}})
	if err != nil {
		t.Fatal(err)
	}
	unrelatedEnvelope, err := json.Marshal(map[string]any{"error": map[string]string{"message": "request failed"}, "debug": codexVersionMessage})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		raw     json.RawMessage
		upgrade bool
	}{
		{"plain", messageJSON(codexVersionMessage), true},
		{"json upstream response", messageJSON(string(envelope)), true},
		{"wrapped upstream response", messageJSON("unexpected status 400 Bad Request: " + string(envelope)), true},
		{"unrelated envelope field", messageJSON(string(unrelatedEnvelope)), false},
		{"unknown private message", messageJSON("private-token document-text https://private.invalid/request failed"), false},
		{"unrelated upgrade", messageJSON("The PDF converter requires a newer version of another application."), false},
		{"message type mismatch", json.RawMessage(`{"message":{"text":"requires a newer version of Codex"}}`), false},
		{"untrusted data field", json.RawMessage(`{"message":"request failed","data":{"message":"requires a newer version of Codex"}}`), false},
		{"malformed", json.RawMessage(`{"message":`), false},
		{"missing", nil, false},
		{"null", json.RawMessage(`null`), false},
		{"no message", json.RawMessage(`{"code":400}`), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := codexProviderError(tc.raw)
			wantMessage, wantKind := codexGenericHint, ErrorUpstream
			if tc.upgrade {
				wantMessage, wantKind = codexUpgradeHint, ErrorConfiguration
			}
			if err == nil || err.Error() != wantMessage || errorKind(err) != wantKind {
				t.Fatalf("error=%v kind=%q; want %q kind=%q", err, errorKind(err), wantMessage, wantKind)
			}
		})
	}
}

func TestCodexProtocolProviderErrors(t *testing.T) {
	for _, mode := range []string{"rpc-initialize", "rpc-thread/start", "rpc-turn/start", "notification", "completed"} {
		for _, upgrade := range []bool{true, false} {
			name := mode + "/unknown"
			if upgrade {
				name = mode + "/upgrade"
			}
			t.Run(name, func(t *testing.T) {
				fakeAgent(t, "codex", "codex-error-"+mode)
				message := "private-token document-text https://private.invalid/request failed"
				if upgrade {
					message = codexVersionMessage
				}
				payload, err := json.Marshal(map[string]any{"code": -32603, "message": message})
				if err != nil {
					t.Fatal(err)
				}
				t.Setenv("READER_CODEX_ERROR", string(payload))
				s := testServer(t)
				var chunks strings.Builder
				answer, err := invokeCLI(t.Context(), s.Store.Root, "codex", "selected-model", AIInput{Prompt: "test"}, func(part string) { chunks.WriteString(part) })
				wantMessage, wantKind := codexGenericHint, ErrorUpstream
				if upgrade {
					wantMessage, wantKind = codexUpgradeHint, ErrorConfiguration
				}
				if answer != "" || chunks.Len() != 0 || err == nil || err.Error() != wantMessage || errorKind(err) != wantKind {
					t.Fatalf("answer=%q chunks=%q error=%v kind=%q; want %q kind=%q", answer, chunks.String(), err, errorKind(err), wantMessage, wantKind)
				}
			})
		}
	}
}

func TestCodexNonTerminalProviderErrors(t *testing.T) {
	for _, mode := range []string{"retry", "other-thread", "other-turn"} {
		t.Run(mode, func(t *testing.T) {
			fakeAgent(t, "codex", "codex-error-"+mode)
			payload, err := json.Marshal(map[string]string{"message": codexVersionMessage})
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("READER_CODEX_ERROR", string(payload))
			s := testServer(t)
			var chunks strings.Builder
			answer, err := invokeCLI(t.Context(), s.Store.Root, "codex", "selected-model", AIInput{Prompt: "test"}, func(part string) { chunks.WriteString(part) })
			if err != nil || answer != "你好，世界" || chunks.String() != answer {
				t.Fatalf("answer=%q chunks=%q error=%v", answer, chunks.String(), err)
			}
		})
	}
}
