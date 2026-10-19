//go:build !windows

package reader

import "path/filepath"

func canonicalZoteroAttachmentPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
