package host

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

// Session has one manager parent, one service, and no detached children.
type Session struct {
	config         instance.Config
	options        Options
	manager        *control.Identity
	mu             sync.Mutex
	runtime        *Runtime
	cancel         context.CancelFunc
	done           chan error
	ctx            context.Context
	validationDone chan struct{}
	tasks          sync.WaitGroup
}

func ManagerIdentity() (*control.Identity, error) {
	id, err := control.ProcessIdentity(uint32(os.Getppid()))
	if err != nil {
		return nil, err
	}
	if id == nil {
		return nil, fmt.Errorf("MANAGER_REQUIRED")
	}
	name := strings.ToLower(filepath.Base(id.Exe))
	if name != "electron.exe" && name != "gallery.exe" {
		return nil, fmt.Errorf("MANAGER_REQUIRED")
	}
	info, err := os.Stdin.Stat()
	if err != nil || info.Mode()&os.ModeNamedPipe == 0 {
		return nil, fmt.Errorf("MANAGER_REQUIRED")
	}
	return id, nil
}

func (s *Session) start() (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runtime != nil {
		return s.runtime.handle(s.ctx, Row{"operation": "status"})
	}
	c, err := instance.Load(s.options.ConfigFile)
	if err != nil {
		return nil, err
	}
	s.config = c
	ctx, cancel := context.WithCancel(s.ctx)
	r := New(s.config, s.options)
	r.state["managerPid"] = s.manager.PID
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- r.Serve(ctx, func() { close(ready) }) }()
	select {
	case <-ready:
		s.runtime, s.cancel, s.done = r, cancel, done
		return r.handle(s.ctx, Row{"operation": "status"})
	case err := <-done:
		cancel()
		return nil, err
	}
}
func (s *Session) stop() (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runtime == nil {
		return Row{"state": "STOPPED"}, nil
	}
	s.cancel()
	err := <-s.done
	s.runtime, s.cancel, s.done = nil, nil, nil
	return Row{"state": "STOPPED"}, err
}
func (s *Session) command(command, op string, input Row) (any, error) {
	switch command {
	case "connection":
		return Connection(s.config), nil
	case "start":
		return s.start()
	case "stop":
		return s.stop()
	case "restart":
		if _, err := s.stop(); err != nil {
			return nil, err
		}
		return s.start()
	case "status":
		s.mu.Lock()
		r := s.runtime
		s.mu.Unlock()
		if r != nil {
			return r.handle(s.ctx, Row{"operation": "status"})
		}
		return New(s.config, s.options).View(), nil
	case "scan":
		op, command = "scan.start", "manage"
	}
	if command != "manage" {
		return nil, fmt.Errorf("COMMAND_INVALID")
	}
	c, err := instance.Load(s.options.ConfigFile)
	if err != nil {
		return nil, err
	}
	if op == "validation.start" {
		return s.startValidation(c, input)
	}
	if op == "scan.start" {
		s.mu.Lock()
		r := s.runtime
		s.mu.Unlock()
		if r == nil {
			return nil, fmt.Errorf("RUNTIME_OFFLINE")
		}
		return r.startScan(input)
	}
	return Manage(s.ctx, c, s.options, op, input)
}

// RunSession accepts commands only through the manager's inherited pipe. EOF
// and a verified parent exit take the same orderly shutdown path as Quit.
func RunSession(ctx context.Context, c instance.Config, o Options, manager *control.Identity, input io.Reader, output io.Writer) (err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err = task.Layout(c); err != nil {
		return err
	}
	for _, name := range []string{"TEMP", "TMP", "SQLITE_TMPDIR"} {
		if err = os.Setenv(name, c.TempRoot); err != nil {
			return err
		}
	}
	log, restoreLog := installLog(c)
	defer restoreLog()
	defer func() { err = errors.Join(err, log.Err()) }()
	lease, err := control.Acquire(c, "manager", nil)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Close()) }()
	s := &Session{config: c, options: o, manager: manager, ctx: ctx}
	defer func() { cancel(); _, e := s.stop(); s.tasks.Wait(); err = errors.Join(err, e) }()
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				actual, e := control.ProcessIdentity(manager.PID)
				if e != nil || !control.Same(actual, manager) {
					cancel()
					return
				}
			}
		}
	}()
	lines := make(chan []byte)
	readError := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 1048576)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		readError <- scanner.Err()
		cancel()
	}()
	encoder := json.NewEncoder(output)
	if err = encoder.Encode(Row{"event": "manager-ready", "pid": os.Getpid(), "instanceId": c.InstanceID, "manager": manager}); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			select {
			case e := <-readError:
				return e
			default:
				return nil
			}
		case line := <-lines:
			var request struct {
				ID        int64           `json:"id"`
				Command   string          `json:"command"`
				Operation string          `json:"operation"`
				Input     json.RawMessage `json:"input"`
			}
			if json.Unmarshal(line, &request) != nil {
				return fmt.Errorf("MANAGEMENT_INPUT_INVALID")
			}
			input := Row{}
			var value any
			var e error
			if len(request.Input) > 262144 {
				e = fmt.Errorf("MANAGEMENT_INPUT_TOO_LARGE")
			} else if len(request.Input) > 0 && (json.Unmarshal(request.Input, &input) != nil || input == nil) {
				e = fmt.Errorf("MANAGEMENT_INPUT_INVALID")
			}
			if e == nil {
				value, e = s.command(request.Command, request.Operation, input)
			}
			reply := Row{"id": request.ID, "ok": e == nil, "data": value}
			if e != nil {
				reply["code"] = control.Code(e, "MANAGEMENT_FAILED")
			}
			if err = encoder.Encode(reply); err != nil {
				return err
			}
		}
	}
}
