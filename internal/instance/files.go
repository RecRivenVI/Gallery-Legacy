package instance

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"golang.org/x/sys/windows"
)

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
		err = os.Rename(temp, file)
	}
	if err != nil {
		if recycleErr := Recycle(temp); recycleErr != nil && !os.IsNotExist(recycleErr) {
			return errors.Join(err, recycleErr)
		}
	}
	return err
}

type recycleOperation struct {
	window   uintptr
	function uint32
	from, to *uint16
	flags    uint16
	aborted  int32
	mappings uintptr
	title    *uint16
}

var shellOperation = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// Recycle is only used for owned derived/temporary files, never source media.
func Recycle(path string) error {
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	from, err := windows.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0)
	op := recycleOperation{function: 3, from: &from[0], flags: 0x0454}
	result, _, _ := shellOperation.Call(uintptr(unsafe.Pointer(&op)))
	if result != 0 || op.aborted != 0 {
		return fmt.Errorf("recycle owned temporary file failed: %d", result)
	}
	return nil
}
