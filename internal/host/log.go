package host

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

// Keep the existing instance log policy: 8 MiB per file, five archives.
type runtimeLog struct {
	root    string
	mu      sync.Mutex
	failure error
}

func (l *runtimeLog) Write(bytes []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	const size = 8 * 1024 * 1024
	payload := bytes
	if len(payload) > size {
		payload = payload[len(payload)-size:]
	}
	file := filepath.Join(l.root, "runtime-start.log")
	err := library.NoLinks(file)
	if err == nil {
		st, e := os.Stat(file)
		if e == nil && st.Size()+int64(len(payload)) > size {
			err = l.rotate(file)
		} else if e != nil && !os.IsNotExist(e) {
			err = e
		}
	}
	if err == nil {
		f, e := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e == nil {
			_, e = f.Write(payload)
			e = errors.Join(e, f.Close())
		}
		err = e
	}
	if err != nil {
		l.failure = err
		return 0, err
	}
	return len(bytes), nil
}
func (l *runtimeLog) rotate(file string) error {
	for i := 5; i >= 1; i-- {
		dest := filepath.Join(l.root, fmt.Sprintf("runtime-start.%d.log", i))
		src := file
		if i > 1 {
			src = filepath.Join(l.root, fmt.Sprintf("runtime-start.%d.log", i-1))
		}
		for _, p := range []string{src, dest} {
			if err := library.NoLinks(p); err != nil {
				return err
			}
		}
		if _, err := os.Lstat(dest); err == nil {
			if err = instance.Recycle(dest); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if _, err := os.Lstat(src); err == nil {
			if err = os.Rename(src, dest); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
func (l *runtimeLog) Err() error { l.mu.Lock(); defer l.mu.Unlock(); return l.failure }
func installLog(c instance.Config) (*runtimeLog, func()) {
	writer := &runtimeLog{root: c.LogsRoot}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(writer, nil)))
	return writer, func() { slog.SetDefault(previous) }
}
