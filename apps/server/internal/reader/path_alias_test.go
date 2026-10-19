package reader

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Directory junctions exercise Windows reparse-point resolution without the
// administrator/Developer Mode privilege required to create symbolic links.
func linkTestDirectory(t *testing.T, target, link string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			`$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:READER_TEST_LINK -Target $env:READER_TEST_TARGET | Out-Null`)
		cmd.Env = append(os.Environ(), "READER_TEST_LINK="+link, "READER_TEST_TARGET="+target)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("create directory junction: %v\n%s", err, output)
		}
	} else if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	linked, err := os.Stat(link)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.Stat(target)
	if err != nil || !os.SameFile(linked, original) {
		t.Fatalf("directory alias does not resolve to target: %v", err)
	}
}

// Replace a fixture file with a readable link outside its root. On Windows,
// redirect its otherwise empty parent directory; on Unix retain file-symlink
// coverage. The security assertion must reject an escape, not a broken link.
func replaceTestFileWithExternalLink(t *testing.T, path string, data []byte) {
	t.Helper()
	out := t.TempDir()
	external := filepath.Join(out, filepath.Base(path))
	if err := os.WriteFile(external, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		parent := filepath.Dir(path)
		if err := os.Remove(parent); err != nil {
			t.Fatal(err)
		}
		linkTestDirectory(t, out, parent)
	} else if err := os.Symlink(external, path); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("escape fixture is not readable through the link: %v", err)
	}
}
