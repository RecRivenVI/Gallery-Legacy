package httpservice

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func (s *Server) work(w http.ResponseWriter, r *http.Request, p string, q url.Values) error {
	if q.Has("g") && q.Get("g") != s.data.Epoch {
		return media.Failure("GENERATION_CHANGED", 409)
	}
	id, err := protocol.Identifier(strings.TrimPrefix(p, "/api/v1/works/"))
	if err != nil {
		return err
	}
	data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
		if v == nil {
			return nil, media.Failure("WORK_NOT_FOUND", 404)
		}
		found, err := v.Work(id)
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, media.Failure("WORK_NOT_FOUND", 404)
		}
		return found, nil
	})
	if err != nil {
		return err
	}
	return s.send(w, r, data, revision)
}
func (s *Server) resolve(w http.ResponseWriter, r *http.Request, p string, q url.Values) error {
	data, revision, err := s.read(r.Context(), func(v *reading.View) (any, error) {
		if v == nil {
			return nil, media.Failure("WORK_NOT_FOUND", 404)
		}
		if p == "/api/v1/resolve" {
			found, err := v.Resolve(q.Get("path"))
			if err != nil {
				return nil, err
			}
			if found == nil {
				return nil, media.Failure("WORK_NOT_FOUND", 404)
			}
			return found, nil
		}
		items, err := v.Chapters(q.Get("path"))
		if err != nil {
			return nil, err
		}
		if items == nil {
			return nil, media.Failure("WORK_NOT_FOUND", 404)
		}
		return reading.Row{"items": items}, nil
	})
	if err != nil {
		return err
	}
	return s.send(w, r, data, revision)
}
func (s *Server) libraryMedia(w http.ResponseWriter, r *http.Request, kind, rawID string, q url.Values) error {
	id, err := protocol.Identifier(rawID)
	if err != nil {
		return err
	}
	data, _, err := s.read(r.Context(), func(v *reading.View) (any, error) {
		if q.Get("g") != s.data.Epoch {
			if v == nil || q.Get("p") == "" {
				return nil, media.Failure("GENERATION_CHANGED", 409)
			}
			id, err = mediaIDAt(v, q.Get("p"))
			if err != nil {
				return nil, err
			}
			if id == 0 {
				return nil, media.Failure("GENERATION_CHANGED", 409)
			}
			key, e := v.MediaIdentity(id)
			if e != nil {
				return nil, e
			}
			if q.Get("k") != key {
				return nil, media.Failure("MEDIA_IDENTITY_CHANGED", 409)
			}
		}
		if s.data.Live && v != nil {
			key, e := v.MediaIdentity(id)
			if e != nil {
				return nil, e
			}
			if q.Get("k") != key {
				return nil, media.Failure("MEDIA_IDENTITY_CHANGED", 409)
			}
		}
		if v == nil {
			return nil, nil
		}
		return v.Media(id)
	})
	if err != nil {
		return err
	}
	row, _ := data.(map[string]any)
	f, err := media.Resolve(s.data.Config, row)
	if err != nil {
		return err
	}
	return s.serveMedia(w, r, f, kind == "thumbnails", kind == "subtitles", q.Get("lang"))
}
