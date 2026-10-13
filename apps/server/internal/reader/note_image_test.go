package reader

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNoteImageRoundTrip(t *testing.T) {
	s := testServer(t)
	doc := organizationDoc(t, s)
	png := []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
		0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
		0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
		0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
		0xae, 0x42, 0x60, 0x82,
	}
	saved := request(t, s, "POST", "/api/documents/"+doc.ID+"/note-images", bytes.NewReader(png))
	if saved.Code != 201 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(saved.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !noteImageName.MatchString(body.ID) {
		t.Fatal(body.ID)
	}
	got := request(t, s, "GET", "/api/documents/"+doc.ID+"/note-images/"+body.ID, nil)
	if got.Code != 200 || got.Header().Get("Content-Type") != "image/png" || !bytes.Equal(got.Body.Bytes(), png) {
		t.Fatal(got.Code, got.Header().Get("Content-Type"), got.Body.Len())
	}
	stored := filepath.Join(s.Store.Root, "cache", doc.ID, "note-images", body.ID)
	if info, err := os.Stat(stored); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("image permissions: %o", info.Mode().Perm())
	}
	rejected := request(t, s, "POST", "/api/documents/"+doc.ID+"/note-images", bytes.NewReader([]byte("not-an-image")))
	if rejected.Code != 400 {
		t.Fatal(rejected.Code, rejected.Body.String())
	}
	missing := request(t, s, "GET", "/api/documents/"+doc.ID+"/note-images/not-an-image.png", nil)
	if missing.Code != 404 {
		t.Fatal(missing.Code, missing.Body.String())
	}
	traversal := request(t, s, "GET", "/api/documents/"+doc.ID+"/note-images/"+url.PathEscape("../secret.png"), nil)
	if traversal.Code != 404 {
		t.Fatal(traversal.Code, traversal.Body.String())
	}
	unknown := request(t, s, "POST", "/api/documents/missing/note-images", bytes.NewReader(png))
	if unknown.Code != 404 {
		t.Fatal(unknown.Code, unknown.Body.String())
	}
}

func TestNoteImageAndExistingNotesSurviveTrashAndRestore(t *testing.T) {
	checkNotesSurviveTrashAndRestore(t, testServer(t))
}

// Opt in to exercise the library's filesystem (including Windows encryption)
// in an isolated temporary store, without opening the reader's actual data.
func TestNoteImageOnLibraryFilesystem(t *testing.T) {
	parent := os.Getenv("READER_TEST_NOTES_ROOT")
	if parent == "" {
		t.Skip("set READER_TEST_NOTES_ROOT to test the library filesystem")
	}
	root, err := os.MkdirTemp(parent, "reader-notes-test-")
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
	checkNotesSurviveTrashAndRestore(t, s)
}

