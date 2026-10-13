package reader

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

func TestImportStagingUsesDocumentStorage(t *testing.T) {
	s := testServer(t)
	for _, kind := range []string{"pdf", "epub"} {
		file, err := s.Store.createImportTemp(kind, "stage-*")
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
		t.Cleanup(func() { os.Remove(file.Name()) })
		for _, library := range []string{"books", "papers"} {
			destination := s.Store.File(Document{ID: "document", Type: kind, Library: library})
			if filepath.Dir(file.Name()) != filepath.Dir(destination) {
				t.Fatalf("%s in %s staged outside its storage directory", kind, library)
			}
		}
	}
}

func TestImportCrossDeviceCopy(t *testing.T) {
	errorsToTest := map[string]error{"posix": syscall.EXDEV}
	if runtime.GOOS == "windows" {
		errorsToTest["windows"] = syscall.Errno(17)
	}
	for name, moveError := range errorsToTest {
		t.Run(name, func(t *testing.T) {
			source := filepath.Join(t.TempDir(), "private.pdf")
			destination := filepath.Join(t.TempDir(), "document.pdf")
			data := bytes.Repeat([]byte("original PDF bytes\x00\xff"), 8192)
			if err := os.WriteFile(source, data, 0600); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(data)
			err := installImportFileWithRename(source, destination, int64(len(data)), digest[:], func(from, to string) error {
				return &os.LinkError{Op: "rename", Old: from, New: to, Err: moveError}
			})
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(destination)
			if err != nil || !bytes.Equal(got, data) {
				t.Fatal("saved file differs from the validated source", err)
			}
			if _, err := os.Stat(source); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("private staging file not consumed", err)
			}
		})
	}
}

func TestImportFailedCopyPreservesSource(t *testing.T) {
	data := []byte("validated PDF bytes")
	digest := sha256.Sum256(data)
	for name, changed := range map[string][]byte{
		"truncated": data[:len(data)-1],
		"grown":     append(append([]byte{}, data...), '!'),
		"corrupt":   bytes.Repeat([]byte("x"), len(data)),
	} {
		t.Run(name, func(t *testing.T) {
			source := filepath.Join(t.TempDir(), "private.pdf")
			destination := filepath.Join(t.TempDir(), "document.pdf")
			if err := os.WriteFile(source, changed, 0600); err != nil {
				t.Fatal(err)
			}
			err := installImportFileWithRename(source, destination, int64(len(data)), digest[:], func(string, string) error { return syscall.EXDEV })
			if err == nil {
				t.Fatal("invalid copy accepted")
			}
			got, err := os.ReadFile(source)
			if err != nil || !bytes.Equal(got, changed) {
				t.Fatal("source changed after failed copy", err)
			}
			if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed copy left a destination", err)
			}
		})
	}
}

func TestImportRenamePermissionFailureDoesNotCopy(t *testing.T) {
	source := filepath.Join(t.TempDir(), "private.pdf")
	destination := filepath.Join(t.TempDir(), "document.pdf")
	data := []byte("source")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	err := installImportFileWithRename(source, destination, int64(len(data)), digest[:], func(from, to string) error {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: os.ErrPermission}
	})
	if !errors.Is(err, os.ErrPermission) {
		t.Fatal("rename error not preserved", err)
	}
	if got, err := os.ReadFile(source); err != nil || !bytes.Equal(got, data) {
		t.Fatal("source changed after rejected rename", err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("permission failure fell back to a copy", err)
	}
	if runtime.GOOS != "windows" && isCrossDeviceMove(syscall.Errno(17)) {
		t.Fatal("POSIX EEXIST mistaken for a Windows cross-device error")
	}
}

func TestImportFallbackDoesNotOverwriteRacingDestination(t *testing.T) {
	source := filepath.Join(t.TempDir(), "private.pdf")
	destination := filepath.Join(t.TempDir(), "document.pdf")
	data := []byte("source")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	err := installImportFileWithRename(source, destination, int64(len(data)), digest[:], func(string, string) error {
		if err := os.WriteFile(destination, []byte("preexisting"), 0600); err != nil {
			t.Fatal(err)
		}
		return syscall.EXDEV
	})
	if !errors.Is(err, os.ErrExist) {
		t.Fatal("existing destination accepted", err)
	}
	if got, err := os.ReadFile(destination); err != nil || string(got) != "preexisting" {
		t.Fatal("existing destination changed", err)
	}
	if got, err := os.ReadFile(source); err != nil || !bytes.Equal(got, data) {
		t.Fatal("source removed after destination conflict", err)
	}
}
