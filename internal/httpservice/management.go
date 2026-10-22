package httpservice

import (
	"context"
	"fmt"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

// SnapshotState is used only by the authenticated local control owner.
func (s *Server) SnapshotState(ctx context.Context) (reading.Row, error) {
	s.dataGate.RLock()
	defer s.dataGate.RUnlock()
	return s.state(ctx)
}
func (s *Server) ReplaceDataset(next *dataset.Dataset) error {
	s.dataGate.Lock()
	defer s.dataGate.Unlock()
	previous := s.data
	s.data = next
	return previous.Close()
}
func (s *Server) Access(operation string, input reading.Row) (any, error) {
	a := s.access
	a.mu.Lock()
	var result any
	var err error
	switch operation {
	case "access.read":
		days, filtered := input["days"]
		if filtered && days != float64(1) && days != float64(7) && days != float64(30) && days != 1 && days != 7 && days != 30 {
			err = fmt.Errorf("ACCESS_PERIOD_INVALID")
			break
		}
		clients := []reading.Row{}
		for _, c := range a.clients {
			view := reading.Row{}
			for k, v := range c {
				if k != "days" {
					view[k] = v
				}
			}
			if filtered {
				requests, errors := int64(0), int64(0)
				for day, v := range validDays(c["days"], today(a.now())) {
					var d int64
					fmt.Sscan(day, &d)
					if d >= today(a.now())-count(days)+1 {
						row := v.(map[string]any)
						requests += count(row["requests"])
						errors += count(row["errors"])
					}
				}
				view["requests"], view["errors"] = requests, errors
				if requests == 0 {
					continue
				}
			}
			clients = append(clients, view)
		}
		events := []reading.Row{}
		now := a.now()
		y, m, d := now.Date()
		since := time.Date(y, m, d-int(count(days)-1), 0, 0, 0, 0, now.Location()).UnixMilli()
		for _, e := range a.events {
			if !filtered || count(e["atMs"]) >= since {
				copy := reading.Row{}
				for k, v := range e {
					copy[k] = v
				}
				events = append(events, copy)
			}
		}
		result = reading.Row{"enabled": a.enabled, "clients": clients, "events": events, "privacy": "local instance only; events contain no addresses, URLs, queries or bodies; maximum 30 days / 256 clients / 200 events", "since": "persisted-history"}
	case "access.configure":
		value, ok := input["enabled"].(bool)
		if !ok {
			err = fmt.Errorf("ACCESS_SETTING_INVALID")
			break
		}
		a.enabled = value
		a.dirty = true
		result = reading.Row{"enabled": value}
	case "access.clear":
		a.events = []reading.Row{}
		clients := []reading.Row{}
		for _, c := range a.clients {
			if count(c["active"]) != 0 || c["blocked"] == true {
				clients = append(clients, c)
			}
		}
		a.clients = clients
		a.dirty = true
		result = reading.Row{"cleared": true}
	case "access.block":
		id, ok := input["id"].(string)
		if !ok {
			err = fmt.Errorf("CLIENT_CONTROL_FORBIDDEN")
			break
		}
		var client reading.Row
		for _, c := range a.clients {
			if c["id"] == id {
				client = c
				break
			}
		}
		if client == nil || client["local"] == true {
			err = fmt.Errorf("CLIENT_CONTROL_FORBIDDEN")
			break
		}
		client["blocked"] = input["blocked"] == true
		a.dirty = true
		result = reading.Row{"id": id, "blocked": client["blocked"]}
	default:
		err = fmt.Errorf("CONTROL_OPERATION_INVALID")
	}
	a.mu.Unlock()
	if err == nil && operation != "access.read" {
		err = a.flush()
	}
	return result, err
}
