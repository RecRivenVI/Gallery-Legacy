package physical

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/derived"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

type helperRequest struct {
	Config      string   `json:"config"`
	Platforms   []string `json:"platforms"`
	Table       bool     `json:"table,omitempty"`
	Author      string   `json:"author,omitempty"`
	Incremental bool     `json:"incremental,omitempty"`
}
type OrderRecord struct {
	MetadataFile
	Complete bool  `json:"complete,omitempty"`
	Files    int64 `json:"files,omitempty"`
	Unknown  int64 `json:"unknown,omitempty"`
}

func SeekOrder(ctx context.Context, c library.Config, platforms []string) (string, func(), error) {
	var selected []string
	for _, id := range platforms {
		_, limit := library.Disk(c.Sources[id])
		if limit == 2 {
			selected = append(selected, id)
		}
	}
	if len(selected) == 0 {
		return "", nil, nil
	}
	return Order(ctx, c, selected)
}

// Order starts only a short-lived allocation helper with elevation. The
// manager, HTTP server and normal scan workers retain their original token.
func Order(ctx context.Context, c library.Config, platforms []string) (path string, cleanup func(), err error) {
	return order(ctx, c, helperRequest{Platforms: platforms})
}

func Inventory(ctx context.Context, c library.Config, platforms []string, author string, incremental bool) error {
	_, cleanup, err := order(ctx, c, helperRequest{Platforms: platforms, Table: true, Author: author, Incremental: incremental})
	if cleanup != nil {
		cleanup()
	}
	return err
}

func order(ctx context.Context, c library.Config, value helperRequest) (path string, cleanup func(), err error) {
	root := filepath.Join(c.InstanceRoot, "temp")
	if err = library.NoLinks(root); err != nil {
		return "", nil, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return "", nil, err
	}
	f, err := os.CreateTemp(root, "physical-order-*.json")
	if err != nil {
		return "", nil, err
	}
	request := f.Name()
	output := request + "l"
	cleanup = func() {
		for _, file := range []string{request, output, request + ".error.json", request + ".config.json"} {
			if err := derived.Remove(file); err != nil && !os.IsNotExist(err) {
				slog.WarnContext(ctx, "元数据位置临时文件未能回收", "code", "NTFS_ORDER_CLEANUP_FAILED", "error", err)
			}
		}
	}
	configFile, createErr := os.OpenFile(request+".config.json", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if createErr != nil {
		f.Close()
		cleanup()
		return "", nil, createErr
	}
	createErr = errors.Join(json.NewEncoder(configFile).Encode(c), configFile.Close())
	if createErr != nil {
		f.Close()
		cleanup()
		return "", nil, createErr
	}
	value.Config = request + ".config.json"
	err = json.NewEncoder(f).Encode(value)
	err = errors.Join(err, f.Close())
	if err == nil {
		var exe string
		exe, err = os.Executable()
		if err == nil {
			err = runElevated(ctx, exe, request)
		}
	}
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("NTFS_ORDER_UNAVAILABLE: %w", err)
	}
	return output, cleanup, nil
}

func RunHelper(ctx context.Context, request string) (result error) {
	if err := library.NoLinks(request); err != nil {
		return err
	}
	raw, err := os.ReadFile(request)
	if err != nil {
		return err
	}
	var req helperRequest
	if err = json.Unmarshal(raw, &req); err != nil {
		return err
	}
	c, err := library.Load(req.Config)
	if err != nil {
		return err
	}
	if !library.Inside(filepath.Join(c.InstanceRoot, "temp"), request) || !strings.HasPrefix(filepath.Base(request), "physical-order-") {
		return errors.New("NTFS_ORDER_SCOPE_INVALID")
	}
	defer func() {
		if result != nil {
			f, err := os.OpenFile(request+".error.json", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err == nil {
				err = json.NewEncoder(f).Encode(map[string]string{"error": result.Error()})
				err = errors.Join(err, f.Close())
			}
			if err != nil {
				result = errors.Join(result, err)
			}
		}
	}()
	roots := map[string]string{}
	for _, id := range req.Platforms {
		root, ok := c.Sources[id]
		if !ok {
			return errors.New("NTFS_ORDER_SCOPE_INVALID")
		}
		if err = library.NoLinks(root); err != nil {
			return err
		}
		roots[id] = root
	}
	if req.Table {
		if req.Author != "" && (len(roots) != 1 || strings.ContainsAny(req.Author, `\/:`+"\x00") || req.Author == "." || req.Author == "..") {
			return errors.New("NTFS_AUTHOR_SCOPE_INVALID")
		}
		scopes := make([]TableScope, 0, len(roots))
		for id, root := range roots {
			scopes = append(scopes, TableScope{id, root, req.Author})
		}
		return RefreshTable(ctx, c.InstanceRoot, scopes, req.Incremental)
	}
	output := request + "l"
	f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	encoder := json.NewEncoder(f)
	var files, unknown int64
	err = Collect(ctx, roots, func(file MetadataFile) error {
		files++
		if file.Offset < 0 {
			unknown++
		}
		return encoder.Encode(OrderRecord{MetadataFile: file})
	})
	if err != nil {
		return err
	}
	if err = encoder.Encode(OrderRecord{Complete: true, Files: files, Unknown: unknown}); err != nil {
		return err
	}
	return f.Sync()
}
