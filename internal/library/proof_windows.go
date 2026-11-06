package library

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func directoryProof(f *os.File, st os.FileInfo) (DirectoryProof, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
		return DirectoryProof{}, err
	}
	return DirectoryProof{Volume: info.VolumeSerialNumber, Index: uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow), Mtime: st.ModTime().UnixNano()}, nil
}

func verifyDirectoryProof(path string, before DirectoryProof) error {
	p, err := directoryPath(path)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	attrs, err := directoryAttributes(st)
	if err != nil {
		return err
	}
	after, err := directoryProof(f, st)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !st.IsDir() || after != before {
		return errors.New("DIRECTORY_CHANGED_DURING_SCAN")
	}
	return nil
}
