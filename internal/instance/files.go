package instance

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/derived"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"golang.org/x/sys/windows"
)

// ReadSnapshot keeps an opened version readable while WriteJSON replaces its name.
func ReadSnapshot(file string) ([]byte, error) {
	f, err := openSnapshot(file)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(f)
	return b, errors.Join(err, f.Close())
}

func openSnapshot(file string) (*os.File, error) {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + absolute[2:]
		} else {
			absolute = `\\?\` + absolute
		}
	}
	p, err := windows.UTF16PtrFromString(absolute)
	if err != nil {
		return nil, err
	}
	// Go's os.Open omits FILE_SHARE_DELETE on Windows. A status poll must not
	// prevent the writer's atomic rename while holding an older snapshot.
	h, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: file, Err: err}
	}
	return os.NewFile(uintptr(h), file), nil
}

func WriteJSON(file string, value any) error {
	if err := library.NoLinks(file); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temp := file + "." + hex.EncodeToString(random[:]) + ".tmp"
	b, err := protocol.JSON(value)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err == nil {
		// Root.Rename uses Windows POSIX rename semantics, allowing readers to
		// finish the previous snapshot instead of cancelling a status update.
		var root *os.Root
		root, err = os.OpenRoot(filepath.Dir(file))
		if err == nil {
			err = errors.Join(root.Rename(filepath.Base(temp), filepath.Base(file)), root.Close())
		}
	}
	if err != nil {
		if recycleErr := RemoveOwned(temp); recycleErr != nil && !os.IsNotExist(recycleErr) {
			return errors.Join(err, recycleErr)
		}
	}
	return err
}

// RemoveOwned permanently removes application-owned derived or temporary files.
var RemoveOwned = derived.Remove
