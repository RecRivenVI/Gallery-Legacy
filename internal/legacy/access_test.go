package legacy

import (
	"encoding/json"
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
	once, err := mergeHistory(source, target, now)
	if err != nil {
		t.Fatal(err)
	}
	twice, err := mergeHistory(source, once, now)
	if err != nil || !reflect.DeepEqual(once, twice) {
		t.Fatal("repeat import changed target", err)
	}
	if len(once.Events) != 2 || once.Events[0]["client"] != newID || once.Clients[0]["requests"] != int64(21) || once.Clients[0]["agent"] != "Browser" || once.Clients[0]["blocked"] != true || string(once.AutoBan) != `{"enabled":true}` {
		t.Fatal("remapping or target protection failed")
	}
}
