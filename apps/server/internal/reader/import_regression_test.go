package reader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportPreservesUnregisteredOriginal(t *testing.T) {
	s := testServer(t)
	pdf := testPDF(2)
	doc := Document{ID: importRegressionDocumentID(pdf), Type: "pdf", Library: "books"}
	dest := s.Store.File(doc)
	existing := []byte("an unregistered original must not be overwritten")
	if err := os.WriteFile(dest, existing, 0600); err != nil {
		t.Fatal(err)
	}

	response := uploadTo(t, s, "books", "paper.pdf", pdf)
	if response.Code != 500 {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	got, err := os.ReadFile(dest)
	if err != nil || !bytes.Equal(got, existing) {
		t.Fatalf("existing original changed: %q, %v", got, err)
	}
	assertImportRegressionEmptyStore(t, s)
	assertNoImportRegressionTemps(t, s.Store.Root)
}

func TestImportSQLFailureRemovesFinalizedOriginal(t *testing.T) {
	s := testServer(t)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_import BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	pdf := testPDF(2)
	doc := Document{ID: importRegressionDocumentID(pdf), Type: "pdf", Library: "papers"}

	response := uploadTo(t, s, "papers", "paper.pdf", pdf)
	if response.Code != 500 || !strings.Contains(response.Body.String(), "书库保存失败") {
		t.Fatalf("expected database failure after finalizing the original: %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Lstat(s.Store.File(doc)); !os.IsNotExist(err) {
		t.Fatalf("finalized original survived rollback: %v", err)
	}
	assertImportRegressionEmptyStore(t, s)
	assertNoImportRegressionTemps(t, s.Store.Root)
}

func TestZoteroDuplicatePreservesSourceAndCleansTemps(t *testing.T) {
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	s := testServer(t)
	source, err := os.ReadFile(entry.path)
	if err != nil {
		t.Fatal(err)
	}
	var documentID string
	for _, status := range []string{"imported", "exists"} {
		result, err := s.importZoteroEntry(context.Background(), entry)
		if err != nil || result.Status != status {
			t.Fatalf("%s: %+v, %v", status, result, err)
		}
		if documentID != "" && result.DocumentID != documentID {
			t.Fatalf("duplicate created another document: %s != %s", result.DocumentID, documentID)
		}
		documentID = result.DocumentID
		got, err := os.ReadFile(entry.path)
		if err != nil || !bytes.Equal(got, source) {
			t.Fatalf("Zotero source changed after %s: %v", status, err)
		}
		assertNoImportRegressionTemps(t, s.Store.Root)
	}
	docs, err := s.Store.Documents()
	if err != nil || len(docs) != 1 || docs[0].ID != documentID {
		t.Fatalf("duplicate document: %+v, %v", docs, err)
	}
	got, err := os.ReadFile(s.Store.File(docs[0]))
	if err != nil || !bytes.Equal(got, source) {
		t.Fatalf("Reader original differs from Zotero source: %v", err)
	}
	var count int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM zotero_imports`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate migration record: %d, %v", count, err)
	}
}

func TestZoteroCommitFailureRemovesFinalizedOriginal(t *testing.T) {
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	s := testServer(t)
	source, err := os.ReadFile(entry.path)
	if err != nil {
		t.Fatal(err)
	}
	// This constraint is checked only at Commit, after the PDF has been saved.
	_, err = s.Store.DB.Exec(`
		CREATE TABLE import_commit_parent(id TEXT PRIMARY KEY);
		CREATE TABLE import_commit_failure(parent_id TEXT REFERENCES import_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
		CREATE TRIGGER reject_zotero_commit AFTER INSERT ON zotero_imports BEGIN
			INSERT INTO import_commit_failure(parent_id) VALUES('missing-parent');
		END;
	`)
	if err != nil {
		t.Fatal(err)
	}

	result, err := s.importZoteroEntry(context.Background(), entry)
	if err == nil || !strings.Contains(err.Error(), "FOREIGN KEY constraint failed") {
		t.Fatalf("expected deferred commit failure: %+v, %v", result, err)
	}
	doc := Document{ID: importRegressionDocumentID(source), Type: "pdf", Library: "papers"}
	if _, err := os.Lstat(s.Store.File(doc)); !os.IsNotExist(err) {
		t.Fatalf("finalized original survived failed commit: %v", err)
	}
	got, err := os.ReadFile(entry.path)
	if err != nil || !bytes.Equal(got, source) {
		t.Fatalf("Zotero source changed after failed commit: %v", err)
	}
	assertImportRegressionEmptyStore(t, s)
	assertNoImportRegressionTemps(t, s.Store.Root)
	for _, table := range []string{"zotero_imports", "zotero_note_imports", "annotations", "document_notes", "document_processing", "import_commit_failure"} {
		var count int
		if err := s.Store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s was not rolled back: %d, %v", table, count, err)
		}
	}
	if _, err := s.Store.DB.Exec(`DROP TRIGGER reject_zotero_commit`); err != nil {
		t.Fatal(err)
	}
	if result, err := s.importZoteroEntry(context.Background(), entry); err != nil || result.Status != "imported" {
		t.Fatalf("cannot retry after failed commit: %+v, %v", result, err)
	}
	assertNoImportRegressionTemps(t, s.Store.Root)
}

func importRegressionDocumentID(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])[:32]
}

func assertImportRegressionEmptyStore(t *testing.T, s *Server) {
	t.Helper()
	docs, err := s.Store.Documents()
	if err != nil || len(docs) != 0 {
		t.Fatalf("failed import left documents: %+v, %v", docs, err)
	}
}

func assertNoImportRegressionTemps(t *testing.T, root string) {
	t.Helper()
	for _, dir := range []string{root, filepath.Join(root, "books"), filepath.Join(root, "papers")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			for _, prefix := range []string{"import-", "zotero-", "connector-"} {
				if strings.HasPrefix(entry.Name(), prefix) {
					t.Errorf("import left temporary file: %s", filepath.Join(dir, entry.Name()))
				}
			}
		}
	}
}
