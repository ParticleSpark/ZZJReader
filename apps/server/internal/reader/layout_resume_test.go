package reader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resumeFixture(t *testing.T) (source, work string, manifest map[string]any) {
	t.Helper()
	root := t.TempDir()
	source, work = filepath.Join(root, "source.pdf"), filepath.Join(root, "analysis-work")
	input := []byte("synthetic source bytes")
	hash := sha256.Sum256(input)
	if err := os.MkdirAll(filepath.Join(work, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	for path, data := range map[string][]byte{
		source:                          input,
		filepath.Join(work, "paper.md"): []byte("# Parsed text\n"),
		filepath.Join(work, "assets", "p1-b1.png"): []byte("synthetic asset"),
	} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	block := PDFBlock{ID: "p1-b1", Page: 1, Label: "image", Image: "assets/p1-b1.png"}
	block.Bounds.Width, block.Bounds.Height = .5, .5
	manifest = map[string]any{
		"schemaVersion": 1, "textExtractionVersion": 2,
		"inputSHA256": hex.EncodeToString(hash[:]),
		"pages":       2, "blocks": []PDFBlock{block},
		"warnings": []string{}, "incompletePages": []int{},
	}
	return source, work, manifest
}

func writeResumeManifest(t *testing.T, work, name string, manifest map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, name), data, 0600); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestResumeCompletedLayout(t *testing.T) {
	for _, name := range []string{"manifest.json.part", "manifest.json"} {
		t.Run(name, func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			want := writeResumeManifest(t, work, name, manifest)
			ok, err := resumeCompletedLayout(context.Background(), source, work, 0, 0)
			if err != nil || !ok {
				t.Fatalf("resume = %v, %v", ok, err)
			}
			got, err := os.ReadFile(filepath.Join(work, "manifest.json"))
			if err != nil || string(got) != string(want) {
				t.Fatalf("manifest changed: %q, %v", got, err)
			}
			if _, err := os.Stat(filepath.Join(work, "manifest.json.part")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("private part remains: %v", err)
			}
			if _, err := os.Stat(source); err != nil {
				t.Fatalf("source removed: %v", err)
			}
		})
	}
}

func TestResumeCompletedLayoutRejectsInvalidCache(t *testing.T) {
	cases := []struct {
		name   string
		change func(*testing.T, string, string, map[string]any)
	}{
		{"old schema", func(_ *testing.T, _, _ string, m map[string]any) { m["schemaVersion"] = 0 }},
		{"old text extraction", func(_ *testing.T, _, _ string, m map[string]any) { m["textExtractionVersion"] = 1 }},
		{"missing blocks", func(_ *testing.T, _, _ string, m map[string]any) { delete(m, "blocks") }},
		{"null blocks", func(_ *testing.T, _, _ string, m map[string]any) { m["blocks"] = nil }},
		{"wrong hash", func(_ *testing.T, _, _ string, m map[string]any) { m["inputSHA256"] = "different" }},
		{"partial pages", func(_ *testing.T, _, _ string, m map[string]any) { m["parsedPages"] = []int{1} }},
		{"invalid pages", func(_ *testing.T, _, _ string, m map[string]any) { m["pages"] = 0 }},
		{"invalid bounds", func(_ *testing.T, _, _ string, m map[string]any) { m["blocks"].([]PDFBlock)[0].Bounds.Width = 2 }},
		{"asset escape", func(_ *testing.T, _, _ string, m map[string]any) {
			m["blocks"].([]PDFBlock)[0].Image = "../outside.png"
		}},
		{"duplicate blocks", func(_ *testing.T, _, _ string, m map[string]any) {
			blocks := m["blocks"].([]PDFBlock)
			m["blocks"] = append(blocks, blocks[0])
		}},
		{"missing paper", func(t *testing.T, _, work string, _ map[string]any) {
			if err := os.Remove(filepath.Join(work, "paper.md")); err != nil {
				t.Fatal(err)
			}
		}},
		{"missing asset", func(t *testing.T, _, work string, _ map[string]any) {
			if err := os.Remove(filepath.Join(work, "assets", "p1-b1.png")); err != nil {
				t.Fatal(err)
			}
		}},
		{"source changed", func(t *testing.T, source, _ string, _ map[string]any) {
			if err := os.WriteFile(source, []byte("changed source"), 0600); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			tc.change(t, source, work, manifest)
			want := writeResumeManifest(t, work, "manifest.json.part", manifest)
			ok, err := resumeCompletedLayout(context.Background(), source, work, 0, 0)
			if err != nil || ok {
				t.Fatalf("resume invalid cache = %v, %v", ok, err)
			}
			got, err := os.ReadFile(filepath.Join(work, "manifest.json.part"))
			if err != nil || string(got) != string(want) {
				t.Fatalf("rejected cache changed: %v", err)
			}
		})
	}
}

