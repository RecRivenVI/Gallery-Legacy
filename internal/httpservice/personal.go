package httpservice

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
	"github.com/RecRivenVI/Gallery-Legacy/internal/searchquery"
)

const sessionCookie = "gallery_session"

func cookie(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}
func (s *Server) currentAccount(r *http.Request) (*api.Account, error) {
	return s.people.Session(r.Context(), cookie(r))
}
func saveCookie(w http.ResponseWriter, token string) {
	maxAge := 365 * 24 * 3600
	if token == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}

func (s *Server) accountSession(w http.ResponseWriter, r *http.Request) error {
	a, err := s.currentAccount(r)
	if err != nil {
		return err
	}
	data := reading.Row{"account": a, "preferences": nil, "counts": map[string]int64{}}
	if a != nil {
		prefs, err := s.people.Preferences(r.Context(), a.ID)
		if err != nil {
			return err
		}
		data["preferences"] = prefs
		value, _, err := s.read(reading.WithAccount(r.Context(), a.ID), func(v *reading.View) (any, error) {
			if v == nil {
				return map[string]int64{"favorites": 0, "history": 0, "continue": 0}, nil
			}
			return v.PersonalCounts()
		})
		if err != nil {
			return err
		}
		data["counts"] = value
	}
	return s.send(w, r, data, nil)
}

func (s *Server) personalRoute(w http.ResponseWriter, r *http.Request) (bool, error) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/")
	if path == r.URL.Path {
		return false, nil
	}
	switch path {
	case "accounts", "session", "account", "personal", "collections", "personal-tags", "history/clear", "search-parse":
	default:
		return false, nil
	}
	if r.Method == "GET" {
		switch path {
		case "accounts":
			items, err := s.people.Accounts(r.Context())
			if err != nil {
				return true, err
			}
			return true, s.send(w, r, reading.Row{"items": items}, nil)
		case "session":
			return true, s.accountSession(w, r)
		case "search-parse":
			terms := searchquery.Parse(r.URL.Query().Get("q"))
			return true, s.send(w, r, api.SearchParse{Terms: terms, Platforms: searchquery.Selected(terms)}, nil)
		}
	}
	if r.Method != "GET" && r.Method != "POST" {
		return true, media.Failure("METHOD_NOT_ALLOWED", 405)
	}
	input := reading.Row{}
	if r.Method == "POST" {
		var err error
		input, err = sizedBody(r, 65536)
		if err != nil {
			return true, err
		}
		if input == nil {
			return true, media.Failure("INVALID_BODY", 400)
		}
	}
	str := func(key string) string { value, _ := input[key].(string); return value }
	if path == "accounts" && r.Method == "POST" {
		prefs, _ := json.Marshal(input["preferences"])
		if string(prefs) == "null" {
			prefs = []byte(`{}`)
		}
		a, err := s.people.Create(r.Context(), str("name"), str("password"), prefs)
		if err != nil {
			return true, err
		}
		token, err := s.people.Login(r.Context(), a.ID, str("password"))
		if err != nil {
			return true, err
		}
		saveCookie(w, token)
		r.Header.Del("Cookie")
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		return true, s.accountSession(w, r)
	}
	if path == "session" && r.Method == "POST" {
		if str("action") == "logout" {
			if err := s.people.Logout(r.Context(), cookie(r)); err != nil {
				return true, err
			}
			saveCookie(w, "")
			return true, s.send(w, r, reading.Row{"account": nil, "preferences": nil, "counts": map[string]int64{}}, nil)
		}
		token, err := s.people.Login(r.Context(), str("id"), str("password"))
		if err != nil {
			return true, err
		}
		saveCookie(w, token)
		// Replace a previous browser cookie while returning the selected account.
		r.Header.Del("Cookie")
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		return true, s.accountSession(w, r)
	}
	a, err := s.currentAccount(r)
	if err != nil {
		return true, err
	}
	if a == nil {
		return true, media.Failure("LOGIN_REQUIRED", 401)
	}
	if (r.Method == "POST" && (path == "account" || path == "personal" || path == "collections" || path == "history/clear")) && str("accountId") != a.ID {
		return true, media.Failure("ACCOUNT_CHANGED", 409)
	}
	switch path {
	case "account":
		if r.Method != "POST" {
			return true, media.Failure("METHOD_NOT_ALLOWED", 405)
		}
		switch str("action") {
		case "delete":
			err = s.people.Delete(r.Context(), a.ID)
			saveCookie(w, "")
		case "preferences":
			raw, _ := json.Marshal(input["preferences"])
			err = s.people.SavePreferences(r.Context(), a.ID, raw)
		default:
			var secret *string
			if p, ok := input["password"].(string); ok {
				secret = &p
			}
			err = s.people.Update(r.Context(), a.ID, str("name"), str("avatar"), secret)
		}
	case "personal":
		if r.Method != "POST" {
			return true, media.Failure("METHOD_NOT_ALLOWED", 405)
		}
		raw, _ := json.Marshal(input)
		var change api.PersonalChange
		if err = json.Unmarshal(raw, &change); err != nil {
			return true, media.Failure("INVALID_BODY", 400)
		}
		value, _, resolveErr := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, nil
			}
			identity, err := v.WorkIdentity(change.Work)
			if err != nil || identity == nil {
				return nil, err
			}
			if change.Action == "read" {
				n, err := v.ReadableCount(identity["work_id"].(int64))
				if err != nil {
					return nil, err
				}
				identity["media_count"] = n
			}
			return identity, nil
		})
		if resolveErr != nil {
			return true, resolveErr
		}
		if value == nil {
			return true, media.Failure("WORK_NOT_FOUND", 404)
		}
		if change.Action == "read" {
			if identity, ok := value.(reading.Row); ok {
				change.Number = min(change.Number, int(identity["media_count"].(int64)))
			}
		}
		err = s.people.Change(r.Context(), a.ID, change)
		if err != nil {
			return true, err
		}
		identity := value.(reading.Row)
		updated, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			items, err := v.Works([]int64{identity["work_id"].(int64)}, "all")
			if err != nil {
				return nil, err
			}
			if len(items) == 0 {
				return nil, media.Failure("WORK_NOT_FOUND", 404)
			}
			return items[0], nil
		})
		if err != nil {
			return true, err
		}
		return true, s.send(w, r, updated, revision)
	case "history/clear":
		if r.Method != "POST" {
			return true, media.Failure("METHOD_NOT_ALLOWED", 405)
		}
		err = s.people.ClearHistory(r.Context(), a.ID)
	case "personal-tags":
		items, err := s.people.Tags(r.Context(), a.ID)
		if err != nil {
			return true, err
		}
		return true, s.send(w, r, reading.Row{"items": items}, nil)
	case "collections":
		if r.Method == "POST" {
			if _, err = s.people.Collection(r.Context(), a.ID, str("id"), str("name"), str("action")); err != nil {
				return true, err
			}
		}
		items, err := s.people.Collections(r.Context(), a.ID)
		if err != nil {
			return true, err
		}
		return true, s.send(w, r, reading.Row{"items": items}, nil)
	}
	if err != nil {
		return true, err
	}
	return true, s.send(w, r, reading.Row{"saved": true, "at": time.Now().UnixMilli()}, nil)
}
