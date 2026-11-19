package httpservice

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func TestFrozenAccessHistory(t *testing.T) {
	file := os.Getenv("GALLERY_HTTP_GOLDEN")
	if file == "" {
		t.Skip("frozen HTTP capture required")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Access []struct {
			Name            string
			Now             int64
			Saved, Expected reading.Row
			Requests        []struct {
				IP, Method, Path, Agent string
				Status                  int
				Bytes                   int64
				Allowed                 bool
				Flush                   bool
			}
		}
	}
	if err = json.Unmarshal(b, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Access) == 0 {
		t.Fatal("access oracle absent")
	}
	for _, c := range golden.Access {
		t.Run(c.Name, func(t *testing.T) {
			root, err := os.MkdirTemp(filepath.Dir(file), "AccessGo-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if !t.Failed() {
					if err := instance.RemoveOwned(root); err != nil {
						t.Error(err)
					}
				}
			})
			config := instance.Config{StateRoot: root, InstanceID: "synthetic-http"}
			if c.Saved != nil {
				if err := instance.WriteJSON(filepath.Join(root, "access-history.json"), c.Saved); err != nil {
					t.Fatal(err)
				}
			}
			a, err := newAccess(config, func() time.Time { return time.UnixMilli(c.Now) })
			if err != nil {
				t.Fatal(err)
			}
			for _, request := range c.Requests {
				r := httptest.NewRequest(request.Method, "http://localhost"+request.Path, nil)
				r.RemoteAddr = request.IP + ":1000"
				r.Header.Set("User-Agent", request.Agent)
				allowed, finish := a.begin(r)
				if allowed != request.Allowed {
					t.Errorf("blocking %s: Node %v Go %v", request.IP, request.Allowed, allowed)
				}
				if request.Flush {
					if err := a.flush(); err != nil {
						t.Fatal(err)
					}
				}
				finish(request.Status, request.Bytes)
			}
			if err = a.flush(); err != nil {
				t.Fatal(err)
			}
			persisted, err := a.store.Load()
			if err != nil {
				t.Fatal(err)
			}
			persisted.Events, err = a.store.Requests()
			if err != nil {
				t.Fatal(err)
			}
			if err = a.close(); err != nil {
				t.Fatal(err)
			}
			bytes, err := json.Marshal(persisted)
			if err != nil {
				t.Fatal(err)
			}
			var got reading.Row
			if err = json.Unmarshal(bytes, &got); err != nil {
				t.Fatal(err)
			}
			for _, event := range got["events"].([]any) {
				event.(map[string]any)["elapsedMs"] = float64(0)
			}
			equalJSON(t, c.Expected, got)
		})
	}
}

func TestAccessRetentionAndClear(t *testing.T) {
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	config := instance.Config{StateRoot: t.TempDir(), InstanceID: "retention-test"}
	const oldIP = "192.0.2.1"
	oldID := clientID(config.InstanceID, oldIP)
	day := fmt.Sprint(today(now))
	saved := reading.Row{
		"version": 1, "instanceId": config.InstanceID, "enabled": true,
		"clients": []reading.Row{{"id": oldID, "address": oldIP, "agent": "Other", "blocked": true,
			"lastSeenAtMs": now.UnixMilli(), "requests": 1, "errors": 0,
			"days": reading.Row{day: reading.Row{"requests": 1, "errors": 0}}}},
		"events": []reading.Row{{"client": oldID, "resource": "works", "method": "GET", "atMs": now.UnixMilli(), "status": 200}},
	}
	file := filepath.Join(config.StateRoot, "access-history.json")
	if err := instance.WriteJSON(file, saved); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}

	var clockMS atomic.Int64
	clockMS.Store(now.UnixMilli())
	clock := func() time.Time { return time.UnixMilli(clockMS.Load()).UTC() }
	a, err := newAccess(config, clock)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{access: a}
	now = now.AddDate(0, 3, 0)
	clockMS.Store(now.UnixMilli())
	for i := range 300 {
		req := httptest.NewRequest("GET", "http://localhost/", nil)
		req.RemoteAddr = fmt.Sprintf("198.18.%d.%d:1000", i/256, i%256)
		allowed, finished := a.begin(req)
		if !allowed {
			t.Fatal("new request rejected", i)
		}
		finished(200, 0)
	}
	if err := a.close(); err != nil {
		t.Fatal(err)
	}
	a, err = newAccess(config, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := a.close(); err != nil {
			t.Error(err)
		}
	}()
	s.access = a

	client := a.clients[oldID]
	if len(a.clients) != 301 || client["blocked"] != true || client["days"].(reading.Row)[day] == nil {
		t.Fatal("historical client, day, or active ban lost after restart")
	}
	for page := 1; page <= 7; page++ {
		raw, err := s.Access("access.read", reading.Row{"days": 0, "clientPage": page, "eventPage": page})
		if err != nil {
			t.Fatal(err)
		}
		snapshot := raw.(reading.Row)
		if len(snapshot["clients"].([]reading.Row)) != min(50, 301-(page-1)*50) || len(snapshot["events"].([]reading.Row)) != min(50, 301-(page-1)*50) {
			t.Fatal("historical records missing from page", page)
		}
	}
	if data, err := s.Access("access.read", reading.Row{"days": 30, "eventPage": 7}); err != nil || len(data.(reading.Row)["events"].([]reading.Row)) != 0 {
		t.Fatal("time filter included older request", err)
	}
	if _, err = s.Access("access.block", reading.Row{"id": oldID, "blocked": false}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Access("access.autoban", reading.Row{"enabled": true, "windowSeconds": 1, "maxRequests": 2, "maxErrors": 1, "banMinutes": 1}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "http://localhost/", nil)
	req.RemoteAddr = "192.0.2.1:1000"
	allowed, finish := a.begin(req)
	if !allowed {
		t.Fatal("request forbidden before auto-ban")
	}
	finish(404, 0)
	now = now.Add(2 * time.Minute)
	clockMS.Store(now.UnixMilli())
	allowed, finish = a.begin(req)
	if !allowed {
		t.Fatal("temporary ban did not expire")
	}
	for i := range 202 {
		_, err = s.Access("access.block", reading.Row{"id": oldID, "blocked": i%2 == 0})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.Access("access.clear", reading.Row{"confirm": true}); err != nil {
		t.Fatal(err)
	}
	finish(200, 0)
	response, err := s.Access("access.read", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := response.(reading.Row)
	if len(got["events"].([]reading.Row)) != 0 {
		t.Fatal("cleared in-flight request returned")
	}
	if got["moreBanEvents"] != true {
		t.Fatal("first page must indicate older ban records")
	}
	last, err := s.Access("access.read", reading.Row{"banPage": 5})
	if err != nil {
		t.Fatal(err)
	}
	bans := last.(reading.Row)["banEvents"].([]reading.Row)
	if len(bans) != 5 || bans[2]["action"] != "expired" || bans[3]["action"] != "automatic" || bans[4]["action"] != "manual-unblock" {
		t.Fatal("clear or expiry lost ban actions", bans)
	}
	if again, err := os.ReadFile(file); err != nil || string(again) != string(original) {
		t.Fatal("upgrade rewrote its recovery snapshot", err)
	}
}
