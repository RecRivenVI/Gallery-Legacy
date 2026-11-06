package httpservice

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func TestPersonalCookieAccountSwitchAndStaleMutation(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	sources := reading.Row{}
	def, err := api.LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range def.Platforms {
		sources[p.ID] = filepath.Join(root, "sources", p.ID)
	}
	c, err := instance.Normalize(reading.Row{"instanceRoot": filepath.Join(root, "instance"), "sources": sources, "liveUpdates": true, "port": float64(18480)})
	if err != nil {
		t.Fatal(err)
	}
	if err = catalog.CreateLive(ctx, c.InstanceRoot, c.Sources); err != nil {
		t.Fatal(err)
	}
	d, err := dataset.Open(ctx, c, nil)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(d, Options{})
	if err != nil {
		d.Close()
		t.Fatal(err)
	}
	defer server.Close()
	var selected *http.Cookie
	call := func(method, path, body string, status int) reading.Row {
		t.Helper()
		r := httptest.NewRequest(method, c.URL+"/api/v1/"+path, strings.NewReader(body))
		if selected != nil {
			r.AddCookie(selected)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s status %d body %s", path, w.Code, w.Body.String())
		}
		for _, cookie := range w.Result().Cookies() {
			if cookie.Name == sessionCookie {
				selected = cookie
			}
		}
		var value reading.Row
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	first := call("POST", "accounts", `{"name":"甲","password":"secret","preferences":{"theme":"dark"}}`, 200)["data"].(map[string]any)["account"].(map[string]any)["id"].(string)
	second := call("POST", "accounts", `{"name":"乙"}`, 200)["data"].(map[string]any)["account"].(map[string]any)["id"].(string)
	result := call("POST", "account", `{"action":"preferences","accountId":"`+first+`","preferences":{"theme":"light"}}`, 409)
	if result["error"].(map[string]any)["code"] != "ACCOUNT_CHANGED" {
		t.Fatal(result)
	}
	call("POST", "account", `{"action":"preferences","accountId":"`+second+`","preferences":{"theme":"light"}}`, 200)
	call("POST", "collections", `{"accountId":"`+first+`","name":"旧账号请求"}`, 409)
	value := call("POST", "collections", `{"accountId":"`+second+`","name":"乙的收藏夹"}`, 200)
	if len(value["data"].(map[string]any)["items"].([]any)) != 1 {
		t.Fatal("collection owner mismatch")
	}

	call("POST", "session", `{"id":"`+first+`","password":"wrong"}`, 400)
	current := call("GET", "session", "", 200)["data"].(map[string]any)["account"].(map[string]any)["id"]
	if current != second {
		t.Fatal("failed login replaced account")
	}
	call("POST", "session", `{"id":"`+first+`","password":"secret"}`, 200)
	state := call("GET", "session", "", 200)["data"].(map[string]any)
	if state["preferences"].(map[string]any)["theme"] != "dark" {
		t.Fatal("stale preferences leaked across accounts")
	}
	call("POST", "session", `{"action":"logout"}`, 200)
	call("POST", "personal", `{"accountId":"`+first+`","action":"favorite","work":"/p/pixiv/1/2","value":true}`, 401)
}
