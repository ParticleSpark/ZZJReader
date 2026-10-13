package reader

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func legacyAIConfig(t *testing.T, root string) []byte {
	t.Helper()
	b, err := json.Marshal(savedConfig{Config: AIConfig{Primary: "codex", Models: map[string]string{"codex": "legacy-model"}, API: APIConnection{Key: "legacy-private-key"}}, Fingerprints: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ai-connections.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAIConfigLegacyMigration(t *testing.T) {
	s := testServer(t)
	legacy := legacyAIConfig(t, s.Store.Root)
	c := s.aiConfig()
	if c.Models["codex"] != "legacy-model" || c.API.Key != "legacy-private-key" {
		t.Fatal("legacy configuration was not loaded")
	}
	if _, err := os.Stat(filepath.Join(s.Store.Root, "ai-connections.sqlite")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy read unexpectedly created a database: %v", err)
	}
	c.Models["codex"] = "current-model"
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	reopened := NewServer(s.Store, "test", "")
	defer reopened.Close()
	if got := reopened.aiConfig(); got.Models["codex"] != "current-model" || got.API.Key != "legacy-private-key" {
		t.Fatal("committed configuration did not survive reopening")
	}
	unchanged, err := os.ReadFile(filepath.Join(s.Store.Root, "ai-connections.json"))
	if err != nil || !bytes.Equal(legacy, unchanged) {
		t.Fatal("legacy source was changed during migration", err)
	}
}

func TestAIConfigFailedWritePreservesCommittedConfig(t *testing.T) {
	root := t.TempDir()
	before := []byte(`{"config":{"primary":"codex"},"fingerprints":{}}`)
	if err := writeAIConfigBytes(root, before); err != nil {
		t.Fatal(err)
	}
	db, err := openAIConfigDB(filepath.Join(root, "ai-connections.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Fail after the row was updated, forcing the transaction to restore it.
	if _, err := db.Exec(`CREATE TRIGGER fail_config_write AFTER UPDATE ON ai_config BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := writeAIConfigBytes(root, []byte(`{"config":{"primary":"kimi"}}`)); err == nil {
		t.Fatal("failed transaction reported success")
	}
	after, err := readAIConfigBytes(root)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed transaction changed the committed configuration", err)
	}
	var integrity string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("database integrity=%q: %v", integrity, err)
	}
}

func TestAIConfigFailedInitialWriteKeepsLegacyReadable(t *testing.T) {
	root := t.TempDir()
	legacy := legacyAIConfig(t, root)
	path := filepath.Join(root, "ai-connections.sqlite")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := openAIConfigDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TRIGGER fail_config_write AFTER INSERT ON ai_config BEGIN SELECT RAISE(ABORT, 'injected initial failure'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := writeAIConfigBytes(root, []byte(`{"config":{"primary":"kimi"}}`)); err == nil {
		t.Fatal("failed initial transaction reported success")
	}
	after, err := readAIConfigBytes(root)
	if err != nil || !bytes.Equal(legacy, after) {
		t.Fatal("initial transaction failure hid the legacy configuration", err)
	}
	if _, err := db.Exec("DROP TRIGGER fail_config_write"); err != nil {
		t.Fatal(err)
	}
	if err := writeAIConfigBytes(root, []byte(`{"config":{"primary":"kimi"}}`)); err != nil {
		t.Fatal("retry after a failed initial write", err)
	}
}

func TestAIConfigCorruptionDoesNotRestoreStaleLegacy(t *testing.T) {
	for _, damage := range []string{"database", "json", "missing-row", "schema"} {
		t.Run(damage, func(t *testing.T) {
			s := testServer(t)
			legacyAIConfig(t, s.Store.Root)
			path := filepath.Join(s.Store.Root, "ai-connections.sqlite")
			if damage == "database" {
				broken := []byte("invalid sqlite database")
				if err := os.WriteFile(path, broken, 0600); err != nil {
					t.Fatal(err)
				}
				if err := writeAIConfigBytes(s.Store.Root, []byte(`{"config":{}}`)); err == nil {
					t.Fatal("damaged database accepted a write")
				}
				unchanged, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(broken, unchanged) {
					t.Fatal("failed write modified the damaged database", err)
				}
			} else {
				if err := writeAIConfigBytes(s.Store.Root, []byte("invalid json")); err != nil {
					t.Fatal(err)
				}
				if damage == "missing-row" || damage == "schema" {
					db, err := openAIConfigDB(path)
					if err != nil {
						t.Fatal(err)
					}
					query := "DELETE FROM ai_config"
					if damage == "schema" {
						query = "ALTER TABLE ai_config RENAME COLUMN body TO broken"
					}
					_, err = db.Exec(query)
					_ = db.Close()
					if err != nil {
						t.Fatal(err)
					}
					if _, err := readAIConfigBytes(s.Store.Root); err == nil || (damage == "missing-row" && !errors.Is(err, sql.ErrNoRows)) {
						t.Fatalf("committed missing row did not report a read failure: %v", err)
					}
				}
			}
			if got := s.aiConfig(); got.Primary != "" || got.API.Key != "" || len(got.Models) != 0 {
				t.Fatal("damaged configuration restored stale legacy values")
			}
		})
	}
}

func TestAIConfigPrivateDatabase(t *testing.T) {
	// URI metacharacters and spaces must remain part of the library path.
	root := filepath.Join(t.TempDir(), "private config # % 汉字", "new")
	data := []byte(`{"config":{"primary":"codex"}}`)
	if err := writeAIConfigBytes(root, data); err != nil {
		t.Fatal(err)
	}
	got, err := readAIConfigBytes(root)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("configuration path was not preserved", err)
	}
	path := filepath.Join(root, "ai-connections.sqlite")
	info, err := os.Stat(path)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("private database permissions", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if err := writeAIConfigBytes(root, data); err != nil {
			t.Fatal(err)
		}
		info, err = os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("existing database permissions were not restricted", err)
		}
		db, err := openAIConfigDB(path)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.Exec("UPDATE ai_config SET body=? WHERE id=1", []byte("journal-permission-test")); err != nil {
			t.Fatal(err)
		}
		info, err = os.Stat(path + "-journal")
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("private rollback journal permissions", err)
		}
	}
}

func TestAIConfigIndependentOfLibraryTransaction(t *testing.T) {
	s := testServer(t)
	tx, err := s.Store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	finished := make(chan error, 1)
	go func() {
		if err := s.writeAIConfig(AIConfig{Primary: "codex"}); err != nil {
			finished <- err
			return
		}
		if s.aiConfig().Primary != "codex" {
			finished <- errors.New("configuration read failed during library transaction")
			return
		}
		finished <- nil
	}()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		_ = tx.Rollback()
		<-finished
		t.Fatal("AI configuration depended on the occupied library connection")
	}
}
