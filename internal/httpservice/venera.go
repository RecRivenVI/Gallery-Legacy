package httpservice

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/fileview"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"
	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func mediaIDAt(v *reading.View, p string) (int64, error) {
	value, err := v.MediaAtPath(p)
	if err != nil || value == nil {
		return 0, err
	}
	return protocol.Identifier(value.(string))
}
func legacyWork(work reading.Row) reading.Row {
	stable := work["stableId"].(string)
	slash := strings.LastIndex(stable, "/")
	var date, cover any
	kind := "img"
	if n, ok := work["publishedAtMs"].(int64); ok {
		date = time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if c, ok := work["cover"].(reading.Row); ok && c != nil {
		cover = c["relativePath"]
		if c["type"] == "video" {
			kind = "vid"
		}
	}
	tags, badges := []string{}, []string{}
	for _, t := range work["tags"].([]reading.Row) {
		tags = append(tags, t["label"].(string))
	}
	flags := work["flags"].(reading.Row)
	if flags["adult"] == true {
		badges = append(badges, "adult")
	}
	if flags["aiGenerated"] == true {
		badges = append(badges, "ai")
	}
	description := ""
	if d, ok := work["description"].(reading.Row); ok {
		description, _ = d["text"].(string)
	}
	return reading.Row{"name": stable[slash+1:], "parentPath": stable[:slash], "displayName": work["title"], "subtitle": work["authorName"], "platform": work["platformId"], "kind": "dir", "date": date, "cover": cover, "coverType": kind, "tags": tags, "badges": badges, "description": description, "sourceUrl": work["sourceUrl"], "stableId": stable}
}
func (s *Server) legacy(w http.ResponseWriter, r *http.Request, path string, q url.Values) (bool, error) {
	if r.Method != "GET" && r.Method != "HEAD" {
		return false, nil
	}
	p := q.Get("p")
	if path == "/api/media" || path == "/api/thumbnail" {
		var f media.File
		var err error
		if strings.HasPrefix(p, "/f/") {
			parts := strings.Split(p, "/")
			f, err = s.files.Media(parts[2], strings.Join(parts[3:], "/"))
		} else {
			var raw any
			raw, _, err = s.read(r.Context(), func(v *reading.View) (any, error) {
				if v == nil {
					return nil, media.Failure("MEDIA_NOT_FOUND", 404)
				}
				id, err := mediaIDAt(v, p)
				if err != nil {
					return nil, err
				}
				if id == 0 {
					return nil, media.Failure("MEDIA_NOT_FOUND", 404)
				}
				return v.Media(id)
			})
			if err == nil {
				row, _ := raw.(reading.Row)
				f, err = media.Resolve(s.data.Config, row)
			}
		}
		if err != nil {
			return true, err
		}
		return true, s.serveMedia(w, r, f, path == "/api/thumbnail", false, "")
	}
	if path == "/api/list" && strings.HasPrefix(p, "/f/") {
		parts := strings.Split(p, "/")
		data, err := s.files.List(parts[2], strings.Join(parts[3:], "/"), fileview.Options{Page: 1, Size: 100, Filter: "all", Order: "asc"})
		if err != nil {
			return true, err
		}
		return true, jsonResponse(w, r, 200, reading.Row{"items": legacyMedia(data["media"].([]reading.Row), "name", false)}, false)
	}
	if path == "/api/list" || path == "/api/db-entry" {
		data, _, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, media.Failure("WORK_NOT_FOUND", 404)
			}
			found, err := v.Resolve(p)
			if err != nil {
				return nil, err
			}
			if found == nil || found["kind"] != "work" {
				return nil, media.Failure("WORK_NOT_FOUND", 404)
			}
			work := found["item"].(reading.Row)
			if path == "/api/db-entry" {
				return reading.Row{"item": legacyWork(work)}, nil
			}
			return reading.Row{"items": legacyMedia(work["media"].([]reading.Row), "relativePath", true)}, nil
		})
		if err != nil {
			return true, err
		}
		return true, jsonResponse(w, r, 200, data, false)
	}
	if path != "/api/db-authors" && path != "/api/db-posts" && path != "/api/db-author-posts" && path != "/api/search" {
		return false, nil
	}
	platform := q.Get("platform")
	if platform == "" {
		parts := strings.Split(value(q, "platformPath", p), "/")
		if len(parts) > 2 {
			var err error
			platform, err = decodePath(parts[2])
			if err != nil {
				return true, media.Failure("INVALID_URL", 400)
			}
		}
	}
	params := url.Values{"platform": {platform}, "page": {value(q, "page", "1")}, "pageSize": {value(q, "pageSize", "60")}}
	if q.Get("q") != "" {
		params.Set("q", q.Get("q"))
	}
	kind := "works"
	if path == "/api/db-authors" {
		kind = "authors"
	}
	if path == "/api/db-author-posts" {
		id := q.Get("authorId")
		if !strings.HasPrefix(id, "/p/") {
			id = "/p/" + protocol.Component(platform) + "/" + strings.ReplaceAll(id, `\`, "/")
		}
		data, _, err := s.read(r.Context(), func(v *reading.View) (any, error) {
			if v == nil {
				return nil, media.Failure("AUTHOR_NOT_FOUND", 404)
			}
			found, err := v.Resolve(id)
			if err != nil {
				return nil, err
			}
			if found == nil || found["kind"] != "author" {
				return nil, media.Failure("AUTHOR_NOT_FOUND", 404)
			}
			return found["item"], nil
		})
		if err != nil {
			return true, err
		}
		params.Set("author", data.(reading.Row)["id"].(string))
	}
	result, err := s.data.Page(r.Context(), kind, params)
	if err != nil {
		return true, err
	}
	items := []reading.Row{}
	for _, item := range result["items"].([]reading.Row) {
		if kind == "authors" {
			parts := strings.SplitN(item["stableId"].(string), "/", 4)
			items = append(items, reading.Row{"authorId": strings.ReplaceAll(parts[3], "/", `\`), "name": item["name"], "displayName": item["name"]})
		} else {
			items = append(items, legacyWork(item))
		}
	}
	result["items"] = items
	return true, jsonResponse(w, r, 200, result, false)
}
func legacyMedia(media []reading.Row, name string, visible bool) []reading.Row {
	items := []reading.Row{}
	for _, m := range media {
		if visible && m["defaultVisible"] == false {
			continue
		}
		kind := "img"
		if m["type"] == "video" {
			kind = "vid"
		}
		items = append(items, reading.Row{"name": m[name], "kind": kind})
	}
	return items
}
