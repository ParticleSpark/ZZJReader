package reader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// A completed worker may have failed only while publishing its manifest or
// output directory. Validate that private output before runLayout removes it.
func resumeCompletedLayout(ctx context.Context, source, work string, from, to int) (resumed bool, resultErr error) {
	defer func() {
		if err := ctx.Err(); err != nil {
			resumed, resultErr = false, err
		}
	}()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	info, err := os.Lstat(work)
	if err != nil {
		return false, layoutCacheReadError(err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, nil
	}
	final := filepath.Join(work, "manifest.json")
	manifest := final
	info, err = os.Lstat(manifest)
	if os.IsNotExist(err) {
		manifest += ".part"
		info, err = os.Lstat(manifest)
	}
	// Never replace an existing final manifest, including a malformed one.
	if err != nil {
		return false, layoutCacheReadError(err)
	}
	if !info.Mode().IsRegular() || info.Size() > 32<<20 {
		return false, nil
	}
	data, err := os.ReadFile(manifest)
	if err != nil {
		return false, layoutCacheReadError(err)
	}
	var cached struct {
		layoutManifest
		SchemaVersion         int    `json:"schemaVersion"`
		TextExtractionVersion int    `json:"textExtractionVersion"`
		InputSHA256           string `json:"inputSHA256"`
	}
	if json.Unmarshal(data, &cached) != nil || cached.SchemaVersion != 1 || cached.TextExtractionVersion != 2 || cached.Blocks == nil || validateLayout(cached.layoutManifest) != nil {
		return false, nil
	}
	first, last := 1, cached.Pages
	if from == 0 && to == 0 {
		if len(cached.ParsedPages) != 0 {
			return false, nil
		}
	} else {
		first, last = from, min(to, cached.Pages)
		if first < 1 || last < first || len(cached.ParsedPages) != last-first+1 {
			return false, nil
		}
		for i, page := range cached.ParsedPages {
			if page != first+i {
				return false, nil
			}
		}
	}
	if regular, err := checkRegularLayoutFile(filepath.Join(work, "paper.md")); !regular || err != nil {
		return false, err
	}
	seen := make(map[string]bool, len(cached.Blocks))
	for _, block := range cached.Blocks {
		if block.Page < first || block.Page > last || seen[block.ID] {
			return false, nil
		}
		seen[block.ID] = true
		if block.Image != "" {
			assets, err := os.Lstat(filepath.Join(work, "assets"))
			if err != nil {
				return false, layoutCacheReadError(err)
			}
			if !assets.IsDir() || assets.Mode()&os.ModeSymlink != 0 {
				return false, nil
			}
			if regular, err := checkRegularLayoutFile(filepath.Join(work, block.Image)); !regular || err != nil {
				return false, err
			}
		}
	}
	for _, page := range cached.IncompletePages {
		if page < first || page > last {
			return false, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	hash, err := layoutSourceHash(ctx, source)
	if err != nil {
		return false, err
	}
	if hash != cached.InputSHA256 {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if manifest != final {
		digest := sha256.Sum256(data)
		if err := installImportFile(manifest, final, int64(len(data)), digest[:]); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Missing/incomplete output can be rebuilt. Inaccessible output must be kept:
// returning an error prevents runLayout from deleting a recoverable cache.
func layoutCacheReadError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func regularLayoutFile(path string) bool {
	regular, _ := checkRegularLayoutFile(path)
	return regular
}

func checkRegularLayoutFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, layoutCacheReadError(err)
	}
	return info.Mode().IsRegular(), nil
}

func layoutSourceHash(ctx context.Context, path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("PDF source is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, layoutContextReader{ctx: ctx, reader: file}); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type layoutContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r layoutContextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
