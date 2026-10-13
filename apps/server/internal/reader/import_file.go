package reader

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
)

// PDFs live in papers even when displayed in the book library. Stage beside
// the final file so mounted/redirected storage directories do not cross volumes.
func (s *Store) createImportTemp(kind, pattern string) (*os.File, error) {
	return os.CreateTemp(filepath.Dir(s.File(Document{Type: kind})), pattern)
}

// installImportFile consumes only a private staging file, never an original
// attachment. Callers hold importMu and remove the destination if SQL fails.
func installImportFile(source, destination string, size int64, digest []byte) error {
	return installImportFileWithRename(source, destination, size, digest, os.Rename)
}

func installImportFileWithRename(source, destination string, size int64, digest []byte, rename func(string, string) error) error {
	// Include dangling symlinks: no unregistered library file may be replaced.
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("import destination already exists: %w", os.ErrExist)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := rename(source, destination); err == nil {
		return nil
	} else if !isCrossDeviceMove(err) {
		return err
	}
	return copyImportFile(source, destination, size, digest)
}

func isCrossDeviceMove(err error) bool {
	// Windows returns ERROR_NOT_SAME_DEVICE (17), not the POSIX EXDEV value.
	return errors.Is(err, syscall.EXDEV) ||
		(runtime.GOOS == "windows" && errors.Is(err, syscall.Errno(17)))
}

func copyImportFile(source, destination string, size int64, digest []byte) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	complete := false
	defer func() {
		_ = out.Close()
		if !complete {
			_ = os.Remove(destination)
		}
	}()
	// Bound the copy even if a staging file changes after validation.
	n, err := io.Copy(out, io.LimitReader(in, size+1))
	if err != nil {
		return err
	}
	if n != size {
		return errors.New("import file size changed during copy")
	}
	if err = out.Sync(); err != nil {
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	// Read back the saved bytes before releasing the private source copy.
	check, err := os.Open(destination)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, err = io.Copy(hash, io.LimitReader(check, size+1))
	if closeErr := check.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if n != size || !bytes.Equal(hash.Sum(nil), digest) {
		return errors.New("import file verification failed")
	}
	// Close first: Windows cannot remove a file that is still open.
	if err = in.Close(); err != nil {
		return err
	}
	if err = os.Remove(source); err != nil {
		return err
	}
	complete = true
	return nil
}
