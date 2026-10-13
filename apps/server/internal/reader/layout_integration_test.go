package reader

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt in with a built processor and READER_NODE/READER_PROCESSOR. A custom
// parent can exercise the library's real filesystem without touching its data.
func TestLayoutProcessorPublication(t *testing.T) {
	if os.Getenv("READER_TEST_PROCESSOR") != "1" {
		t.Skip("set READER_TEST_PROCESSOR=1 to run the built PDF processor")
	}
	root, err := os.MkdirTemp(os.Getenv("READER_TEST_LAYOUT_ROOT"), "reader-layout-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.DB.Close() })
	s := NewServer(store, "test-secret", "")
	t.Cleanup(s.Close)
	w := uploadTo(t, s, "papers", "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	if w.Code != 201 {
		t.Fatalf("import failed: %d %s", w.Code, w.Body.String())
	}
	var doc Document
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	p, err := store.processing(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.Enabled = true
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := s.learnPDF(ctx, &p); err != nil {
		t.Fatal(err)
	}
	m, err := s.readLayout(doc.ID)
	if err != nil || m.Pages < 1 || len(m.Blocks) == 0 {
		t.Fatalf("published layout missing: pages=%d blocks=%d error=%v", m.Pages, len(m.Blocks), err)
	}
	if p.Phase != "translating" || p.Status != "queued" {
		t.Fatalf("translation was not queued: %+v", p)
	}
	for _, b := range m.Blocks {
		if b.Image != "" && !regularLayoutFile(filepath.Join(s.analysisDir(doc.ID), b.Image)) {
			t.Fatalf("published asset missing: %s", b.Image)
		}
	}
	t.Logf("published %d pages and %d blocks; translation queued", m.Pages, len(m.Blocks))
}
