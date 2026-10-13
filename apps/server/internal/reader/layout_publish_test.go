package reader

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

func stagedLayout(t *testing.T) (string, string, map[string][]byte) {
	t.Helper()
	root := t.TempDir()
	work, destination := filepath.Join(root, "analysis-work"), filepath.Join(root, "analysis")
	files := map[string][]byte{
		"assets/p1-b1.png": bytes.Repeat([]byte("image\x00\xff"), 8192),
		"paper.md":         []byte("# Parsed paper\n\nBody text."),
		"manifest.json":    []byte(`{"pages":1,"blocks":[{"id":"p1-b1","page":1,"bounds":{"x":0,"y":0,"width":0.5,"height":0.5},"image":"assets/p1-b1.png"}]}`),
	}
	for relative, data := range files {
		path := filepath.Join(work, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return work, destination, files
}

func assertLayoutFiles(t *testing.T, root string, files map[string][]byte) {
	t.Helper()
	for relative, want := range files {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("layout file %q was changed: %v", relative, err)
		}
	}
}

func TestPublishLayoutPrefersRename(t *testing.T) {
	work, destination, files := stagedLayout(t)
	err := publishLayoutWith(work, destination, os.Rename, func(string, string) error {
		t.Fatal("successful rename copied layout files")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertLayoutFiles(t, destination, files)
	if _, err := os.Lstat(work); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("rename left the staging directory", err)
	}
}

func TestPublishLayoutCrossDevice(t *testing.T) {
	errorsToTest := map[string]error{"posix": syscall.EXDEV}
	if runtime.GOOS == "windows" {
		errorsToTest["windows"] = syscall.Errno(17)
	}
	for name, moveError := range errorsToTest {
		t.Run(name, func(t *testing.T) {
			work, destination, files := stagedLayout(t)
			var copied []string
			err := publishLayoutWith(work, destination, func(from, to string) error {
				return &os.LinkError{Op: "rename", Old: from, New: to, Err: moveError}
			}, func(from, to string) error {
				if _, err := os.Stat(filepath.Join(destination, "manifest.json")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("manifest exposed before all assets were copied", err)
				}
				copied = append(copied, filepath.Base(from))
				return copyLayoutFile(from, to)
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(copied) != len(files) || copied[len(copied)-1] != "manifest.json" {
				t.Fatalf("manifest was not copied last: %v", copied)
			}
			assertLayoutFiles(t, destination, files)
			if _, err := os.Lstat(filepath.Join(destination, layoutPublishMarker)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("publication marker remained after success", err)
			}
			if _, err := os.Lstat(work); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("private work directory was not consumed", err)
			}
		})
	}
}

func TestPublishLayoutPreservesExistingDestination(t *testing.T) {
	for _, race := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "racing"}[race], func(t *testing.T) {
			work, destination, files := stagedLayout(t)
			createExisting := func() {
				if err := os.Mkdir(destination, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(destination, "manifest.json"), []byte("reader corrections"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if !race {
				createExisting()
			}
			err := publishLayoutWith(work, destination, func(string, string) error {
				if !race {
					t.Fatal("attempted rename over an existing layout")
				}
				createExisting()
				return syscall.EXDEV
			}, copyLayoutFile)
			if !errors.Is(err, os.ErrExist) {
				t.Fatal("existing layout was accepted", err)
			}
			got, err := os.ReadFile(filepath.Join(destination, "manifest.json"))
			if err != nil || string(got) != "reader corrections" {
				t.Fatal("existing reader corrections changed", err)
			}
			assertLayoutFiles(t, work, files)
		})
	}
}

func TestPublishLayoutCopyFailurePreservesWork(t *testing.T) {
	for _, failingFile := range []string{"paper.md", "manifest.json"} {
		t.Run(failingFile, func(t *testing.T) {
			work, destination, files := stagedLayout(t)
			injected := errors.New("injected copy failure")
			copied := 0
			err := publishLayoutWith(work, destination, func(string, string) error { return syscall.EXDEV }, func(from, to string) error {
				if filepath.Base(from) == failingFile {
					if copied == 0 {
						t.Fatal("failure did not occur after an asset copy")
					}
					if err := os.WriteFile(to, []byte("partial"), 0600); err != nil {
						t.Fatal(err)
					}
					return injected
				}
				copied++
				return copyLayoutFile(from, to)
			})
			if !errors.Is(err, injected) {
				t.Fatal("copy failure was lost", err)
			}
			assertLayoutFiles(t, work, files)
			if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed publication left a destination", err)
			}
		})
	}
}

func TestPublishLayoutRenameFailureDoesNotCopy(t *testing.T) {
	work, destination, files := stagedLayout(t)
	err := publishLayoutWith(work, destination, func(string, string) error { return os.ErrPermission }, func(string, string) error {
		t.Fatal("non-cross-device rename failure fell back to copying")
		return nil
	})
	if !errors.Is(err, os.ErrPermission) {
		t.Fatal("rename failure was lost", err)
	}
	assertLayoutFiles(t, work, files)
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("rename failure created a destination", err)
	}
}

func TestPublishLayoutRejectsIncompleteOrNestedLayout(t *testing.T) {
	for _, invalid := range []string{"missing-manifest", "manifest-directory", "nested-destination"} {
		t.Run(invalid, func(t *testing.T) {
			work, destination, _ := stagedLayout(t)
			if invalid == "nested-destination" {
				destination = filepath.Join(work, "nested")
			} else {
				if err := os.Remove(filepath.Join(work, "manifest.json")); err != nil {
					t.Fatal(err)
				}
				if invalid == "manifest-directory" {
					if err := os.Mkdir(filepath.Join(work, "manifest.json"), 0700); err != nil {
						t.Fatal(err)
					}
				}
			}
			err := publishLayoutWith(work, destination, func(string, string) error { t.Fatal("invalid layout reached rename"); return nil }, copyLayoutFile)
			if err == nil {
				t.Fatal("invalid layout accepted")
			}
			if _, err := os.Lstat(work); err != nil {
				t.Fatal("invalid work was removed", err)
			}
		})
	}
}

func TestPublishLayoutRejectsSymbolicLinks(t *testing.T) {
	work, destination, files := stagedLayout(t)
	if err := os.Symlink(filepath.Join(work, "paper.md"), filepath.Join(work, "linked.md")); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	err := publishLayoutWith(work, destination, func(string, string) error { t.Fatal("symbolic link reached rename"); return nil }, copyLayoutFile)
	if err == nil {
		t.Fatal("layout symbolic link accepted")
	}
	assertLayoutFiles(t, work, files)
}

func interruptedLayout(t *testing.T, work, destination string, files map[string][]byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(destination, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(files["manifest.json"])
	if err := writeLayoutPublication(destination, layoutPublication{Source: work, ManifestSHA256: hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	// A killed process can leave even the current asset partially written.
	if err := os.WriteFile(filepath.Join(destination, "assets", "p1-b1.png"), files["assets/p1-b1.png"][:9], 0600); err != nil {
		t.Fatal(err)
	}
}

func TestPublishLayoutResumesInterruptedCopy(t *testing.T) {
	for _, partialManifest := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing manifest", true: "truncated manifest"}[partialManifest], func(t *testing.T) {
			work, destination, files := stagedLayout(t)
			interruptedLayout(t, work, destination, files)
			if partialManifest {
				if err := os.WriteFile(filepath.Join(destination, "manifest.json"), files["manifest.json"][:17], 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := publishLayoutWith(work, destination, func(string, string) error { return syscall.EXDEV }, copyLayoutFile); err != nil {
				t.Fatal(err)
			}
			assertLayoutFiles(t, destination, files)
			if _, err := os.Lstat(work); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("recovered publication left its private source", err)
			}
			if _, err := os.Lstat(filepath.Join(destination, layoutPublishMarker)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("recovered publication left its marker", err)
			}
		})
	}
}

func TestFirstBookLayoutResumesInterruptedPublication(t *testing.T) {
	for _, partialManifest := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing manifest", true: "truncated manifest"}[partialManifest], func(t *testing.T) {
			work, _, files := stagedLayout(t)
			s := &Server{Store: &Store{Root: t.TempDir()}}
			destination := s.analysisDir("book")
			interruptedLayout(t, work, destination, files)
			if partialManifest {
				if err := os.WriteFile(filepath.Join(destination, "manifest.json"), files["manifest.json"][:17], 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.mergeLayout("book", work); err != nil {
				t.Fatal(err)
			}
			assertLayoutFiles(t, destination, files)
		})
	}
}

func TestPublishLayoutRecoveryPreservesUnknownOrModifiedTargets(t *testing.T) {
	for _, change := range []string{"valid manifest", "edited manifest", "edited asset", "extra file", "different source", "different digest", "broken marker", "no marker", "incomplete source"} {
		t.Run(change, func(t *testing.T) {
			work, destination, files := stagedLayout(t)
			interruptedLayout(t, work, destination, files)
			var preserved string
			switch change {
			case "valid manifest":
				preserved = "manifest.json"
				if err := os.WriteFile(filepath.Join(destination, preserved), files[preserved], 0600); err != nil {
					t.Fatal(err)
				}
			case "edited manifest", "edited asset", "extra file":
				preserved = map[string]string{"edited manifest": "manifest.json", "edited asset": "assets/p1-b1.png", "extra file": "reader-notes.md"}[change]
				if err := os.WriteFile(filepath.Join(destination, preserved), []byte("reader corrections"), 0600); err != nil {
					t.Fatal(err)
				}
			case "different source", "different digest":
				digest := sha256.Sum256(files["manifest.json"])
				marker := layoutPublication{Source: work, ManifestSHA256: hex.EncodeToString(digest[:])}
				if change == "different source" {
					marker.Source += "-other"
				} else {
					marker.ManifestSHA256 = "other"
				}
				if err := os.Remove(filepath.Join(destination, layoutPublishMarker)); err != nil {
					t.Fatal(err)
				}
				if err := writeLayoutPublication(destination, marker); err != nil {
					t.Fatal(err)
				}
			case "broken marker":
				if err := os.WriteFile(filepath.Join(destination, layoutPublishMarker), []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "no marker":
				if err := os.Remove(filepath.Join(destination, layoutPublishMarker)); err != nil {
					t.Fatal(err)
				}
			case "incomplete source":
				if err := os.Remove(filepath.Join(work, "assets", "p1-b1.png")); err != nil {
					t.Fatal(err)
				}
				delete(files, "assets/p1-b1.png")
			}
			var before []byte
			if preserved != "" {
				var err error
				before, err = os.ReadFile(filepath.Join(destination, preserved))
				if err != nil {
					t.Fatal(err)
				}
			}
			err := publishLayoutWith(work, destination, func(string, string) error { t.Fatal("unowned target reached rename"); return nil }, copyLayoutFile)
			if err == nil {
				t.Fatal("unsafe target recovery was accepted")
			}
			if _, err := os.Lstat(destination); err != nil {
				t.Fatal("unowned or modified target was removed", err)
			}
			if preserved != "" {
				after, err := os.ReadFile(filepath.Join(destination, preserved))
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("reader changes were modified", err)
				}
			}
			assertLayoutFiles(t, work, files)
		})
	}
}
