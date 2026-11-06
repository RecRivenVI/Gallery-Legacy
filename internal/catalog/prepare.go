package catalog

import (
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"github.com/RecRivenVI/Gallery-Legacy/internal/mediaorder"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"path/filepath"
	"sort"
	"strings"
)

type Row = map[string]any
type File struct {
	Relative, Key, Name, Extension, Kind string
	Size, Mtime                          int64
}
type PreparedWork struct {
	Platform, AuthorKey, Key, Fingerprint string
	Work, Author, Profile, Shape          Row
	Children                              map[string][]Row
	Media                                 []Row
	Normalized                            metadata.Result
	AuthorityTime                         int64
	AuthorityID, AuthorityName            string
	Qualified                             bool
	Reused                                bool
	MetadataOnly                          bool
	Bytes                                 int64
	StageFile                             string
}

// Authority retains one bounded profile candidate per author, not its pages/body.
func Authority(p PreparedWork) PreparedWork {
	p.StageFile = ""
	p.Children, p.Media = nil, nil
	p.Normalized.Primary, p.Normalized.Supplementary = nil, nil
	p.Normalized.Structured = nil
	p.Normalized.Tags, p.Normalized.Relations, p.Normalized.Evidence = nil, nil, nil
	p.Normalized.Work, p.Normalized.Flags, p.Normalized.Access, p.Normalized.Metrics = nil, nil, nil, nil
	p.Normalized.Details = metadata.Details{}
	p.Bytes = int64(len(metadata.JSON(p)))
	return p
}

func Later(a, b PreparedWork) bool { return later(a, b) }

// A newly visible author has directory facts until its complete scope chooses
// the final profile. This uses the same mapper as an empty physical author.
func DirectoryAuthor(platform, name string) Row {
	r := metadata.New()
	r.Valid = false
	return Fill(platform, name, "", name, 0, "missing", nil, nil, r, "", "", nil).Author
}

