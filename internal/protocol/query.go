package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string   { return e.Code }
func invalid(code string) error  { return &Error{Code: code, Status: 400} }
func conflict(code string) error { return &Error{Code: code, Status: 409} }

const maxSafeInteger = int64(9007199254740991)

var digits = regexp.MustCompile(`^[0-9]+$`)
var signedDigits = regexp.MustCompile(`^-?[0-9]{1,19}$`)
var cursorAlphabet = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Query struct {
	PlatformID *string           `json:"platformId"`
	AuthorID   *string           `json:"authorId"`
	Text       string            `json:"query"`
	Tag        *string           `json:"tag"`
	Sort       string            `json:"sort"`
	MediaType  string            `json:"mediaType"`
	HideEmpty  bool              `json:"hideEmpty"`
	Limit      int64             `json:"limit"`
	Page       int64             `json:"page"`
	PageSize   int64             `json:"pageSize"`
	Revision   *int64            `json:"revision"`
	Cursor     map[string]string `json:"cursor,omitempty"`
	Key        string            `json:"key"`
}

func Identifier(value string) (int64, error) {
	if len(value) < 1 || len(value) > 19 || !digits.MatchString(value) {
		return 0, invalid("INVALID_ID")
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		return 0, invalid("INVALID_ID")
	}
	return id, nil
}

