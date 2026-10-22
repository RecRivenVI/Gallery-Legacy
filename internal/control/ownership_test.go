package control

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func fixture(t *testing.T) instance.Config {
	t.Helper()
	root := os.Getenv("GALLERY_CONTROL_ROOT")
	if root == "" {
		t.Skip("explicit synthetic GALLERY_CONTROL_ROOT required")
	}
	p, err := os.MkdirTemp(root, "Owner-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := instance.Recycle(p); e != nil {
			t.Error(e)
		}
	})
	c := instance.Config{InstanceRoot: p, StateRoot: filepath.Join(p, "state"), InstanceID: "synthetic-owner", StatusPath: filepath.Join(p, "state", "runtime.json")}
	if err = os.MkdirAll(c.StateRoot, 0700); err != nil {
		t.Fatal(err)
	}
	return c
}
func TestIdentityAndAuthenticatedOwnership(t *testing.T) {
	c := fixture(t)
	id, err := ProcessIdentity(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	node, reference := os.Getenv("GALLERY_NODE"), os.Getenv("GALLERY_NODE_REFERENCE_ROOT")
	if node == "" || reference == "" {
		t.Fatal("frozen Node identity oracle required")
	}
	script := `const o=require(process.argv[1]);console.log(JSON.stringify({identity:o.processIdentity(Number(process.argv[2])),pipe:o.pipeName({instanceRoot:process.argv[3]})}));`
	b, err := exec.Command(node, "-e", script, filepath.Join(reference, "src/instance/ownership.js"), fmt.Sprint(os.Getpid()), c.InstanceRoot).CombinedOutput()
	if err != nil {
		t.Fatalf("identity oracle: %s %v", b, err)
	}
	var oracle struct {
		Identity *Identity
		Pipe     string
	}
	if err = json.Unmarshal(b, &oracle); err != nil {
		t.Fatal(err)
	}
	if !Same(id, oracle.Identity) || oracle.Pipe != Pipe(c.InstanceRoot, "runtime") {
		t.Fatalf("identity or pipe differs: %+v %+v", id, oracle)
	}
	owner, err := Acquire(c, "runtime", func(_ context.Context, r Row) (any, error) {
		if r["operation"] != "status" {
			return nil, fmt.Errorf("CONTROL_OPERATION_INVALID")
		}
		return Row{"state": "READY"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if _, err = Acquire(c, "runtime", nil); Code(err, "") != "INSTANCE_IN_USE" {
		t.Fatalf("duplicate: %v", err)
	}
	result, err := Call(context.Background(), c, "status", nil)
	if err != nil || result.(map[string]any)["state"] != "READY" {
		t.Fatalf("call: %v %v", result, err)
	}
	for _, input := range []Row{{"instanceId": c.InstanceID, "token": "wrong", "operation": "stop"}, {"instanceId": "another", "token": owner.Token, "operation": "stop"}, {"instanceId": c.InstanceID, "token": owner.Token, "operation": "other"}} {
		conn, err := winio.DialPipeContext(context.Background(), Pipe(c.InstanceRoot, "runtime"))
		if err != nil {
			t.Fatal(err)
		}
		json.NewEncoder(conn).Encode(input)
		var response Row
		err = json.NewDecoder(conn).Decode(&response)
		conn.Close()
		want := "CONTROL_FORBIDDEN"
		if input["operation"] == "other" {
			want = "CONTROL_OPERATION_INVALID"
		}
		if err != nil || response["code"] != want {
			t.Fatalf("reject: %v %v", response, err)
		}
	}
	// Existing Node clients must connect to the genuine Go pipe, not a mock.
	script = `const c=require(process.argv[1]);c.control(JSON.parse(process.argv[2]),'status').then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.code);process.exitCode=1});`
	raw, _ := json.Marshal(c)
	b, err = exec.Command(node, "-e", script, filepath.Join(reference, "src/runtime/control.js"), string(raw)).CombinedOutput()
	if err != nil || !strings.Contains(string(b), "READY") {
		t.Fatalf("Node to Go: %s %v", b, err)
	}
	if err = owner.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(c.StateRoot, "runtime.lock")); !os.IsNotExist(err) {
		t.Fatalf("lease not released: %v", err)
	}
	old := *id
	old.Start = "reused-PID"
	if err = instance.WriteJSON(filepath.Join(c.StateRoot, "runtime.lock"), Record{Identity: &old, Token: "stale"}); err != nil {
		t.Fatal(err)
	}
	owner, err = Acquire(c, "runtime", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !owner.Recovered {
		t.Fatal("stale record not recovered")
	}
	owner.Close()
	instance.WriteJSON(filepath.Join(c.StateRoot, "runtime.lock"), Record{Identity: id, Token: "live"})
	if _, err = Acquire(c, "runtime", nil); Code(err, "") != "INSTANCE_IN_USE" {
		t.Fatalf("live owner stolen: %v", err)
	}
}
func TestUnverifiedReplyAndOversizedRequest(t *testing.T) {
	c := fixture(t)
	id, err := ProcessIdentity(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	instance.WriteJSON(filepath.Join(c.StateRoot, "runtime.lock"), Record{InstanceID: c.InstanceID, Identity: id, Token: "test"})
	l, err := winio.ListenPipe(Pipe(c.InstanceRoot, "runtime"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var r Row
		json.NewDecoder(conn).Decode(&r)
		json.NewEncoder(conn).Encode(Row{"ok": true, "instanceId": "wrong", "identity": id, "data": Row{}})
		if p, ok := conn.(winio.PipeConn); ok {
			p.Flush()
		}
	}()
	if _, err = Call(context.Background(), c, "status", nil); Code(err, "") != "OWNER_MISMATCH" {
		t.Fatalf("reply accepted: %v", err)
	}
	l.Close()
	instance.Recycle(filepath.Join(c.StateRoot, "runtime.lock"))
	owner, err := Acquire(c, "runtime", func(context.Context, Row) (any, error) { t.Error("oversized request reached handler"); return nil, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	conn, err := winio.DialPipeContext(context.Background(), Pipe(c.InstanceRoot, "runtime"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	_, _ = conn.Write([]byte(strings.Repeat("x", 4097) + "\n"))
	var response [32]byte
	n, e := conn.Read(response[:])
	if n != 0 || e == nil {
		t.Fatalf("oversize not closed: %d %v", n, e)
	}
}
