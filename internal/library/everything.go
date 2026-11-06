package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Endpoint and readiness may be replaced by an in-process synthetic HTTP
// server in tests. Runtime configuration does not accept arbitrary servers.
type Everything struct {
	Endpoint string
	Ready    func(context.Context) error
	Client   *http.Client
}

func LocalEverything() *Everything {
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return inventoryConn{conn}, nil
	}
	return &Everything{Endpoint: "http://127.0.0.1:54321/", Ready: everythingReady,
		Client: &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: dial, ResponseHeaderTimeout: 5 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("EVERYTHING_REDIRECT") }}}
}

type inventoryConn struct{ net.Conn }

func (e *Everything) Available(ctx context.Context) error {
	if err := e.Ready(ctx); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.Endpoint+"?json=1&count=0", nil)
	if err != nil {
		return err
	}
	response, err := e.Client.Do(req)
	if err != nil {
		return fmt.Errorf("EVERYTHING_UNAVAILABLE: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return errors.New("EVERYTHING_RESPONSE_INVALID")
	}
	var data struct {
		Total   *int64            `json:"totalResults"`
		Results []json.RawMessage `json:"results"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&data); err != nil {
		return err
	}
	if data.Total == nil || data.Results == nil {
		return errors.New("EVERYTHING_RESPONSE_INVALID")
	}
	return nil
}

func (c inventoryConn) Read(b []byte) (int, error) {
	if err := c.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, err
	}
	return c.Conn.Read(b)
}

func (e *Everything) Read(ctx context.Context, root string, accept func(Entry) error) (int64, error) {
	if err := e.Ready(ctx); err != nil {
		return 0, err
	}
	if strings.ContainsAny(root, "\"\x00\r\n") {
		return 0, errors.New("EVERYTHING_ROOT_INVALID")
	}
	u, err := url.Parse(e.Endpoint)
	if err != nil {
		return 0, err
	}
	q := u.Query()
	q.Set("search", `path:"`+strings.TrimRight(root, `\/`)+`\"`)
	for _, name := range []string{"json", "path_column", "size_column", "date_modified_column"} {
		q.Set(name, "1")
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, err
	}
	response, err := e.Client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("EVERYTHING_UNAVAILABLE: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		return 0, errors.New("EVERYTHING_RESPONSE_INVALID")
	}
	d := json.NewDecoder(response.Body)
	d.UseNumber()
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return 0, errors.New("EVERYTHING_JSON_INVALID")
	}
	var count int64
	total := int64(-1)
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return count, err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return count, errors.New("EVERYTHING_JSON_INVALID")
		}
		seen[key] = true
		switch key {
		case "totalResults":
			if err = d.Decode(&total); err != nil {
				return count, err
			}
		case "results":
			if token, err = d.Token(); err != nil || token != json.Delim('[') {
				return count, errors.New("EVERYTHING_JSON_INVALID")
			}
			for d.More() {
				if err = ctx.Err(); err != nil {
					return count, err
				}
				var raw struct {
					Type     string  `json:"type"`
					Name     string  `json:"name"`
					Path     string  `json:"path"`
					Size     *string `json:"size"`
					Modified *string `json:"date_modified"`
				}
				if err = d.Decode(&raw); err != nil {
					return count, err
				}
				entry, err := everythingEntry(root, raw.Type, raw.Name, raw.Path, raw.Size, raw.Modified)
				if err != nil {
					return count, err
				}
				if err = accept(entry); err != nil {
					return count, err
				}
				count++
			}
			if _, err = d.Token(); err != nil {
				return count, err
			}
		default:
			return count, errors.New("EVERYTHING_JSON_INVALID")
		}
	}
	if _, err = d.Token(); err != nil {
		return count, err
	}
	if _, err = d.Token(); err != io.EOF {
		return count, errors.New("EVERYTHING_TRAILING_DATA")
	}
	if !seen["results"] || total != count {
		return count, errors.New("EVERYTHING_INVENTORY_INCOMPLETE")
	}
	if err = e.Ready(ctx); err != nil {
		return count, err
	}
	return count, nil
}

func everythingEntry(root, kind, name, parent string, size, stamp *string) (Entry, error) {
	var zero Entry
	if kind != "file" && kind != "folder" || name == "" || name == "." || name == ".." || strings.ContainsAny(name, `\/:`+"\x00") || stamp == nil {
		return zero, errors.New("EVERYTHING_ENTRY_INVALID")
	}
	full := filepath.Join(parent, name)
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == "." || !Inside(root, full) {
		return zero, errors.New("EVERYTHING_SCOPE_INVALID")
	}
	ft, err := strconv.ParseInt(*stamp, 10, 64)
	if err != nil || ft < 116444736000000000 || ft > 208678456368547758 {
		return zero, errors.New("EVERYTHING_TIME_INVALID")
	}
	n := int64(0)
	if kind == "file" {
		if size == nil {
			return zero, errors.New("EVERYTHING_SIZE_MISSING")
		}
		n, err = strconv.ParseInt(*size, 10, 64)
		if err != nil || n < 0 {
			return zero, errors.New("EVERYTHING_SIZE_INVALID")
		}
	}
	rel = strings.ReplaceAll(rel, string(filepath.Separator), `\`)
	key := strings.ToLower(rel)
	parts := strings.Split(key, `\`)
	author, work, par := parts[0], "", "."
	if len(parts) > 1 {
		par = strings.Join(parts[:len(parts)-1], `\`)
		work = strings.Join(parts[:2], `\`)
	}
	return Entry{Key: key, Relative: rel, Parent: par, Kind: kind, Author: author, Work: work, Name: name, Size: n, Mtime: (ft - 116444736000000000) * 100}, nil
}
