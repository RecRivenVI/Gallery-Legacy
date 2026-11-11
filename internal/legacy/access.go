package legacy

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

type row = map[string]any

type history struct {
	Version    int             `json:"version"`
	InstanceID string          `json:"instanceId"`
	Enabled    *bool           `json:"enabled,omitempty"`
	AutoBan    json.RawMessage `json:"autoBan,omitempty"`
	Clients    []row           `json:"clients"`
	Events     []row           `json:"events"`
}

func parseHistory(b []byte, target string) (history, error) {
	if len(b) == 0 && target != "" {
		return history{Version: 1, InstanceID: target}, nil
	}
	var h history
	if err := json.Unmarshal(b, &h); err != nil {
		return h, err
	}
	if h.Version != 1 || h.InstanceID == "" || target != "" && h.InstanceID != target {
		return h, errors.New("LEGACY_ACCESS_IDENTITY_INVALID")
	}
	return h, nil
}

func intValue(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	}
	return 0
}

var accessCategory = regexp.MustCompile(`^[a-z-]+$`)

type eventKey struct {
	client, method, resource string
	at, status, elapsed      int64
}

func accessEvent(r row, id string) (eventKey, bool) {
	method, _ := r["method"].(string)
	resource, _ := r["resource"].(string)
	k := eventKey{id, method, resource, intValue(r["atMs"]), intValue(r["status"]), intValue(r["elapsedMs"])}
	return k, id != "" && k.at > 0 && k.status >= 100 && k.status <= 599 && k.elapsed >= 0 && accessCategory.MatchString(resource) && slices.Contains([]string{"GET", "HEAD", "POST", "OPTIONS"}, method)
}

func mergeHistory(source, target history, now time.Time) (history, error) {
	if source.InstanceID == target.InstanceID {
		return target, errors.New("LEGACY_ACCESS_TARGET_EQUALS_SOURCE")
	}
	clients := map[string]row{}
	targetIDs := map[string]bool{}
	for _, c := range target.Clients {
		id, err := accessIdentity(target.InstanceID, c)
		if err != nil {
			return target, err
		}
		clients[id], targetIDs[id] = c, true
	}
	mapping := map[string]string{}
	for _, old := range source.Clients {
		oldID, err := accessIdentity(source.InstanceID, old)
		if err != nil {
			return target, err
		}
		if intValue(old["lastSeenAtMs"]) < now.Add(-30*24*time.Hour).UnixMilli() {
			continue
		}
		address := old["address"].(string)
		id := instance.AccessClientID(target.InstanceID, address)
		mapping[oldID] = id
		current := clients[id]
		if current == nil {
			days, _ := old["days"].(map[string]any)
			if days == nil {
				days = row{}
			}
			clients[id] = row{"id": id, "address": address, "local": old["local"], "agent": old["agent"], "active": 0, "blocked": false, "blockedUntilMs": 0, "requests": old["requests"], "errors": old["errors"], "bytes": old["bytes"], "lastSeenAtMs": old["lastSeenAtMs"], "days": days}
			continue
		}
		if intValue(old["lastSeenAtMs"]) > intValue(current["lastSeenAtMs"]) {
			current["lastSeenAtMs"], current["agent"] = old["lastSeenAtMs"], old["agent"]
		}
		// These snapshots contain overlapping lifetime counters without a
		// shared event ledger. Maxima preserve both histories without adding
		// the same source snapshot on a repeat import.
		for _, name := range []string{"requests", "errors", "bytes"} {
			current[name] = max(intValue(current[name]), intValue(old[name]))
		}
		days, _ := current["days"].(map[string]any)
		if days == nil {
			days = row{}
		}
		if other, ok := old["days"].(map[string]any); ok {
			for day, counters := range other {
				if _, present := days[day]; !present {
					days[day] = counters
				}
			}
		}
		current["days"] = days
	}
	target.Clients = make([]row, 0, len(clients))
	for _, c := range clients {
		target.Clients = append(target.Clients, c)
	}
	slices.SortFunc(target.Clients, func(a, b row) int {
		ai, bi := a["id"].(string), b["id"].(string)
		// Existing target records have priority over imported-only clients.
		if targetIDs[ai] != targetIDs[bi] {
			if targetIDs[ai] {
				return -1
			}
			return 1
		}
		at, bt := intValue(a["lastSeenAtMs"]), intValue(b["lastSeenAtMs"])
		if at != bt {
			if at > bt {
				return -1
			}
			return 1
		}
		return strings.Compare(ai, bi)
	})
	target.Clients = target.Clients[:min(256, len(target.Clients))]
	kept := map[string]bool{}
	for _, c := range target.Clients {
		kept[c["id"].(string)] = true
	}
	existing := map[eventKey]int{}
	events := make([]row, 0, len(target.Events)+len(source.Events))
	for _, e := range target.Events {
		id, _ := e["client"].(string)
		if key, ok := accessEvent(e, id); ok && kept[id] {
			existing[key]++
			events = append(events, e)
		}
	}
	for _, e := range source.Events {
		oldID, _ := e["client"].(string)
		id := mapping[oldID]
		if key, ok := accessEvent(e, id); ok && kept[id] {
			if existing[key] > 0 {
				existing[key]--
				continue
			}
			events = append(events, row{"client": id, "method": key.method, "resource": key.resource, "status": key.status, "atMs": key.at, "elapsedMs": key.elapsed})
		}
	}
	slices.SortStableFunc(events, func(a, b row) int {
		at, bt := intValue(a["atMs"]), intValue(b["atMs"])
		if at < bt {
			return -1
		}
		if at > bt {
			return 1
		}
		return 0
	})
	target.Events = events[max(0, len(events)-200):]
	return target, nil
}

func accessIdentity(instanceID string, c row) (string, error) {
	address, ok := c["address"].(string)
	if !ok || address == "" || len(address) > 64 {
		return "", errors.New("LEGACY_ACCESS_ADDRESS_INVALID")
	}
	id := instance.AccessClientID(instanceID, address)
	if c["id"] != id {
		return "", fmt.Errorf("LEGACY_ACCESS_CLIENT_ID_INVALID")
	}
	return id, nil
}
