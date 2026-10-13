package reader

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const layoutPublishMarker = ".reader-layout-publication.json"

type layoutPublication struct {
	Source         string `json:"source"`
	ManifestSHA256 string `json:"manifestSHA256"`
}

// publishLayout installs a completed private worker directory exactly once.
// The caller serializes publication for this document. Existing layouts may
// contain reader corrections and must never be replaced by a worker result.
func publishLayout(work, destination string) error {
	return publishLayoutWith(work, destination, os.Rename, copyLayoutFile)
}

func publishLayoutWith(work, destination string, rename, copyFile func(string, string) error) error {
	work, err := filepath.Abs(work)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if relative, err := filepath.Rel(work, destination); err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("layout destination must be outside the private work directory")
	}
	var entries []string
	manifest := false
	err = filepath.WalkDir(work, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("layout contains a symbolic link or special file")
		}
		if path == work {
			if !info.IsDir() {
				return errors.New("layout work path is not a directory")
			}
			return nil
		}
		relative, err := filepath.Rel(work, path)
		if err != nil {
			return err
		}
		if relative == "manifest.json" {
			if !info.Mode().IsRegular() || info.Size() > 32<<20 {
				return errors.New("layout manifest is not a regular file")
			}
			manifest = true
			return nil
		}
		if relative == layoutPublishMarker {
			return errors.New("private layout source contains a publication marker")
		}
		entries = append(entries, relative)
		return nil
	})
	if err != nil {
		return err
	}
	if !manifest {
		return errors.New("layout manifest is missing")
	}
	data, err := os.ReadFile(filepath.Join(work, "manifest.json"))
	if err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	publication := layoutPublication{Source: work, ManifestSHA256: hex.EncodeToString(digest[:])}
	if _, err := os.Lstat(destination); err == nil {
		if err := recoverLayoutPublication(work, destination, publication, data); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := rename(work, destination); err == nil {
		return nil
	} else if !isCrossDeviceMove(err) {
		return err
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err // A racing destination belongs to somebody else.
	}
	owned, err := os.Lstat(destination)
	if err != nil {
		_ = os.Remove(destination) // Only remove an empty directory here.
		return err
	}
	published := false
	defer func() {
		if !published {
			if current, err := os.Lstat(destination); err == nil && os.SameFile(owned, current) {
				_ = os.RemoveAll(destination)
			}
		}
	}()
	if err := writeLayoutPublication(destination, publication); err != nil {
		return err
	}
	for _, relative := range entries {
		source, target := filepath.Join(work, relative), filepath.Join(destination, relative)
		info, err := os.Lstat(source)
		if err != nil {
			return err
		}
		if info.IsDir() {
			if err := os.Mkdir(target, 0700); err != nil {
				return err
			}
		} else if err := copyFile(source, target); err != nil {
			return err
		}
	}
	// Readers only accept a complete manifest. Expose it after every asset has
	// been copied, flushed and checked; partial work never looks like a layout.
	if err := copyFile(filepath.Join(work, "manifest.json"), filepath.Join(destination, "manifest.json")); err != nil {
		return err
	}
	published = true
	_ = os.Remove(filepath.Join(destination, layoutPublishMarker))
	// Publication is complete. Cleanup failure may leave private staging files,
	// but must not discard the usable layout or report its publication as failed.
	_ = os.RemoveAll(work)
	return nil
}

func writeLayoutPublication(destination string, publication layoutPublication) error {
	data, err := json.Marshal(publication)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(destination, layoutPublishMarker), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return f.Close()
}

// An interrupted copy may leave its exclusively created target behind. Only
// reclaim that target when its marker matches this complete source and every
// residual file is an unchanged copy (or write prefix) of the source. Unknown
// files, reader edits, and any valid final manifest always remain untouched.
func recoverLayoutPublication(work, destination string, want layoutPublication, sourceManifest []byte) error {
	conflict := fmt.Errorf("layout destination already exists: %w", os.ErrExist)
	owned, err := os.Lstat(destination)
	if err != nil || !owned.IsDir() || owned.Mode()&os.ModeSymlink != 0 {
		return conflict
	}
	marker := filepath.Join(destination, layoutPublishMarker)
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128<<10 {
		return conflict
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		return err
	}
	var publication layoutPublication
	if json.Unmarshal(data, &publication) != nil || publication != want {
		return conflict
	}
	var source layoutManifest
	if json.Unmarshal(sourceManifest, &source) != nil || source.Blocks == nil || validateLayout(source) != nil {
		return errors.New("private layout source is incomplete")
	}
	required := []string{"paper.md"}
	for _, block := range source.Blocks {
		if block.Image != "" {
			required = append(required, block.Image)
		}
	}
	for _, relative := range required {
		info, err := os.Lstat(filepath.Join(work, relative))
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("private layout source has an invalid asset")
		}
	}
	final := filepath.Join(destination, "manifest.json")
	if info, err := os.Lstat(final); err == nil {
		if !info.Mode().IsRegular() || info.Size() > 32<<20 {
			return conflict
		}
		data, err := os.ReadFile(final)
		if err != nil {
			return err
		}
		var completed layoutManifest
		if json.Unmarshal(data, &completed) == nil && validateLayout(completed) == nil {
			return conflict
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	err = filepath.WalkDir(destination, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == destination || path == marker {
			return nil
		}
		relative, err := filepath.Rel(destination, path)
		if err != nil {
			return err
		}
		original := filepath.Join(work, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		sourceInfo, err := os.Lstat(original)
		if err != nil {
			return conflict
		}
		if info.IsDir() && sourceInfo.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() || !sourceInfo.Mode().IsRegular() || info.Size() > sourceInfo.Size() {
			return conflict
		}
		matches, err := layoutFilePrefix(original, path, info.Size())
		if err != nil {
			return err
		}
		if !matches {
			return conflict
		}
		return nil
	})
	if err != nil {
		return err
	}
	if current, err := os.Lstat(destination); err != nil || !os.SameFile(owned, current) {
		return conflict
	}
	return os.RemoveAll(destination)
}

func layoutFilePrefix(source, partial string, size int64) (bool, error) {
	in, err := os.Open(source)
	if err != nil {
		return false, err
	}
	defer in.Close()
	check, err := os.Open(partial)
	if err != nil {
		return false, err
	}
	defer check.Close()
	expected, actual := sha256.New(), sha256.New()
	n, err := io.Copy(expected, io.LimitReader(in, size))
	if err != nil {
		return false, err
	}
	m, err := io.Copy(actual, io.LimitReader(check, size+1))
	return n == size && m == size && bytes.Equal(expected.Sum(nil), actual.Sum(nil)), err
}

func copyLayoutFile(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("layout asset is not a regular file")
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	opened, err := in.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return errors.New("layout asset changed before copying")
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer out.Close()
	digest := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, digest), io.LimitReader(in, info.Size()+1))
	if err != nil {
		return err
	}
	if n != info.Size() {
		return errors.New("layout asset size changed during copying")
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	check, err := os.Open(destination)
	if err != nil {
		return err
	}
	actual := sha256.New()
	n, err = io.Copy(actual, io.LimitReader(check, info.Size()+1))
	if closeErr := check.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if n != info.Size() || !bytes.Equal(actual.Sum(nil), digest.Sum(nil)) {
		return errors.New("layout asset verification failed")
	}
	return in.Close()
}