func text(v any) string { return metadata.String(v) }
func integer(v any) int64 {
	if n, ok := v.(int64); ok {
		return n
	}
	return 0
}
func nullable(v any) any {
	if v == "" {
		return nil
	}
	return v
}
func boolean(v any) any {
	if b, ok := v.(bool); ok {
		if b {
			return int64(1)
		}
		return int64(0)
	}
	return nil
}
func row(fields ...string) Row {
	r := Row{}
	for _, s := range fields {
		r[s] = nil
	}
	return r
}
func Fill(platform, author, work, relative string, mtime int64, metadataState string, metaMtime, metaSize any, r metadata.Result, shapeHash, fingerprint string, files []File) PreparedWork {
	if platform == "Venera" {
		r.Details.WorkType = "manga"
	}
	aKey := strings.ToLower(author)
	key := strings.ToLower(relative)
	name, nameSource := author, "directory_raw"
	if platform == "Venera" {
		nameSource = "directory_parsed"
	}
	sourceAuthor := r.Profile["sourceAuthorId"]
	sourceAuthorKind := any(nil)
	if sourceAuthor != nil {
		sourceAuthorKind = "metadata"
	} else if platform == "Pawchive" {
		parts := strings.SplitN(author, "_", 2)
		if len(parts) == 2 {
			sourceAuthor = parts[0] + ":" + parts[1]
			sourceAuthorKind = "directory_parsed"
		}
	} else if platform != "Venera" {
		sourceAuthor = metadata.AuthorIDFor(platform, author)
		if sourceAuthor != nil {
			sourceAuthorKind = "directory_parsed"
		}
	}
	if s := text(r.Profile["displayName"]); s != "" {
		name = s
		nameSource = "metadata"
	} else if s := text(r.Profile["handle"]); s != "" {
		name = s
		nameSource = "metadata"
	} else if sourceAuthor != nil && platform != "Venera" {
		nameSource = "directory_parsed"
	}
	title, titleSource := work, "directory_raw"
	sourceWork := r.Work["sourceWorkId"]
	sourceWorkKind := any(nil)
	if sourceWork != nil {
		sourceWorkKind = "metadata"
	} else if platform != "Venera" {
		sourceWork = metadata.DirectoryWorkID(work)
		if sourceWork != nil {
			sourceWorkKind = "directory_parsed"
		}
	}
	if s := text(r.Work["title"]); s != "" {
		title = s
		titleSource = "metadata"
	} else if platform == "Venera" {
		title = author
		titleSource = "directory_parsed"
	} else if s := metadata.DirectoryWorkID(work); s != nil {
		title = text(s)
		titleSource = "directory_parsed"
		if platform == "X" || platform == "微博" {
			title = strings.Replace(work[:19], "_", " ", 1)
			title = title[:11] + strings.ReplaceAll(title[11:], "-", ":")
		}
	}
	sortAt, sortSource := mtime/1000000, "directory_mtime"
	if v, ok := r.Work["publishedAtMs"].(int64); ok {
		sortAt = v
		sortSource = "metadata_published"
	} else if v, ok := metadata.DirectoryDate(work).(int64); ok {
		sortAt = v
		sortSource = "directory_parsed"
	}
	a := Row{"platform_id": platform, "relative_path": author, "relative_path_key": aKey, "folder_name": author, "source_author_id": sourceAuthor, "source_author_id_source": sourceAuthorKind, "display_name": name, "display_name_source": nameSource, "handle": nil, "name_rank": nil, "work_count": int64(0), "latest_work_at_ms": nil, "latest_work_id": nil, "profile_state": "unavailable"}
	w := row("published_at_ms", "updated_at_ms", "title_rank", "language", "is_adult", "is_ai_generated", "is_paid", "is_restricted", "is_sensitive", "has_full", "is_advertisement", "cover_media_id", "metadata_shape_id")
	for k, v := range (Row{"platform_id": platform, "relative_path": relative, "relative_path_key": key, "source_work_id": sourceWork, "source_work_id_source": sourceWorkKind, "published_at_ms": r.Work["publishedAtMs"], "updated_at_ms": r.Work["updatedAtMs"], "sort_at_ms": sortAt, "sort_time_source": sortSource, "title": title, "title_source": titleSource, "language": r.Work["language"], "image_count": int64(0), "video_count": int64(0), "media_count": int64(0), "filesystem_state": "present", "filesystem_files_state": "complete", "work_dir_mtime_ns": mtime, "metadata_state": metadataState, "enrichment_state": "unavailable", "metadata_mtime_ns": metaMtime, "metadata_size": metaSize, "adapter_version": metadata.Versions[platform]}) {
		w[k] = v
	}
	if metadataState == "valid" || metadataState == "partial" {
		if r.Valid && metadataState != "partial" {
			w["enrichment_state"] = "available"
		} else {
			w["enrichment_state"] = "partial"
		}
	}
	for _, pair := range [][2]string{{"adult", "is_adult"}, {"aiGenerated", "is_ai_generated"}, {"paid", "is_paid"}, {"restricted", "is_restricted"}, {"sensitive", "is_sensitive"}, {"hasFull", "has_full"}, {"advertisement", "is_advertisement"}} {
		w[pair[1]] = boolean(r.Flags[pair[0]])
	}
	p := PreparedWork{Platform: platform, AuthorKey: aKey, Key: key, Fingerprint: fingerprint, Work: w, Author: a, Normalized: r, Children: map[string][]Row{}, Qualified: metadataState == "valid" || metadataState == "missing", AuthorityTime: -9007199254740991, AuthorityID: text(sourceWork), AuthorityName: work}
	// The filesystem preparation adapter receives the observed directory mtime
	// as its comparison context; the display sort separately prefers filename time.
	p.AuthorityTime = mtime / 1000000
	if metadataState == "missing" || metadataState == "unreadable" {
		p.AuthorityID = ""
	}
	if v, ok := r.Work["publishedAtMs"].(int64); ok {
		p.AuthorityTime = v
	}
	if shapeHash != "" {
		p.Shape = Row{"platform_id": platform, "signature_version": 1, "policy_version": 1, "shape_hash": shapeHash, "representative_metadata_relative_path": relative + "\\metadata.json", "work_count": int64(0)}
	}
	if r.Valid {
		p.Profile = row("bio", "avatar_url", "banner_url", "profile_url", "location", "language", "verified", "verification_type", "verification_reason", "followers_count", "following_count", "statuses_count", "source_published_at_ms", "source_metadata_mtime_ns", "metadata_shape_id")
		for _, pair := range [][2]string{{"bio", "bio"}, {"avatarUrl", "avatar_url"}, {"bannerUrl", "banner_url"}, {"profileUrl", "profile_url"}, {"location", "location"}, {"language", "language"}, {"verified", "verified"}, {"verificationType", "verification_type"}, {"verificationReason", "verification_reason"}, {"followersCount", "followers_count"}, {"followingCount", "following_count"}, {"statusesCount", "statuses_count"}} {
			v := r.Profile[pair[0]]
			if pair[0] == "verified" {
				v = boolean(v)
			}
			p.Profile[pair[1]] = v
		}
		links := r.Profile["profileLinks"]
		if links == nil {
			links = []any{}
		}
		p.Profile["profile_links_json"] = metadata.JSON(links)
		p.Profile["adapter_version"] = metadata.Versions[platform]
		p.Profile["source_published_at_ms"] = r.Work["publishedAtMs"]
		p.Profile["source_metadata_mtime_ns"] = metaMtime
	}
	if r.Primary != nil {
		t := r.Primary
		x := row("safe_format", "safe_text", "plain_text", "search_text", "normalizer_version", "sanitizer_version")
		x["source_format"] = t.SourceFormat
		x["source_text"] = t.SourceText
		x["plain_text"] = metadata.PlainText(t.SourceText, t.SourceFormat)
		p.Children["work_text"] = []Row{x}
		p.Bytes += int64(len(t.SourceText))
	}
	for i, t := range r.Supplementary {
		p.Children["work_text_sources"] = append(p.Children["work_text_sources"], Row{"ordinal": i, "role": t.Role, "source_path": t.SourcePath, "source_format": t.SourceFormat, "source_text": t.SourceText})
		p.Bytes += int64(len(t.SourceText))
	}
	m := row("likes", "replies", "comments", "reposts", "views", "bookmarks")
	for k, v := range r.Metrics {
		m[k] = v
	}
	p.Children["work_metrics"] = []Row{m}
	for i, t := range r.Relations {
		p.Children["social_relations"] = append(p.Children["social_relations"], Row{"ordinal": i, "relation_type": t.Type, "target_platform_id": platform, "target_source_work_id": t.SourceID, "target_work_id": nil})
	}
	for _, e := range r.Evidence {
		p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": e.Field, "source_kind": e.Kind, "source_path": e.Path, "priority": e.Priority})
	}
	for _, e := range []struct{ field, source, path string }{{"work.title", titleSource, "workDirectoryName"}, {"work.sortAtMs", sortSource, "workDirMtimeNs"}, {"author.displayName", nameSource, "authorDirectoryName"}} {
		kind := "filesystem"
		sourcePath := e.path
		if strings.HasPrefix(e.source, "metadata") {
			kind = "metadata"
			sourcePath = map[string]string{"work.title": "$.work.title", "work.sortAtMs": "$.work.publishedAtMs", "author.displayName": "$.authorProfile.displayName"}[e.field]
		} else if e.field == "work.title" && titleSource == "directory_parsed" {
			sourcePath = "workDirectoryName.timestampedSuffix"
			if platform == "X" || platform == "微博" {
				sourcePath = "workDirectoryName.timestamp"
			}
			if platform == "Venera" {
				sourcePath = "authorDirectoryName"
			}
		} else if e.field == "work.sortAtMs" && sortSource == "directory_parsed" {
			sourcePath = "workDirectoryName.timestamp"
		}
		p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": e.field, "source_kind": kind, "source_path": sourcePath, "priority": 100})
	}
	for _, e := range []struct {
		field      string
		id, origin any
		path       string
	}{{"work.sourceWorkId", sourceWork, sourceWorkKind, "workDirectoryName.timestampedSuffix"}, {"author.sourceAuthorId", sourceAuthor, sourceAuthorKind, "authorDirectoryName"}} {
		if e.id != nil {
			kind := "filesystem"
			path := e.path
			if e.origin == "metadata" {
				kind = "metadata"
				path = "adapter.selected"
			}
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": e.field, "source_kind": kind, "source_path": path, "priority": 100})
		}
	}
	extracted := false
	for _, e := range r.Evidence {
		if e.Field == "media.extractedPreviews" {
			extracted = true
		}
	}
	for _, f := range files {
		if library.IsArchive(f.Extension) {
			extracted = platform == "Gank"
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "files.archivePresent", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
			if platform != "Gank" {
				break
			}
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "media.extractedPreviews", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
			break
		}
	}
	for _, f := range files {
		if strings.EqualFold(f.Relative, ".nocover") {
			p.Children["field_sources"] = append(p.Children["field_sources"], Row{"field": "media.coverDisabled", "source_kind": "filesystem", "source_path": f.Relative, "priority": 1})
		}
		if f.Kind != "image" && f.Kind != "video" {
			continue
		}
		x := mediaRow(f)
		p.Media = append(p.Media, x)
		p.Bytes += int64(len(f.Relative) + 256)
		w[f.Kind+"_count"] = integer(w[f.Kind+"_count"]) + 1
	}
	w["media_count"] = int64(len(p.Media))
	_ = extracted

	return p
}

func mediaRow(f File) Row {
	x := row("source_media_id", "metadata_ordinal", "metadata_name", "metadata_media_type", "declared_size", "remote_url", "source_hash", "duration_ms")
	for k, v := range (Row{"relative_path": f.Relative, "relative_path_key": f.Key, "filesystem_file_name": f.Name, "filesystem_extension": f.Extension, "filesystem_size": f.Size, "filesystem_mtime_ns": f.Mtime, "filesystem_media_type": f.Kind}) {
		x[k] = v
	}
	return x
}
func basename(s string) string {
	return filepath.Base(strings.ReplaceAll(s, "\\", string(filepath.Separator)))
}
func presentation(name string, extracted bool) bool {
	_, visible := mediaorder.Role(name, extracted)
	return visible
}
func SortedKeys(r Row) []string {
	a := []string{}
	for k := range r {
		a = append(a, k)
	}
	sort.Strings(a)
	return a
}
func debugKey(p PreparedWork) string { return fmt.Sprintf("%s:%s", p.Platform, p.Key) }
