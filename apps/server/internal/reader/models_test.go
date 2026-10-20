package reader

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDecodeAgentModels(t *testing.T) {
	for _, test := range []struct{ provider, raw, id string }{
		{"codex", `{"data":[{"model":"hidden","hidden":true},{"model":"gpt-model","displayName":"GPT Model","isDefault":true}]}`, "gpt-model"},
		{"claude", `{"models":[{"value":"default","resolvedModel":"claude-test"},{"value":"sonnet","resolvedModel":"claude-test","displayName":"Sonnet"}]}`, "claude-test"},
		{"kimi", `{"configOptions":[{"id":"model","category":"model","currentValue":"kimi-test","options":[{"value":"kimi-test","name":"Kimi"}]}]}`, "kimi-test"},
		{"kimi", `{"models":{"currentModelId":"kimi-old","availableModels":[{"modelId":"kimi-old","name":"Kimi"}]}}`, "kimi-old"},
	} {
		t.Run(test.provider+test.id, func(t *testing.T) {
			models, err := decodeAgentModels(test.provider, json.RawMessage(test.raw))
			if err != nil || len(models) != 1 || models[0].ID != test.id || !models[0].Default {
				t.Fatalf("unexpected models: %+v, %v", models, err)
			}
			if test.provider == "claude" && models[0].Aliases[0] != "sonnet" {
				t.Fatal("lost configured alias")
			}
		})
	}
	if _, err := decodeAgentModels("kimi", json.RawMessage(`{}`)); err == nil {
		t.Fatal("empty catalog must report failure")
	}
}

func TestDiscoverModelsProtocol(t *testing.T) {
	// The fake CLI rejects generation requests and verifies its isolated cwd.
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			s := testServer(t)
			ready := fakeAgent(t, provider, "models")
			ctx, cancel := context.WithCancel(t.Context())
			type discoveryResult struct {
				models []AgentModel
				err    error
			}
			done := make(chan discoveryResult, 1)
			started := time.Now()
			go func() {
				models, err := discoverModels(ctx, s.Store.Root, provider)
				done <- discoveryResult{models, err}
				close(done)
			}()
			defer func() { cancel(); <-done }()
			// Keep the protocol's three-second response budget independent of
			// cold executable startup, which Windows can spend scanning a copy
			// of this test binary. This signal precedes the initialize response.
			var initialized time.Time
			var result discoveryResult
			completed := false
			for {
				if stamp, err := os.ReadFile(ready); err == nil {
					initialized, err = time.Parse(time.RFC3339Nano, string(stamp))
					if err != nil {
						t.Fatal("invalid CLI readiness timestamp", err)
					}
					break
				} else if !os.IsNotExist(err) {
					t.Fatal(err)
				}
				select {
				case result = <-done:
					completed = true
					// The child can publish readiness and finish between the
					// file check above and this receive. Recheck before failing.
					if _, err := os.Stat(ready); err != nil {
						t.Fatalf("CLI exited before initialize: %v", result.err)
					}
				default:
				}
				if time.Since(started) > 10*time.Second {
					t.Fatal("CLI did not initialize")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !completed {
				select {
				case result = <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("model protocol did not respond after initialize")
				}
			}
			if result.err != nil || len(result.models) != 1 || result.models[0].ID != "model-a" {
				t.Fatalf("models %+v: %v", result.models, result.err)
			}
			t.Logf("CLI initialization %s; protocol response %s", initialized.Sub(started), time.Since(initialized))
			files, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
			if err != nil || len(files) != 0 {
				t.Fatalf("discovery workdir leaked: %v", err)
			}
			response := request(t, s, "GET", "/api/ai/models?provider="+provider, nil)
			if response.Code != 200 || !strings.Contains(response.Body.String(), "model-a") {
				t.Fatalf("HTTP discovery failed: %s", response.Body)
			}
		})
	}
}

func TestModelDiscoveryRejectsUnknownProviderAndCancels(t *testing.T) {
	s := testServer(t)
	if r := request(t, s, "GET", "/api/ai/models?provider=invalid", nil); r.Code != 400 {
		t.Fatal(r.Code)
	}
	ready := fakeAgent(t, "codex", "models-wait")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := discoverModels(ctx, s.Store.Root, "codex")
		done <- err
	}()
	// Cancel an initialized process so this checks interruption of an actual
	// protocol read, independently of platform-specific executable startup.
	startupDeadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			t.Fatalf("discovery exited before cancellation: %v", err)
		default:
		}
		if time.Now().After(startupDeadline) {
			t.Fatal("CLI did not initialize")
		}
		time.Sleep(10 * time.Millisecond)
	}
	started := time.Now()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation was masked by a protocol/pipe error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("CLI did not stop after cancellation")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("CLI did not stop after cancellation")
	}
	files, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
	if err != nil || len(files) != 0 {
		t.Fatalf("discovery workdir leaked: %v", err)
	}
}