func checkNotesSurviveTrashAndRestore(t *testing.T, s *Server) {
	t.Helper()
	doc := organizationDoc(t, s)
	path := "/api/documents/" + doc.ID
	image := []byte("GIF89a image")
	w := request(t, s, "POST", path+"/note-images", bytes.NewReader(image))
	var uploaded struct {
		ID string `json:"id"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &uploaded) != nil {
		t.Fatalf("upload failed: %d", w.Code)
	}
	note := "existing note\n\n![](note-image:" + uploaded.ID + ")"
	payload, _ := json.Marshal(map[string]string{"body": note})
	if w := request(t, s, "PUT", path+"/note", bytes.NewReader(payload)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := s.Store.DB.Exec(`INSERT INTO annotations VALUES('existing', ?, '{}')`, doc.ID); err != nil {
		t.Fatal(err)
	}
	if w := request(t, s, "POST", path+"/trash", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(t, s, "POST", path+"/note-images", bytes.NewReader(image)); w.Code != 404 {
		t.Fatalf("upload allowed in trash: %d", w.Code)
	}
	if w := request(t, s, "POST", path+"/restore", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(t, s, "GET", path+"/note-images/"+uploaded.ID, nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), image) {
		t.Fatalf("restored image missing: %d", w.Code)
	}
	var saved struct {
		Body string `json:"body"`
	}
	w = request(t, s, "GET", path+"/note", nil)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &saved) != nil || saved.Body != note {
		t.Fatalf("restored note changed: %d %s", w.Code, w.Body.String())
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=?", doc.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("existing annotations changed: count=%d err=%v", count, err)
	}
}

func TestNoteImageAuthenticationAndLimits(t *testing.T) {
	s := testServer(t)
	doc := organizationDoc(t, s)
	path := "/api/documents/" + doc.ID + "/note-images"
	for _, method := range []string{"GET", "POST"} {
		target := path
		if method == "GET" {
			target += "/" + strings.Repeat("a", 32) + ".png"
		}
		for _, origin := range []string{"", "https://untrusted.example"} {
			r := httptest.NewRequest(method, "http://127.0.0.1:17840"+target, nil)
			want := 401
			if origin != "" {
				r.Header.Set("Authorization", "Bearer test-secret")
				r.Header.Set("Origin", origin)
				want = 403
			}
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != want {
				t.Fatalf("%s %s: got %d, want %d", method, origin, w.Code, want)
			}
		}
	}
	for _, data := range [][]byte{
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, noteImageLimit)...),
	} {
		if w := request(t, s, "POST", path, bytes.NewReader(data)); w.Code != 400 {
			t.Fatalf("invalid upload accepted: %d", w.Code)
		}
	}
	if _, err := os.Stat(s.noteImageDir(doc.ID)); !os.IsNotExist(err) {
		t.Fatalf("rejected uploads created files: %v", err)
	}
}

type blockedNoteImageBody struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (b *blockedNoteImageBody) Read([]byte) (int, error) {
	close(b.started)
	<-b.closed
	return 0, io.ErrClosedPipe
}

func (b *blockedNoteImageBody) Close() error {
	b.once.Do(func() { close(b.closed) })
	return nil
}

func TestNoteImageDeleteCancelsUploadWithoutRecreatingCache(t *testing.T) {
	s := testServer(t)
	doc := organizationDoc(t, s)
	body := &blockedNoteImageBody{started: make(chan struct{}), closed: make(chan struct{})}
	defer body.Close()
	done := make(chan int, 1)
	go func() {
		done <- request(t, s, "POST", "/api/documents/"+doc.ID+"/note-images", body).Code
	}()
	select {
	case <-body.started:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start")
	}
	deleted := make(chan int, 1)
	go func() { deleted <- request(t, s, "DELETE", "/api/documents/"+doc.ID, nil).Code }()
	select {
	case code := <-deleted:
		if code != 204 {
			t.Fatalf("delete failed: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not cancel and join image upload")
	}
	if code := <-done; code != 409 {
		t.Fatalf("canceled upload: %d", code)
	}
	if _, err := os.Stat(filepath.Join(s.Store.Root, "cache", doc.ID)); !os.IsNotExist(err) {
		t.Fatalf("upload recreated deleted cache: %v", err)
	}
	if w := request(t, s, "POST", "/api/documents/"+doc.ID+"/note-images", strings.NewReader("GIF89a")); w.Code != 404 {
		t.Fatalf("deleted document accepted upload: %d", w.Code)
	}
}

func TestNoteImageRejectsSymlinkAssets(t *testing.T) {
	for _, linkDirectory := range []bool{false, true} {
		t.Run(map[bool]string{false: "image", true: "directory"}[linkDirectory], func(t *testing.T) {
			s := testServer(t)
			doc := organizationDoc(t, s)
			outside := t.TempDir()
			name := strings.Repeat("a", 32) + ".gif"
			if err := os.WriteFile(filepath.Join(outside, name), []byte("GIF89a private"), 0600); err != nil {
				t.Fatal(err)
			}
			dir := s.noteImageDir(doc.ID)
			parent := dir
			if linkDirectory {
				parent = filepath.Dir(dir)
			}
			if err := os.MkdirAll(parent, 0700); err != nil {
				t.Fatal(err)
			}
			old, target := filepath.Join(outside, name), filepath.Join(dir, name)
			if linkDirectory {
				old, target = outside, dir
			}
			if err := os.Symlink(old, target); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			path := "/api/documents/" + doc.ID + "/note-images"
			if w := request(t, s, "GET", path+"/"+name, nil); w.Code != 404 || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("read escaped image storage: %d %s", w.Code, w.Body.String())
			}
			if linkDirectory {
				if w := request(t, s, "POST", path, strings.NewReader("GIF89a")); w.Code != 500 {
					t.Fatalf("write followed directory symlink: %d", w.Code)
				}
				entries, err := os.ReadDir(outside)
				if err != nil || len(entries) != 1 {
					t.Fatalf("write escaped note directory: %v %v", entries, err)
				}
			}
		})
	}
}
