package httpservice

import (
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

const accessPageSize = 50

func (s *Server) Access(operation string, input reading.Row) (any, error) {
	a := s.access
	a.mu.Lock()
	defer a.mu.Unlock()
	var result any
	switch operation {
	case "access.read":
		return a.view(input)
	case "access.autoban":
		if err := a.configureBan(input); err != nil {
			return nil, err
		}
		result = a.rule
	case "access.configure":
		value, ok := input["enabled"].(bool)
		if !ok {
			return nil, fmt.Errorf("ACCESS_SETTING_INVALID")
		}
		a.enabled, a.dirty = value, true
		result = reading.Row{"enabled": value}
	case "access.clear":
		if input["confirm"] != true {
			return nil, fmt.Errorf("CONFIRMATION_REQUIRED")
		}
		a.clearRequests()
		result = reading.Row{"cleared": true}
	case "access.block":
		client := a.clients[stringValue(input["id"])]
		if client == nil || client["local"] == true {
			return nil, fmt.Errorf("CLIENT_CONTROL_FORBIDDEN")
		}
		a.expireBan(client)
		action := "manual-unblock"
		blocked := input["blocked"] == true
		if blocked {
			action = "manual-block"
		}
		a.changeBan(client, blocked, 0, action, a.now().UnixMilli())
		result = reading.Row{"id": client["id"], "blocked": blocked}
	default:
		return nil, fmt.Errorf("CONTROL_OPERATION_INVALID")
	}
	return result, a.flushLocked()
}

func (a *access) clearRequests() {
	a.requests = nil
	a.clearRevision++
	a.cleared, a.dirty = true, true
	clear(a.windows)
	clear(a.changed)
	for id, c := range a.clients {
		a.expireBan(c)
		if count(c["active"]) != 0 || c["blocked"] == true {
			c["requests"], c["errors"], c["bytes"] = int64(0), int64(0), int64(0)
			c["days"] = reading.Row{}
			a.touch(c)
		} else {
			delete(a.clients, id)
			delete(a.changed, id)
		}
	}
}

func accessPage(value any) int64 {
	p := count(value)
	if p < 1 || p > (1<<53-1)/accessPageSize {
		return 1
	}
	return p
}

func (a *access) view(input reading.Row) (reading.Row, error) {
	value := input["days"]
	switch value {
	case nil, 0, 1, 7, 30, float64(0), float64(1), float64(7), float64(30):
	default:
		return nil, fmt.Errorf("ACCESS_PERIOD_INVALID")
	}
	now, days := a.now(), count(value)
	clients := a.filteredClients(now, days)
	pages := int64(max(1, (len(clients)+accessPageSize-1)/accessPageSize))
	page := min(accessPage(input["clientPage"]), pages)
	start := (page - 1) * accessPageSize
	data := reading.Row{
		"enabled": a.enabled, "autoBan": a.rule,
		"clients":    clients[start:min(start+accessPageSize, int64(len(clients)))],
		"clientPage": page, "clientPages": pages,
		"privacy": "local instance only; request events contain no addresses, URLs, queries or bodies",
		"since":   "persisted-history",
	}
	if input["includeEvents"] == false {
		return data, nil
	}
	if err := a.flushLocked(); err != nil {
		return nil, err
	}
	var since int64
	if days != 0 {
		y, m, d := now.Date()
		since = time.Date(y, m, d-int(days-1), 0, 0, 0, 0, now.Location()).UnixMilli()
	}
	for _, kind := range []struct{ kind, rows, page, more string }{
		{"request", "events", "eventPage", "moreEvents"},
		{"ban", "banEvents", "banPage", "moreBanEvents"},
	} {
		rows, more, err := a.store.Events(kind.kind, since, accessPage(input[kind.page]), accessPageSize)
		if err != nil {
			return nil, err
		}
		data[kind.rows], data[kind.more] = rows, more
	}
	return data, nil
}

func (a *access) filteredClients(now time.Time, days int64) []reading.Row {
	clients := make([]reading.Row, 0, len(a.clients))
	day := today(now)
	dayKeys := make([]string, 0, days)
	for i := range days {
		dayKeys = append(dayKeys, strconv.FormatInt(day-i, 10))
	}
	for _, c := range a.clients {
		a.expireBan(c)
		view := maps.Clone(c)
		delete(view, "days")
		if days > 0 {
			requests, errors := int64(0), int64(0)
			daily := c["days"].(reading.Row)
			for _, key := range dayKeys {
				counter, _ := daily[key].(reading.Row)
				requests += count(counter["requests"])
				errors += count(counter["errors"])
			}
			view["requests"], view["errors"] = requests, errors
			if requests == 0 && c["blocked"] != true {
				continue
			}
		}
		clients = append(clients, view)
	}
	slices.SortFunc(clients, func(a, b reading.Row) int {
		if a["blocked"] != b["blocked"] {
			if a["blocked"] == true {
				return -1
			}
			return 1
		}
		if at, bt := count(a["lastSeenAtMs"]), count(b["lastSeenAtMs"]); at != bt {
			if at > bt {
				return -1
			}
			return 1
		}
		return strings.Compare(stringValue(a["id"]), stringValue(b["id"]))
	})
	return clients
}
