package httpservice

import (
	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAutomaticBanThresholdExpiryAndLocalExemption(t *testing.T) {
	now := time.Unix(1793000000, 0)
	c := instance.Config{StateRoot: t.TempDir(), InstanceID: "synthetic-ban"}
	a, err := newAccess(c, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer a.close()
	request := func(ip string, status int) bool {
		r := httptest.NewRequest("GET", "http://localhost/api/v1/status", nil)
		r.RemoteAddr = ip + ":1000"
		ok, done := a.begin(r)
		done(status, 0)
		return ok
	}
	if !request("192.0.2.3", 500) {
		t.Fatal("default enabled")
	}
	if err = a.configureBan(reading.Row{"enabled": true, "windowSeconds": int64(60), "maxRequests": int64(3), "maxErrors": int64(2), "banMinutes": int64(1)}); err != nil {
		t.Fatal(err)
	}
	if !request("192.0.2.4", 200) || !request("192.0.2.4", 200) || request("192.0.2.4", 200) {
		t.Fatal("request threshold")
	}
	now = now.Add(61 * time.Second)
	if !request("192.0.2.4", 200) {
		t.Fatal("temporary ban did not expire")
	}
	for range 5 {
		if !request("127.0.0.1", 500) {
			t.Fatal("local address blocked")
		}
	}
	request("192.0.2.5", 500)
	request("192.0.2.5", 500)
	if request("192.0.2.5", 200) {
		t.Fatal("error threshold")
	}
	if err = a.flush(); err != nil {
		t.Fatal(err)
	}
	b, err := newAccess(c, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer b.close()
	if b.rule != a.rule {
		t.Fatal("rule was not persisted")
	}
}