func integer(params url.Values, key string, fallback, min, max int64) (int64, error) {
	if !params.Has(key) {
		return fallback, nil
	}
	value := params.Get(key)
	if !digits.MatchString(value) {
		return 0, invalid("INVALID_NUMBER")
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < min || n > max {
		return 0, invalid("INVALID_NUMBER")
	}
	return n, nil
}

func optional(params url.Values, key string) *string {
	if !params.Has(key) {
		return nil
	}
	value := params.Get(key)
	return &value
}

// stringify keeps the JSON hash byte-compatible with JSON.stringify in Node.
func stringify(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	text := strings.TrimSuffix(buffer.String(), "\n")
	text = strings.ReplaceAll(strings.ReplaceAll(text, `\u2028`, "\u2028"), `\u2029`, "\u2029")
	return []byte(text), nil
}

func ParseQuery(params url.Values, kind, generation string, revision *int64) (Query, error) {
	var result Query
	allowed := []string{"platform", "author", "tag", "q", "sort", "mediaType", "hideEmpty", "pageSize", "page", "cursor", "g", "rev"}
	for key, values := range params {
		if !slices.Contains(allowed, key) || len(values) != 1 {
			return result, invalid("INVALID_PARAMETER")
		}
	}
	platform := params.Get("platform")
	if platform != "" {
		if _, ok := metadata.Versions[platform]; !ok {
			return result, invalid("INVALID_PLATFORM")
		}
	}
	q, tag := params.Get("q"), optional(params, "tag")
	combined := q
	if tag != nil {
		combined += *tag
	}
	for _, r := range combined {
		if r < 9 || (r > 10 && r < 13) || (r > 13 && r < 32) || r == 127 {
			return result, invalid("INVALID_QUERY")
		}
	}
	if kind != "works" {
		for _, key := range []string{"author", "tag", "mediaType", "hideEmpty"} {
			if params.Has(key) {
				return result, invalid("INVALID_PARAMETER")
			}
		}
	}
	if kind == "tags" && params.Has("sort") {
		return result, invalid("INVALID_PARAMETER")
	}
	if utf8.RuneCountInString(q) > 256 || (tag != nil && (*tag == "" || len(utf16.Encode([]rune(*tag))) > 512)) {
		return result, invalid("QUERY_TOO_LONG")
	}
	contract, err := api.Load()
	if err != nil {
		return result, fmt.Errorf("load API contract: %w", err)
	}
	sort := params.Get("sort")
	if sort == "" {
		sort = "date_desc"
		if kind == "authors" {
			sort = "name_asc"
		}
	}
	sorts := contract.WorkSorts
	if kind == "authors" {
		sorts = contract.AuthorSorts
	}
	if !slices.Contains(sorts, sort) {
		return result, invalid("INVALID_SORT")
	}
	media := params.Get("mediaType")
	if media == "" {
		media = "all"
	}
	if !slices.Contains(contract.MediaFilters, media) {
		return result, invalid("INVALID_MEDIA_FILTER")
	}
	if params.Has("hideEmpty") && !slices.Contains([]string{"0", "1"}, params.Get("hideEmpty")) {
		return result, invalid("INVALID_PARAMETER")
	}
	size, err := integer(params, "pageSize", 48, 1, 200)
	if err != nil {
		return result, err
	}
	page, err := integer(params, "page", 1, 1, 1000000)
	if err != nil {
		return result, err
	}
	author := params.Get("author")
	var authorID *string
	if author != "" {
		id, err := Identifier(author)
		if err != nil {
			return result, err
		}
		value := strconv.FormatInt(id, 10)
		authorID = &value
	}
	if params.Has("g") && params.Get("g") != generation {
		return result, conflict("GENERATION_CHANGED")
	}
	if params.Has("rev") {
		requested, err := integer(params, "rev", 0, 0, maxSafeInteger)
		if err != nil {
			return result, err
		}
		if revision == nil {
			return result, invalid("INVALID_PARAMETER")
		}
		if requested != *revision {
			return result, conflict("CONTENT_CHANGED")
		}
	}
	keyBytes, err := stringify([]any{kind, generation, optional(params, "platform"), optional(params, "author"), q, tag, sort, media, params.Get("hideEmpty") == "1", size, revision})
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(keyBytes)
	result = Query{AuthorID: authorID, Text: q, Tag: tag, Sort: sort, MediaType: media, HideEmpty: params.Get("hideEmpty") == "1", Limit: size, Page: page, PageSize: size, Revision: revision, Key: hex.EncodeToString(hash[:])}
	if platform != "" {
		result.PlatformID = &platform
	}
	if params.Has("cursor") {
		result.Cursor, err = decodeCursor(params.Get("cursor"), result.Key, kind, sort, revision)
	}
	return result, err
}

func decodeCursor(value, key, kind, sort string, revision *int64) (map[string]string, error) {
	if len(value) == 0 || len(value) > 4096 || !cursorAlphabet.MatchString(value) {
		return nil, invalid("INVALID_CURSOR")
	}
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, invalid("INVALID_CURSOR")
	}
	var decoded any
	decoder := json.NewDecoder(strings.NewReader(string(bytes)))
	decoder.UseNumber()
	if err = decoder.Decode(&decoded); err != nil {
		return nil, invalid("INVALID_CURSOR")
	}
	// Reject trailing JSON, as JSON.parse does.
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, invalid("INVALID_CURSOR")
	}
	data, _ := decoded.(map[string]any)
	if n, ok := data["revision"].(json.Number); ok && revision != nil {
		f, e := n.Float64()
		if e == nil && math.Trunc(f) == f && math.Abs(f) <= float64(maxSafeInteger) && int64(f) != *revision {
			return nil, conflict("CONTENT_CHANGED")
		}
	}
	version, ok := data["v"].(json.Number)
	v, _ := version.Float64()
	if !ok || v != 1 || data["key"] != key {
		return nil, invalid("CURSOR_CONTEXT_MISMATCH")
	}
	position, ok := data["position"].(map[string]any)
	if !ok {
		return nil, invalid("INVALID_CURSOR")
	}
	field := "workId"
	if kind == "authors" {
		field = "authorId"
	} else if kind == "tags" {
		field = "tagId"
	}
	id, ok := position[field].(string)
	if !ok {
		return nil, invalid("INVALID_ID")
	}
	parsed, err := Identifier(id)
	if err != nil {
		return nil, err
	}
	result := map[string]string{field: strconv.FormatInt(parsed, 10)}
	if kind == "tags" {
		return result, nil
	}
	value, ok = position["value"].(string)
	if !ok || len(utf16.Encode([]rune(value))) > 20000 {
		return nil, invalid("INVALID_CURSOR")
	}
	if strings.HasPrefix(sort, "date_") || strings.HasPrefix(sort, "latest_") || strings.HasPrefix(sort, "posts_") {
		if !signedDigits.MatchString(value) {
			return nil, invalid("INVALID_CURSOR")
		}
		n, e := strconv.ParseInt(value, 10, 64)
		if e != nil {
			return nil, invalid("INVALID_CURSOR")
		}
		value = strconv.FormatInt(n, 10)
	}
	result["value"] = value
	return result, nil
}
