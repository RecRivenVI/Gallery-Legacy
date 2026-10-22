package control

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/google/uuid"
)

type Row = map[string]any
type Record struct {
	Kind       string    `json:"kind"`
	InstanceID string    `json:"instanceId"`
	Identity   *Identity `json:"identity"`
	Token      string    `json:"token"`
	TaskID     string    `json:"taskId,omitempty"`
}
type Lease struct {
	Record
	Recovered   bool
	listener    net.Listener
	file        string
	mu          sync.Mutex
	closing     bool
	connections map[net.Conn]bool
	wg          sync.WaitGroup
	done        chan struct{}
}

func ReadJSON(file string, value any) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(b, value); err != nil {
		return fmt.Errorf("STATE_INVALID: %w", err)
	}
	return nil
}

var codePattern = regexp.MustCompile(`^[A-Z0-9_]{1,64}$`)

func Code(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	text := err.Error()
	for n, c := range text {
		if c == ':' {
			text = text[:n]
			break
		}
	}
	if codePattern.MatchString(text) {
		return text
	}
	return fallback
}

func Owner(c instance.Config, scope string) (*Record, error) {
	var r Record
	err := ReadJSON(filepath.Join(c.StateRoot, scope+".lock"), &r)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.InstanceID != c.InstanceID || r.Identity == nil || r.Token == "" {
		return nil, fmt.Errorf("OWNER_UNVERIFIABLE")
	}
	actual, err := ProcessIdentity(r.Identity.PID)
	if err != nil {
		return nil, err
	}
	if Same(actual, r.Identity) {
		return &r, nil
	}
	return nil, nil
}

func Acquire(c instance.Config, scope string, handler func(context.Context, Row) (any, error)) (*Lease, error) {
	valid := false
	for _, s := range []string{"runtime", "scan", "scan-launch", "maintenance", "validation", "validation-launch", "manager", "manager-test"} {
		if s == scope {
			valid = true
		}
	}
	if !valid {
		return nil, fmt.Errorf("OWNER_INVALID")
	}
	id, err := ProcessIdentity(uint32(os.Getpid()))
	if err != nil {
		return nil, err
	}
	l, err := winio.ListenPipe(Pipe(c.InstanceRoot, scope), nil)
	if err != nil {
		return nil, fmt.Errorf("INSTANCE_IN_USE: %w", err)
	}
	lease := &Lease{Record: Record{Kind: scope, InstanceID: c.InstanceID, Identity: id, Token: uuid.NewString()}, listener: l, file: filepath.Join(c.StateRoot, scope+".lock"), connections: map[net.Conn]bool{}, done: make(chan struct{})}
	var previous Record
	err = ReadJSON(lease.file, &previous)
	if err == nil {
		if previous.Identity == nil || previous.Token == "" {
			err = fmt.Errorf("OWNER_UNVERIFIABLE")
		} else {
			var actual *Identity
			actual, err = ProcessIdentity(previous.Identity.PID)
			if err == nil && Same(actual, previous.Identity) {
				err = fmt.Errorf("INSTANCE_IN_USE")
			}
			lease.Recovered = err == nil
		}
	} else if os.IsNotExist(err) {
		err = nil
	}
	if err == nil {
		err = instance.WriteJSON(lease.file, lease.Record)
	}
	if err != nil {
		l.Close()
		return nil, err
	}
	go lease.accept(handler)
	return lease, nil
}
func (l *Lease) accept(handler func(context.Context, Row) (any, error)) {
	defer close(l.done)
	for {
		conn, err := l.listener.Accept()
		if err != nil {
			return
		}
		l.mu.Lock()
		if l.closing {
			l.mu.Unlock()
			conn.Close()
			return
		}
		l.connections[conn] = true
		l.wg.Add(1)
		l.mu.Unlock()
		go func() {
			defer l.wg.Done()
			defer func() { conn.Close(); l.mu.Lock(); delete(l.connections, conn); l.mu.Unlock() }()
			l.serve(conn, handler)
		}()
	}
}

