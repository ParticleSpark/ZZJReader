package reader

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

const noteImageLimit = 8 << 20

var noteImageName = regexp.MustCompile(`^[0-9a-f]{32}\.(?:png|jpe?g|gif|webp)$`)

func noteImageType(data []byte) (ext, contentType string, ok bool) {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return ".png", "image/png", true
	case len(data) >= 3 && bytes.Equal(data[:3], []byte{0xff, 0xd8, 0xff}):
		return ".jpg", "image/jpeg", true
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return ".gif", "image/gif", true
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return ".webp", "image/webp", true
	default:
		return "", "", false
	}
}

func (s *Server) noteImageDir(documentID string) string {
	return filepath.Join(s.Store.Root, "cache", documentID, "note-images")
}

// Open each component relative to its parent handle. Neither a cache symlink
// nor an image symlink may redirect note assets outside their document.
func (s *Server) openNoteImages(documentID string, create bool) (*os.Root, error) {
	if !filepath.IsLocal(documentID) || filepath.Base(documentID) != documentID {
		return nil, errors.New("invalid document id")
	}
	root, err := os.OpenRoot(s.Store.Root)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"cache", documentID, "note-images"} {
		if create {
			if err = root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				root.Close()
				return nil, err
			}
		}
		info, statErr := root.Lstat(name)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, errors.New("invalid note image directory")
		}
		next, openErr := root.OpenRoot(name)
		root.Close()
		if openErr != nil {
			return nil, openErr
		}
		root = next
	}
	return root, nil
}

func (s *Server) saveNoteImage(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	ctx, finish, err := s.beginDocumentTask(r.Context(), documentID)
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	defer finish()
	r.Body = http.MaxBytesReader(w, r.Body, noteImageLimit+1)
	stop := context.AfterFunc(ctx, func() { _ = r.Body.Close() })
	defer stop()
	data, err := io.ReadAll(r.Body)
	if ctx.Err() != nil {
		fail(w, 409, "图片上传已取消")
		return
	}
	if err != nil || len(data) > noteImageLimit {
		fail(w, 400, "图片不能超过 8MB")
		return
	}
	ext, _, ok := noteImageType(data)
	if !ok {
		fail(w, 400, "只接受 PNG、JPEG、GIF 或 WebP 图片")
		return
	}
	dir, err := s.openNoteImages(documentID, true)
	if err != nil {
		fail(w, 500, "无法保存图片")
		return
	}
	defer dir.Close()
	name := id() + ext
	file, err := dir.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		fail(w, 500, "无法保存图片")
		return
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil || ctx.Err() != nil {
		_ = dir.Remove(name)
		fail(w, 500, "无法保存图片")
		return
	}
	respond(w, 201, map[string]string{"id": name})
}

func (s *Server) getNoteImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !noteImageName.MatchString(name) {
		fail(w, 404, "图片不存在")
		return
	}
	_, finish, err := s.beginDocumentTask(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	defer finish()
	dir, err := s.openNoteImages(r.PathValue("id"), false)
	if err != nil {
		fail(w, 404, "图片不存在")
		return
	}
	defer dir.Close()
	info, err := dir.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > noteImageLimit {
		fail(w, 404, "图片不存在")
		return
	}
	file, err := dir.Open(name)
	if err != nil {
		fail(w, 404, "图片不存在")
		return
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		fail(w, 404, "图片不存在")
		return
	}
	buf := make([]byte, 12)
	n, _ := file.Read(buf)
	_, contentType, ok := noteImageType(buf[:n])
	if !ok {
		fail(w, 404, "图片不存在")
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		fail(w, 404, "图片不存在")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, name, opened.ModTime(), file)
}