func TestResumeCompletedLayoutRequiresExactPageRange(t *testing.T) {
	for _, tc := range []struct {
		name     string
		pages    []int
		from, to int
		want     bool
	}{
		{"matching range", []int{1, 2}, 1, 2, true},
		{"clipped range", []int{1, 2}, 1, 3, true},
		{"missing page", []int{1}, 1, 2, false},
		{"out of order", []int{2, 1}, 1, 2, false},
		{"duplicate page", []int{1, 1}, 1, 2, false},
		{"whole cache for range", nil, 1, 2, false},
		{"range cache for whole", []int{1, 2}, 0, 0, false},
		{"block outside range", []int{2}, 2, 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			if tc.pages != nil {
				manifest["parsedPages"] = tc.pages
			}
			writeResumeManifest(t, work, "manifest.json.part", manifest)
			ok, err := resumeCompletedLayout(context.Background(), source, work, tc.from, tc.to)
			if err != nil || ok != tc.want {
				t.Fatalf("resume = %v, %v; want %v", ok, err, tc.want)
			}
		})
	}
}

func TestResumeCompletedLayoutPreservesCacheOnCancellationAndSourceError(t *testing.T) {
	for _, canceled := range []bool{true, false} {
		t.Run(map[bool]string{true: "canceled", false: "missing source"}[canceled], func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			want := writeResumeManifest(t, work, "manifest.json.part", manifest)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if canceled {
				cancel()
			} else if err := os.Remove(source); err != nil {
				t.Fatal(err)
			}
			ok, err := resumeCompletedLayout(ctx, source, work, 0, 0)
			if err == nil || ok {
				t.Fatalf("resume = %v, %v", ok, err)
			}
			if canceled && !errors.Is(err, context.Canceled) {
				t.Fatalf("wrong cancellation: %v", err)
			}
			got, readErr := os.ReadFile(filepath.Join(work, "manifest.json.part"))
			if readErr != nil || string(got) != string(want) {
				t.Fatalf("cache lost: %v", readErr)
			}
		})
	}
}

func TestResumeCompletedLayoutReportsCacheIOErrors(t *testing.T) {
	source, work, _ := resumeFixture(t)
	// A path component beyond the filesystem limit is an I/O error, not a
	// missing cache that runLayout may discard and recreate.
	invalid := filepath.Join(work, strings.Repeat("x", 1024))
	_, statErr := os.Lstat(invalid)
	if statErr == nil || errors.Is(statErr, os.ErrNotExist) {
		t.Skip("filesystem does not report oversized path components as an I/O error")
	}
	if ok, err := resumeCompletedLayout(context.Background(), source, invalid, 0, 0); ok || err == nil {
		t.Fatalf("cache I/O error ignored: %v, %v", ok, err)
	}
}

func TestResumeCompletedLayoutPreservesUnreadableManifest(t *testing.T) {
	source, work, manifest := resumeFixture(t)
	want := writeResumeManifest(t, work, "manifest.json.part", manifest)
	path := filepath.Join(work, "manifest.json.part")
	if err := os.Chmod(path, 0); err != nil {
		t.Skipf("cannot restrict manifest permissions: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
	if _, err := os.ReadFile(path); err == nil {
		t.Skip("current account can still read a permission-restricted file")
	}
	if ok, err := resumeCompletedLayout(context.Background(), source, work, 0, 0); ok || err == nil {
		t.Fatalf("unreadable cache error ignored: %v, %v", ok, err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(want) {
		t.Fatalf("unreadable cache lost: %v", err)
	}
}

func TestResumeCompletedLayoutRejectsTruncatedJSONAndKeepsExistingFinal(t *testing.T) {
	for _, existingFinal := range []bool{false, true} {
		t.Run(map[bool]string{true: "existing final", false: "truncated part"}[existingFinal], func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			name := "manifest.json.part"
			if existingFinal {
				writeResumeManifest(t, work, name, manifest)
				name = "manifest.json"
			}
			broken := []byte(`{"schemaVersion":1,"textExtractionVersion":2,"pages":2,`)
			if err := os.WriteFile(filepath.Join(work, name), broken, 0600); err != nil {
				t.Fatal(err)
			}
			ok, err := resumeCompletedLayout(context.Background(), source, work, 0, 0)
			if err != nil || ok {
				t.Fatalf("resume = %v, %v", ok, err)
			}
			got, err := os.ReadFile(filepath.Join(work, name))
			if err != nil || string(got) != string(broken) {
				t.Fatalf("existing file replaced: %v", err)
			}
		})
	}
}

func TestResumeCompletedLayoutRejectsSymlinks(t *testing.T) {
	for _, name := range []string{"manifest.json.part", "paper.md", "assets", "assets/p1-b1.png"} {
		t.Run(name, func(t *testing.T) {
			source, work, manifest := resumeFixture(t)
			writeResumeManifest(t, work, "manifest.json.part", manifest)
			path := filepath.Join(work, filepath.FromSlash(name))
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.Rename(path, outside); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, path); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			ok, err := resumeCompletedLayout(context.Background(), source, work, 0, 0)
			if err != nil || ok {
				t.Fatalf("accepted symlink: %v, %v", ok, err)
			}
		})
	}
}

func TestRunLayoutResumesBeforeRemovingCompletedOutput(t *testing.T) {
	source, work, manifest := resumeFixture(t)
	want := writeResumeManifest(t, work, "manifest.json.part", manifest)
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	d := Document{ID: "cached", Type: "pdf", Library: "papers"}
	input, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.File(d), input, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("READER_PROCESSOR", "must-not-start-worker")
	t.Setenv("READER_NODE", "must-not-start-node")
	s := NewServer(store, "test", "")
	if err := s.runLayout(context.Background(), d, work, 0, 0, &Processing{}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(work, "manifest.json"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("completed output lost: %v", err)
	}
}
