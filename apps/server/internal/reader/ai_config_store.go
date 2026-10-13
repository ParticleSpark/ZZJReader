package reader

import (
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Keep connection secrets outside the library database. A private SQLite file
// avoids filesystem rename failures while committing the complete config at once.
// Its separate connection also permits reads inside library transactions.
func openAIConfigDB(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	name := filepath.ToSlash(abs)
	if !strings.HasPrefix(name, "/") {
		name = "/" + name // SQLite file URI for a Windows drive letter.
	}
	u := url.URL{Scheme: "file", Path: name, RawQuery: "mode=rw"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	// EXTRA syncs the rollback journal and the committed database, including
	// journal deletion. No config file is copied over an existing config.
	_, err = db.Exec(`PRAGMA busy_timeout=5000;
 PRAGMA journal_mode=DELETE;
 PRAGMA synchronous=EXTRA;
 CREATE TABLE IF NOT EXISTS ai_config(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL);`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func readAIConfigBytes(root string) ([]byte, error) {
	path := filepath.Join(root, "ai-connections.sqlite")
	legacy := filepath.Join(root, "ai-connections.json")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return os.ReadFile(legacy)
	} else if err != nil {
		return nil, err
	}
	db, err := openAIConfigDB(path)
	if err != nil {
		return nil, err // Never hide a damaged database with stale JSON settings.
	}
	defer db.Close()
	var b []byte
	err = db.QueryRow("SELECT body FROM ai_config WHERE id=1").Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		var committed int
		if e := db.QueryRow("PRAGMA user_version").Scan(&committed); e != nil {
			return nil, e
		}
		// A failed first write may leave an initialized, empty database. The
		// legacy file remains usable until the first config commits. Once a
		// config has committed, a missing row is an error, never a migration.
		if committed == 0 {
			return os.ReadFile(legacy)
		}
	}
	return b, err
}

func writeAIConfigBytes(root string, b []byte) error {
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	path := filepath.Join(root, "ai-connections.sqlite")
	// Precreate before SQLite opens the database so secrets never enter a
	// newly created file with SQLite's default, broader Unix permissions.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		err = f.Chmod(0600)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	db, err := openAIConfigDB(path)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT INTO ai_config(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", b); err != nil {
		return err
	}
	if _, err = tx.Exec("PRAGMA user_version=1"); err != nil {
		return err
	}
	return tx.Commit()
}
