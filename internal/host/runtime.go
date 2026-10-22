package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/control"
	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/httpservice"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/task"
)

type Runtime struct {
	config     instance.Config
	options    Options
	mu         sync.Mutex
	state      Row
	owner      *control.Lease
	server     *httpservice.Server
	http       *http.Server
	stop       chan struct{}
	stopOnce   sync.Once
	ctx        context.Context
	scanDone   chan struct{}
	tasks      sync.WaitGroup
	applyID    any
	applyRetry time.Time
}

func New(c instance.Config, o Options) *Runtime {
	return &Runtime{config: c, options: o, stop: make(chan struct{}), state: Row{"instanceId": c.InstanceID, "deployment": c.Deployment, "liveUpdates": c.LiveUpdates, "state": "STOPPED", "pid": os.Getpid(), "managerPid": nil, "loadedGenerationId": nil, "startedAtMs": nil}}
}
func (r *Runtime) persist() error {
	r.mu.Lock()
	s := Row{}
	for k, v := range r.state {
		s[k] = v
	}
	r.mu.Unlock()
	s["updatedAtMs"] = time.Now().UnixMilli()
	return instance.WriteJSON(r.config.StatusPath, s)
}
func (r *Runtime) requestStop() { r.stopOnce.Do(func() { close(r.stop) }) }
func (r *Runtime) View() Row {
	r.mu.Lock()
	s := Row{}
	for k, v := range r.state {
		s[k] = v
	}
	r.mu.Unlock()
	scan, err := task.State(r.config)
	if err != nil {
		scan = Row{"state": "FAILED", "running": false, "failure": Row{"code": control.Code(err, "SCAN_STATUS_INVALID")}}
	}
	delete(scan, "identity")
	if scope, ok := scan["scope"].(map[string]any); ok {
		scan["scope"] = Row{"platformId": scope["platformId"], "platformIds": scope["requestedPlatformIds"], "authorScoped": scope["authorDirectoryName"] != nil, "invalidatedPlatformIds": []string{}, "effectivePlatformIds": scope["effectivePlatformIds"]}
	}
	s["scan"] = scan
	var pointer Row
	_ = control.ReadJSON(r.config.ActiveGenerationPath, &pointer)
	s["activeGenerationId"] = pointer["generationId"]
	s["restartRequired"] = pointer["generationId"] != nil && pointer["generationId"] != s["loadedGenerationId"]
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	s["memory"] = Row{"rss": residentMemory(), "heapUsed": memory.HeapAlloc}
	s["sourceWriteAttempts"] = 0
	items := []Row{}
	entries, _ := os.ReadDir(r.config.GenerationsRoot)
	for _, entry := range entries {
		var m Row
		if control.ReadJSON(filepath.Join(r.config.GenerationsRoot, entry.Name(), "manifest.json"), &m) == nil {
			catalog, _ := m["catalog"].(map[string]any)
			items = append(items, Row{"id": m["generationId"], "state": m["state"], "works": catalog["workCount"], "createdAtMs": m["createdAtMs"]})
		}
	}
	s["generations"] = items
	return s
}
func (r *Runtime) handle(ctx context.Context, request Row) (any, error) {
	op, _ := request["operation"].(string)
	switch op {
	case "status":
		r.mu.Lock()
		server := r.server
		r.mu.Unlock()
		var s Row
		var err error
		if server != nil {
			s, err = server.SnapshotState(ctx)
		} else {
			s = r.View()
		}
		if err != nil {
			return nil, err
		}
		s["localControl"] = true
		return s, err
	case "manager", "stop", "scan":
		return nil, fmt.Errorf("MANAGER_REQUIRED")
	case "access.read", "access.configure", "access.clear", "access.block":
		r.mu.Lock()
		server := r.server
		r.mu.Unlock()
		if server == nil {
			return nil, fmt.Errorf("RUNTIME_OFFLINE")
		}
		return server.Access(op, request)
	}
	return nil, fmt.Errorf("CONTROL_OPERATION_INVALID")
}
func (r *Runtime) Serve(ctx context.Context, ready func()) (err error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.ctx = ctx
	r.mu.Unlock()
	c := r.config
	if err = task.Layout(c); err != nil {
		return err
	}
	r.owner, err = control.Acquire(c, "runtime", r.handle)
	if err != nil {
		return err
	}
	defer func() {
		if e := r.owner.Close(); e != nil {
			err = errors.Join(err, e)
		}
	}()
	var previous Row
	_ = control.ReadJSON(c.StatusPath, &previous)
	r.mu.Lock()
	r.state["state"] = "STARTING"
	r.state["recovered"] = r.owner.Recovered || previous["state"] == "READY"
	r.state["startedAtMs"] = time.Now().UnixMilli()
	r.mu.Unlock()
	if err = r.persist(); err != nil {
		return err
	}
	if err = task.Prepare(ctx, c); err == nil {
		var d *dataset.Dataset
		d, err = dataset.Load(ctx, r.options.ConfigFile)
		if err == nil {
			var server *httpservice.Server
			server, err = httpservice.New(d, httpservice.Options{Frontend: r.options.Frontend, Assets: r.options.Assets, Status: r.View})
			if err != nil {
				d.Close()
			} else {
				r.mu.Lock()
				r.server = server
				r.state["loadedGenerationId"] = nil
				if d.Generation != nil {
					r.state["loadedGenerationId"] = d.Generation.GenerationID
				}
				r.mu.Unlock()
			}
		}
	}
	if err != nil {
		return r.failed(err)
	}
	defer func() { cancel(); r.tasks.Wait(); err = errors.Join(err, r.server.Close()) }()
	listener, err := net.Listen("tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if err != nil {
		return r.failed(fmt.Errorf("EADDRINUSE: %w", err))
	}
	r.http = &http.Server{Handler: r.server}
	serving := make(chan error, 1)
	go func() { serving <- r.http.Serve(listener) }()
	r.mu.Lock()
	r.state["state"] = "READY"
	r.mu.Unlock()
	if err = r.persist(); err != nil {
		r.http.Close()
		return err
	}
	ready()
	slog.Info("服务已启动", "event", "ready")
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			r.requestStop()
		case <-r.stop:
			r.mu.Lock()
			r.state["state"] = "STOPPING"
			r.mu.Unlock()
			if err = r.persist(); err != nil {
				return err
			}
			cancel()
			r.tasks.Wait()
			stopCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			e := r.http.Shutdown(stopCtx)
			cancel()
			if e != nil {
				r.http.Close()
				return e
			}
			r.mu.Lock()
			r.state["state"] = "STOPPED"
			r.state["managerPid"] = nil
			r.mu.Unlock()
			slog.Info("服务已停止", "event", "stopped")
			return r.persist()
		case e := <-serving:
			if !errors.Is(e, http.ErrServerClosed) {
				return e
			}
		case <-ticker.C:
			r.apply(ctx)
		}
	}
}
func (r *Runtime) failed(err error) error {
	r.mu.Lock()
	r.state["state"] = "FAILED"
	r.state["error"] = Row{"code": control.Code(err, "START_FAILED")}
	r.mu.Unlock()
	return errors.Join(err, r.persist())
}
func (r *Runtime) apply(ctx context.Context) {
	var pointer Row
	if control.ReadJSON(r.config.ActiveGenerationPath, &pointer) != nil {
		return
	}
	r.mu.Lock()
	loaded := r.state["loadedGenerationId"]
	backoff := pointer["generationId"] == r.applyID && time.Now().Before(r.applyRetry)
	r.mu.Unlock()
	if pointer["generationId"] == nil || pointer["generationId"] == loaded || backoff {
		return
	}
	s, err := task.State(r.config)
	if err != nil || s["running"] == true {
		return
	}
	lease, err := control.Acquire(r.config, "maintenance", nil)
	if err != nil {
		return
	}
	defer func() {
		if e := lease.Close(); e != nil {
			r.applyError(e)
		}
	}()
	r.mu.Lock()
	r.applyID = pointer["generationId"]
	r.state["applyingGenerationId"] = pointer["generationId"]
	r.mu.Unlock()
	// Live databases are never replaced while open. A changed recovery base must
	// be applied by the explicit restart path, as in the frozen Node host.
	if r.config.LiveUpdates {
		r.applyError(fmt.Errorf("LIVE_RESTART_REQUIRED"))
		return
	}
	next, err := dataset.Load(ctx, r.options.ConfigFile)
	if err != nil {
		r.applyError(err)
		return
	}
	var now Row
	if control.ReadJSON(r.config.ActiveGenerationPath, &now) != nil || now["generationId"] != pointer["generationId"] {
		next.Close()
		r.applyError(fmt.Errorf("GENERATION_APPLY_STALE"))
		return
	}
	if err = r.server.ReplaceDataset(next); err != nil {
		r.applyError(err)
		return
	}
	r.mu.Lock()
	r.state["loadedGenerationId"] = next.Generation.GenerationID
	r.state["applyError"] = nil
	r.state["applyingGenerationId"] = nil
	r.applyRetry = time.Time{}
	r.mu.Unlock()
	if err = r.persist(); err != nil {
		r.applyError(err)
	}
}
func (r *Runtime) applyError(err error) {
	r.mu.Lock()
	r.state["applyError"] = Row{"code": control.Code(err, "GENERATION_APPLY_FAILED")}
	r.state["applyingGenerationId"] = nil
	r.applyRetry = time.Now().Add(30 * time.Second)
	r.mu.Unlock()
}
func stringsJSON(value any) string { b, _ := json.Marshal(value); return string(b) }
