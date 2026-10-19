package reader

import (
	"os"

	"golang.org/x/sys/windows"
)

// EvalSymlinks does not resolve directory junctions on modern Go versions.
// Resolve from a handle so both symlinks and junctions have the same boundary
// semantics. This handle is only used for its path; no file content is read.
func canonicalZoteroAttachmentPath(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	buffer := make([]uint16, 256)
	for {
		// Zero selects FILE_NAME_NORMALIZED | VOLUME_NAME_DOS. Preserve the
		// extended-length prefix so long local paths and UNC paths still work.
		n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &buffer[0], uint32(len(buffer)), 0)
		if err != nil {
			return "", err
		}
		if n < uint32(len(buffer)) {
			return windows.UTF16ToString(buffer[:n]), nil
		}
		buffer = make([]uint16, n+1)
	}
}
