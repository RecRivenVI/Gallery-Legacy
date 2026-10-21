// Package recovery opens immutable READY checkpoints and validates their bindings.
package recovery

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

const catalogRelative = "catalog/gallery-v4.sqlite"
const searchRelative = "search/gallery-search.sqlite"

func readJSON(file string, value any) error {
	if err := library.NoLinks(file); err != nil {
		return err
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("GENERATION_MANIFEST_INVALID: %w", err)
	}
	if len(bytes) == 0 || bytes[0] == '[' || strings.TrimSpace(string(bytes)) == "null" {
		return fmt.Errorf("GENERATION_MANIFEST_INVALID")
	}
	if err = json.Unmarshal(bytes, value); err != nil {
		return fmt.Errorf("GENERATION_MANIFEST_INVALID: %w", err)
	}
	return nil
}

func existingReadOnly(ctx context.Context, file string) (*sql.DB, error) {
	if err := library.NoLinks(file); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(file, "\\", "/")}
	params := u.Query()
	params.Set("mode", "ro")
	params.Add("_pragma", "foreign_keys(1)")
	u.RawQuery = params.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func FileIdentity(ctx context.Context, file string) (Identity, error) {
	var identity Identity
	if err := library.NoLinks(file); err != nil {
		return identity, err
	}
	fd, err := os.Open(file)
	if err != nil {
		return identity, fmt.Errorf("GENERATION_FILE_STAT_FAILED: %w", err)
	}
	defer fd.Close()
	st, err := fd.Stat()
	if err != nil {
		return identity, err
	}
	if st.Size() > 9007199254740991 {
		return identity, fmt.Errorf("GENERATION_FILE_SIZE_UNSAFE")
	}
	identity.SizeBytes = st.Size()
	identity.MtimeMS = st.ModTime().UnixMilli()
	hash := sha256.New()
	buffer := make([]byte, 1<<20)
	for {
		if err = ctx.Err(); err != nil {
			return identity, err
		}
		n, readErr := fd.Read(buffer)
		if n > 0 {
			if _, err = hash.Write(buffer[:n]); err != nil {
				return identity, err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return identity, readErr
		}
	}
	identity.SHA256 = hex.EncodeToString(hash.Sum(nil))
	return identity, nil
}

func paths(instance, generations, id string) (string, error) {
	if !filepath.IsAbs(instance) || (generations != "" && !filepath.IsAbs(generations)) {
		return "", fmt.Errorf("GENERATION_PATH_NOT_ABSOLUTE")
	}
	if !idPattern.MatchString(id) {
		return "", fmt.Errorf("GENERATION_ID_INVALID")
	}
	if generations == "" {
		generations = filepath.Join(instance, "generations")
	}
	if !library.Inside(instance, generations) || filepath.Clean(instance) == filepath.Clean(generations) {
		return "", fmt.Errorf("GENERATION_PATH_ESCAPE")
	}
	root := filepath.Join(generations, id)
	if err := library.NoLinks(root); err != nil {
		return "", err
	}
	return root, nil
}
