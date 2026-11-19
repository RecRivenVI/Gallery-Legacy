package legacy

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestMergeKeepsTargetSecurityAndDeduplicatesMappedEvents(t *testing.T) {
	now := time.Unix(1794180000, 0)
	at := now.UnixMilli()
	const address = "192.0.2.1"
	oldID := instance.AccessClientID("old", address)
	newID := instance.AccessClientID("new", address)
	event := row{"client": oldID, "method": "GET", "resource": "works", "status": int64(200), "atMs": at - 1, "elapsedMs": int64(5)}
	source := history{Version: 1, InstanceID: "old", Clients: []row{{"address": address, "id": oldID, "lastSeenAtMs": at - 1, "requests": int64(10), "agent": "Other"}}, Events: []row{event, event}}
	target := history{Version: 1, InstanceID: "new", AutoBan: json.RawMessage(`{"enabled":true}`), Clients: []row{{"address": address, "id": newID, "lastSeenAtMs": at, "requests": int64(21), "agent": "Browser", "blocked": true}}}
	once, err := mergeHistory(source, target)
	if err != nil {
		t.Fatal(err)
	}
	twice, err := mergeHistory(source, once)
	if err != nil || !reflect.DeepEqual(once, twice) {
		t.Fatal("repeat import changed target", err)
	}
	if len(once.Events) != 2 || once.Events[0]["client"] != newID || once.Clients[0]["requests"] != int64(21) || once.Clients[0]["agent"] != "Browser" || once.Clients[0]["blocked"] != true || string(once.AutoBan) != `{"enabled":true}` {
		t.Fatal("remapping or target protection failed")
	}
}

func TestMergeKeepsOldAndLargeHistories(t *testing.T) {
	source := history{Version: 1, InstanceID: "old"}
	target := history{Version: 1, InstanceID: "new"}
	for i := range 300 {
		h := &source
		if i%2 == 0 {
			h = &target
		}
		address := fmt.Sprintf("198.18.%d.%d", i/256, i%256)
		id := instance.AccessClientID(h.InstanceID, address)
		h.Clients = append(h.Clients, row{"address": address, "id": id, "lastSeenAtMs": int64(1)})
		h.Events = append(h.Events, row{"client": id, "method": "GET", "resource": "works", "status": int64(200), "atMs": int64(1)})
	}
	merged, err := mergeHistory(source, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Clients) != 300 || len(merged.Events) != 300 {
		t.Fatal("import lost clients or requests", len(merged.Clients), len(merged.Events))
	}
}