// A task goroutine can end while the host PID stays alive. Bind the existing
// task ID to its scope lease so status does not mistake host life for task life.
func (l *Lease) BindTask(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.TaskID = id
	return instance.WriteJSON(l.file, l.Record)
}
func (l *Lease) serve(conn net.Conn, handler func(context.Context, Row) (any, error)) {
	if handler == nil {
		return
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(io.LimitReader(conn, 4097))
	line, err := reader.ReadBytes('\n')
	if err != nil || len(line) > 4096 {
		return
	}
	var request Row
	err = json.Unmarshal(line, &request)
	var data any
	if err == nil && request["instanceId"] == l.InstanceID && request["token"] == l.Token {
		data, err = handler(context.Background(), request)
	} else {
		err = fmt.Errorf("CONTROL_FORBIDDEN")
	}
	response := Row{"ok": true, "instanceId": l.InstanceID, "identity": l.Identity, "data": data}
	if err != nil {
		response = Row{"ok": false, "code": Code(err, "CONTROL_FORBIDDEN")}
	}
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if json.NewEncoder(conn).Encode(response) == nil {
		if pipe, ok := conn.(winio.PipeConn); ok {
			pipe.Flush()
		}
	}
}
func (l *Lease) Close() error {
	l.mu.Lock()
	if l.closing {
		l.mu.Unlock()
		return nil
	}
	l.closing = true
	for c := range l.connections {
		c.Close()
	}
	l.mu.Unlock()
	err := l.listener.Close()
	<-l.done
	l.wg.Wait()
	var current Record
	if readErr := ReadJSON(l.file, &current); readErr == nil && current.Token == l.Token {
		err = errors.Join(err, instance.Recycle(l.file))
	} else if readErr != nil && !os.IsNotExist(readErr) {
		err = errors.Join(err, readErr)
	}
	return err
}

func Call(ctx context.Context, c instance.Config, operation string, args Row) (any, error) {
	r, err := Owner(c, "runtime")
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fmt.Errorf("RUNTIME_OFFLINE")
	}
	if operation == "status" {
		var s Row
		if ReadJSON(c.StatusPath, &s) == nil && s["state"] == "STARTING" && s["pid"] == float64(r.Identity.PID) {
			s["localControl"] = true
			s["pending"] = true
			return s, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := winio.DialPipeContext(ctx, Pipe(c.InstanceRoot, "runtime"))
	if err != nil {
		return nil, fmt.Errorf("CONTROL_UNAVAILABLE: %w", err)
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	conn.SetDeadline(deadline)
	request := Row{}
	for k, v := range args {
		request[k] = v
	}
	request["operation"] = operation
	request["instanceId"] = c.InstanceID
	request["token"] = r.Token
	if err = json.NewEncoder(conn).Encode(request); err != nil {
		return nil, fmt.Errorf("CONTROL_UNAVAILABLE: %w", err)
	}
	var response struct {
		OK         bool      `json:"ok"`
		Code       string    `json:"code"`
		InstanceID string    `json:"instanceId"`
		Identity   *Identity `json:"identity"`
		Data       any       `json:"data"`
	}
	b, err := io.ReadAll(io.LimitReader(conn, 1048577))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("CONTROL_TIMEOUT")
		}
		return nil, fmt.Errorf("CONTROL_UNAVAILABLE: %w", err)
	}
	if len(b) > 1048576 {
		return nil, fmt.Errorf("CONTROL_UNAVAILABLE")
	}
	if err = json.Unmarshal(b, &response); err != nil {
		return nil, err
	}
	if !response.OK {
		if codePattern.MatchString(response.Code) {
			return nil, fmt.Errorf("%s", response.Code)
		}
		return nil, fmt.Errorf("CONTROL_FAILED")
	}
	if response.InstanceID != c.InstanceID || !Same(response.Identity, r.Identity) {
		return nil, fmt.Errorf("OWNER_MISMATCH")
	}
	return response.Data, nil
}
