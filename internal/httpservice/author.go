package httpservice

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func (s *Server) authorRoute(w http.ResponseWriter, r *http.Request) (bool, error) {
	path := r.URL.Path
	if path == "/api/v1/author-links" && r.Method == "POST" {
		input, err := body(r)
		if err != nil {
			return true, err
		}
		left, _ := input["left"].(string)
		right, _ := input["right"].(string)
		action, _ := input["action"].(string)
		_, _, err = s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, media.Failure("AUTHOR_NOT_FOUND", 404)
			}
			for _, path := range []string{left, right} {
				found, err := v.Resolve(path)
				if err != nil {
					return nil, err
				}
				if found == nil || found["kind"] != "author" {
					return nil, media.Failure("AUTHOR_NOT_FOUND", 404)
				}
			}
			return nil, nil
		})
		if err != nil {
			return true, err
		}
		if err = s.people.Link(r.Context(), left, right, action); err != nil {
			return true, err
		}
		return true, s.send(w, r, reading.Row{"saved": true}, nil)
	}
	if r.Method != "GET" {
		return false, nil
	}
	if path == "/api/v1/position" {
		params := r.URL.Query()
		values := url.Values{}
		if params.Has("pageSize") {
			values.Set("pageSize", params.Get("pageSize"))
		}
		query, err := protocol.ParseQuery(values, "works", s.data.Epoch, nil)
		if err != nil {
			return true, err
		}
		data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, nil
			}
			return v.Position(params.Get("path"), query.PageSize)
		})
		if err != nil {
			return true, err
		}
		if data == nil {
			return true, media.Failure("WORK_NOT_FOUND", 404)
		}
		return true, s.send(w, r, data, revision)
	}
	if strings.HasPrefix(path, "/api/v1/author-pages/") {
		id, err := protocol.Identifier(strings.TrimPrefix(path, "/api/v1/author-pages/"))
		if err != nil {
			return true, err
		}
		data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, media.Failure("AUTHOR_NOT_FOUND", 404)
			}
			return v.AuthorPage(id)
		})
		if err != nil {
			return true, err
		}
		if data == nil {
			return true, media.Failure("AUTHOR_NOT_FOUND", 404)
		}
		return true, s.send(w, r, data, revision)
	}
	if path == "/api/v1/episodes" {
		id, err := protocol.Identifier(r.URL.Query().Get("work"))
		if err != nil {
			return true, err
		}
		data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, media.Failure("WORK_NOT_FOUND", 404)
			}
			return v.Episodes(id)
		})
		if err != nil {
			return true, err
		}
		if data == nil {
			return true, media.Failure("WORK_NOT_FOUND", 404)
		}
		return true, s.send(w, r, data, revision)
	}
	return false, nil
}
