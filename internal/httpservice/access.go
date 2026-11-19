package httpservice

import (
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/accesslog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

// Access history is not authorization: it can refuse a blocked public client,
// but no address (including localhost) grants management operations.
type access struct {
	rule           banRule
	windows        map[string]*accessWindow
	mu             sync.Mutex
	store          *accesslog.Store
	id             string
	enabled, dirty bool
	clients        map[string]reading.Row
	changed        map[string]reading.Row
	requests, bans []reading.Row
	cleared        bool
	clearRevision  uint64
	now            func() time.Time
	stop           chan struct{}
	done           chan struct{}
}

var clientID = instance.AccessClientID

func local(ip string) bool {
	if ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1" {
		return true
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addresses {
		host, _, err := net.ParseCIDR(a.String())
		if err == nil && host.String() == ip {
			return true
		}
	}
	return false
}
func count(value any) int64 {
	switch n := value.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		if n >= 0 && n <= 9007199254740991 && n == float64(int64(n)) {
			return int64(n)
		}
	}
	return 0
}
func today(t time.Time) int64 {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400
}
func validDays(value any) reading.Row {
	result := reading.Row{}
	if rows, ok := value.(map[string]any); ok {
		for k, v := range rows {
			if _, err := strconv.ParseInt(k, 10, 64); err != nil {
				continue
			}
			row, ok := v.(map[string]any)
			if !ok {
				continue
			}
			requests, errors := count(row["requests"]), count(row["errors"])
			if requests == 0 && row["requests"] != float64(0) && row["requests"] != int64(0) {
				continue
			}
			if errors == 0 && row["errors"] != float64(0) && row["errors"] != int64(0) {
				continue
			}
			result[k] = row
		}
	}
	return result
}
func newAccess(config instance.Config, now func() time.Time) (*access, error) {
	store, err := accesslog.Open(config.StateRoot, config.InstanceID)
	if err != nil {
		return nil, err
	}
	a := &access{rule: defaultBanRule(), windows: map[string]*accessWindow{}, store: store, id: config.InstanceID, enabled: true, clients: map[string]reading.Row{}, changed: map[string]reading.Row{}, now: now, stop: make(chan struct{}), done: make(chan struct{})}
	if err = a.load(); err != nil {
		return nil, errors.Join(err, store.Close())
	}
	go func() {
		defer close(a.done)
		timer := time.NewTicker(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-a.stop:
				return
			case <-timer.C:
				if err := a.flush(); err != nil {
					slog.Error("access history flush", "error", err)
				}
			}
		}
	}()
	return a, nil
}

func (a *access) load() error {
	saved, err := a.store.Load()
	if err != nil {
		return err
	}
	if len(saved.AutoBan) > 0 {
		if err = json.Unmarshal(saved.AutoBan, &a.rule); err != nil {
			return err
		}
	}
	if saved.Enabled != nil {
		a.enabled = *saved.Enabled
	}
	for _, c := range saved.Clients {
		ip, ok := c["address"].(string)
		if !ok || len(ip) > 64 || c["id"] != clientID(a.id, ip) {
			continue
		}
		c["local"], c["active"] = local(ip), int64(0)
		c["blocked"] = c["local"] != true && c["blocked"] == true
		if !slices.Contains([]string{"Browser", "Venera", "Other"}, stringValue(c["agent"])) {
			c["agent"] = "Other"
		}
		for _, k := range []string{"requests", "errors", "bytes", "lastSeenAtMs", "blockedUntilMs"} {
			c[k] = count(c[k])
		}
		c["days"] = validDays(c["days"])
		a.clients[stringValue(c["id"])] = c
	}
	return nil
}
func stringValue(v any) string { s, _ := v.(string); return s }
func category(p string) string {
	for _, k := range []string{"media", "thumbnails", "works", "authors", "tags", "files", "status", "health"} {
		if strings.HasPrefix(p, "/api/v1/"+k) {
			return k
		}
	}
	if p == "/venera-source.js" {
		return "venera-source"
	}
	if strings.HasPrefix(p, "/api/") {
		return "other-api"
	}
	return "page-or-asset"
}
func (a *access) begin(r *http.Request) (bool, func(int, int64)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if ip == "" {
		ip = "unknown"
	}
	id := clientID(a.id, ip)
	client := a.clients[id]
	if client == nil {
		agent := "Other"
		ua := strings.ToLower(r.UserAgent())
		if strings.Contains(ua, "venera") {
			agent = "Venera"
		} else if strings.Contains(ua, "mozilla") {
			agent = "Browser"
		}
		client = reading.Row{"id": id, "address": ip, "local": local(ip), "agent": agent, "requests": int64(0), "errors": int64(0), "active": int64(0), "bytes": int64(0), "blocked": false, "lastSeenAtMs": int64(0), "days": reading.Row{}}
		a.clients[id] = client
	}
	a.expireBan(client)
	a.checkBan(client, false)
	day := strconv.FormatInt(today(a.now()), 10)
	days := client["days"].(map[string]any)
	counter, ok := days[day].(map[string]any)
	if !ok {
		counter = reading.Row{"requests": int64(0), "errors": int64(0)}
		days[day] = counter
	}
	counter["requests"] = count(counter["requests"]) + 1
	client["requests"] = count(client["requests"]) + 1
	client["active"] = count(client["active"]) + 1
	client["lastSeenAtMs"] = a.now().UnixMilli()
	a.touch(client)
	revision := a.clearRevision
	started := time.Now()
	return !a.enabled || client["blocked"] != true, func(status int, bytes int64) {
		a.mu.Lock()
		defer a.mu.Unlock()
		client["active"] = count(client["active"]) - 1
		if revision != a.clearRevision {
			return
		}
		client["lastSeenAtMs"] = a.now().UnixMilli()
		if status >= 400 && status != 403 {
			a.checkBan(client, true)
		}
		if status >= 400 {
			client["errors"] = count(client["errors"]) + 1
			counter["errors"] = count(counter["errors"]) + 1
		}
		client["bytes"] = count(client["bytes"]) + bytes
		a.requests = append(a.requests, reading.Row{"atMs": a.now().UnixMilli(), "client": id, "method": r.Method, "resource": category(r.URL.Path), "status": status, "elapsedMs": time.Since(started).Milliseconds()})
		a.touch(client)
	}
}

func (a *access) touch(client reading.Row) {
	a.changed[stringValue(client["id"])] = client
}

func (a *access) flush() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.flushLocked()
}

func (a *access) flushLocked() error {
	if !a.dirty && len(a.changed) == 0 && len(a.requests) == 0 && len(a.bans) == 0 {
		return nil
	}
	clients := make([]reading.Row, 0, len(a.changed))
	for _, c := range a.changed {
		row := maps.Clone(c)
		row["active"] = 0
		clients = append(clients, row)
	}
	rule, err := json.Marshal(a.rule)
	if err != nil {
		return err
	}
	history := accesslog.History{InstanceID: a.id, Enabled: &a.enabled, AutoBan: rule, Clients: clients, Events: a.requests}
	if err = a.store.Save(history, a.bans, a.cleared, a.cleared); err != nil {
		return err
	}
	clear(a.changed)
	a.requests, a.bans = nil, nil
	a.dirty, a.cleared = false, false
	return nil
}
func (a *access) close() error {
	close(a.stop)
	<-a.done
	return errors.Join(a.flush(), a.store.Close())
}
