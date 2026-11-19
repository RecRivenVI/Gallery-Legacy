package httpservice

import (
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

type banRule struct {
	Enabled       bool  `json:"enabled"`
	WindowSeconds int64 `json:"windowSeconds"`
	MaxRequests   int64 `json:"maxRequests"`
	MaxErrors     int64 `json:"maxErrors"`
	BanMinutes    int64 `json:"banMinutes"`
}
type accessWindow struct{ start, requests, errors int64 }

func defaultBanRule() banRule {
	return banRule{WindowSeconds: 60, MaxRequests: 600, MaxErrors: 60, BanMinutes: 30}
}
func (a *access) configureBan(input reading.Row) error {
	enabled, ok := input["enabled"].(bool)
	if !ok {
		return fmt.Errorf("ACCESS_SETTING_INVALID")
	}
	rule := banRule{Enabled: enabled, WindowSeconds: count(input["windowSeconds"]), MaxRequests: count(input["maxRequests"]), MaxErrors: count(input["maxErrors"]), BanMinutes: count(input["banMinutes"])}
	if rule.WindowSeconds < 1 || rule.WindowSeconds > 86400 || rule.MaxRequests < 1 || rule.MaxErrors < 1 || rule.BanMinutes < 1 || rule.BanMinutes > 43200 {
		return fmt.Errorf("ACCESS_SETTING_INVALID")
	}
	a.rule = rule
	a.windows = map[string]*accessWindow{}
	a.dirty = true
	return nil
}
func (a *access) checkBan(client reading.Row, failure bool) {
	if !a.enabled || !a.rule.Enabled || client["local"] == true || client["blocked"] == true {
		return
	}
	now := a.now().UnixMilli()
	key := stringValue(client["id"])
	w := a.windows[key]
	if w == nil || now-w.start >= a.rule.WindowSeconds*1000 {
		w = &accessWindow{start: now}
		a.windows[key] = w
	}
	if failure {
		w.errors++
	} else {
		w.requests++
	}
	if w.requests >= a.rule.MaxRequests || w.errors >= a.rule.MaxErrors {
		a.changeBan(client, true, now+a.rule.BanMinutes*60000, "automatic", now)
	}
}

func (a *access) expireBan(client reading.Row) {
	until := count(client["blockedUntilMs"])
	if until > 0 && until <= a.now().UnixMilli() {
		a.changeBan(client, false, 0, "expired", until)
	}
}

func (a *access) changeBan(client reading.Row, blocked bool, until int64, action string, at int64) {
	if client["blocked"] == blocked && count(client["blockedUntilMs"]) == until {
		return
	}
	client["blocked"], client["blockedUntilMs"] = blocked, until
	a.touch(client)
	delete(a.windows, stringValue(client["id"]))
	a.bans = append(a.bans, reading.Row{
		"client": client["id"], "address": client["address"], "action": action,
		"blocked": blocked, "blockedUntilMs": until, "atMs": at,
	})
}
