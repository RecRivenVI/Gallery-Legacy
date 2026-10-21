package catalog

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/library"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type platformBinding struct {
	ID, Family, Root, Key string
	Enabled               bool
	Adapter, Shape        int
}

func rootKey(root string) string {
	return cases.Lower(language.Und).String(strings.TrimRight(filepath.Clean(root), "\\/"))
}
func bindings(def api.Catalog, sources map[string]string) ([]platformBinding, error) {
	if len(sources) != len(def.Platforms) {
		return nil, fmt.Errorf("NINE_SOURCE_BINDINGS_REQUIRED")
	}
	rows := []platformBinding{}
	for _, p := range def.Platforms {
		root := sources[p.ID]
		if !filepath.IsAbs(root) {
			return nil, fmt.Errorf("SOURCE_ROOT_ABSOLUTE_REQUIRED")
		}
		root = filepath.Clean(root)
		rows = append(rows, platformBinding{ID: p.ID, Family: p.Family, Root: root, Key: rootKey(root), Enabled: p.Enabled, Adapter: p.AdapterVersion, Shape: p.ShapePolicyVersion})
	}
	return rows, nil
}

func registryFingerprint(rows []platformBinding) (string, error) {
	facts := []map[string]any{}
	for _, p := range rows {
		facts = append(facts, map[string]any{"adapterVersion": p.Adapter, "enabled": p.Enabled, "family": p.Family, "id": p.ID, "physicalRoot": p.Root, "physicalRootKey": p.Key})
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(facts); err != nil {
		return "", err
	}
	text := strings.TrimSuffix(buffer.String(), "\n")
	text = strings.ReplaceAll(strings.ReplaceAll(text, `\u2028`, "\u2028"), `\u2029`, "\u2029")
	hash := sha256.Sum256([]byte(text))
	return hex.EncodeToString(hash[:]), nil
}

// CreateLive initializes a new work database without replacing an existing one.
// Publication follows a durable, no-replace rename after the FULL transaction.
func CreateLive(ctx context.Context, instance string, sources map[string]string) error {
	return CreateLiveFrom(ctx, instance, sources, nil)
}

// LiveBase is supplied only after recovery has validated a READY checkpoint.
type LiveBase struct{ CatalogPath, GenerationID string }

func CreateLiveFrom(ctx context.Context, instance string, sources map[string]string, base *LiveBase) error {
	def, err := api.LoadCatalog()
	if err != nil {
		return err
	}
	rows, err := bindings(def, sources)
	if err != nil {
		return err
	}
	file, release, err := reserveLiveTarget(instance, rows)
	if err != nil {
		return err
	}
	defer release()
	directory := filepath.Dir(file)
	uuid, err := randomUUID()
	if err != nil {
		return err
	}
	temp := filepath.Join(directory, ".initializing-"+uuid+".sqlite")
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if base != nil {
		if err = copyLiveBase(ctx, temp, base, sources); err != nil {
			return err
		}
	}
	writer, err := sql.Open("sqlite", temp)
	if err != nil {
		return err
	}
	writer.SetMaxOpenConns(1)
	if err = initializeLive(ctx, writer, def, rows, uuid, base); err != nil {
		writer.Close()
		return err
	}
	if _, err = writer.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		writer.Close()
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	return installNewFile(temp, file)
}

func reserveLiveTarget(instance string, rows []platformBinding) (string, func(), error) {
	if !filepath.IsAbs(instance) {
		return "", nil, fmt.Errorf("INSTANCE_ROOT_ABSOLUTE_REQUIRED")
	}
	for _, p := range rows {
		if library.Inside(p.Root, instance) || library.Inside(instance, p.Root) {
			return "", nil, fmt.Errorf("SOURCE_RUNTIME_OVERLAP")
		}
	}
	if err := library.NoLinks(instance); err != nil {
		return "", nil, err
	}
	for _, directory := range []string{"live", "state"} {
		if err := os.MkdirAll(filepath.Join(instance, directory), 0700); err != nil {
			return "", nil, err
		}
	}
	file := filepath.Join(instance, "live/catalog.sqlite")
	if err := library.NoLinks(file); err != nil {
		return "", nil, err
	}
	release, err := library.Lease(filepath.Join(instance, "state/go-scan.lock"))
	if err != nil {
		return "", nil, err
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if _, err = os.Lstat(file + suffix); !os.IsNotExist(err) {
			release()
			if err != nil {
				return "", nil, err
			}
			return "", nil, fmt.Errorf("LIVE_OUTPUT_EXISTS")
		}
	}
	return file, release, nil
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&15 | 64
	value[8] = value[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}

func initializeLive(ctx context.Context, db *sql.DB, def api.Catalog, rows []platformBinding, epoch string, base *LiveBase) error {
	for _, pragma := range []string{"foreign_keys=ON", "journal_mode=WAL", "synchronous=FULL"} {
		if _, err := db.ExecContext(ctx, "PRAGMA "+pragma); err != nil {
			return err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if base == nil {
		if err = initializeFacts(ctx, tx, def, rows); err != nil {
			return err
		}
	}
	for _, ddl := range []string{api.LiveCoreSQL, api.LiveSearchSQL, api.LiveStatsSQL, api.LiveLedgerSQL} {
		if _, err = tx.ExecContext(ctx, ddl); err != nil {
			return fmt.Errorf("create catalog schema: %w", err)
		}
	}
	var baseID any
	if base != nil {
		baseID = base.GenerationID
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO live_meta VALUES (1,?,?,?,0,?)", def.LiveSchemaVersion, baseID, epoch, time.Now().UnixMilli()); err != nil {
		return err
	}
	for entity, table := range map[string]string{"author": "authors", "work": "works", "media": "media", "tag": "tags"} {
		if _, err = tx.ExecContext(ctx, "INSERT INTO live_id_high_water SELECT ?,coalesce(max("+entity+"_id),0) FROM "+table, entity); err != nil {
			return err
		}
	}
	if err = rebuildStats(ctx, tx); err != nil {
		return err
	}
	if base != nil {
		if err = rebuildSearch(ctx, tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func initializeFacts(ctx context.Context, tx *sql.Tx, def api.Catalog, rows []platformBinding) error {
	if _, err := tx.ExecContext(ctx, api.CatalogSQL); err != nil {
		return err
	}
	fingerprint, err := registryFingerprint(rows)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO catalog_state VALUES (1,?,0,?,?,?,?,NULL,NULL,NULL,?)", def.SchemaVersion, time.Now().UnixMilli(), def.AdapterContractVersion, def.ShapeSignatureVersion, def.AuthorityContractVersion, fingerprint); err != nil {
		return err
	}
	for _, p := range rows {
		enabled := 0
		if p.Enabled {
			enabled = 1
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO platforms VALUES (?,?,?,?,?,?,?)", p.ID, p.Family, p.Root, p.Key, enabled, p.Adapter, p.Shape); err != nil {
			return err
		}
	}
	return nil
}

func copyLiveBase(ctx context.Context, temp string, base *LiveBase, sources map[string]string) error {
	if !generationPattern.MatchString(base.GenerationID) {
		return fmt.Errorf("GENERATION_ID_INVALID")
	}
	if err := library.NoLinks(base.CatalogPath); err != nil {
		return err
	}
	u := url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(base.CatalogPath)}
	u.RawQuery = "mode=ro&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	err = VerifyContract(ctx, db, ContractOptions{Sources: sources})
	db.Close()
	if err != nil {
		return err
	}
	source, err := os.Open(base.CatalogPath)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(temp, os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	if err = target.Sync(); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}

func rebuildSearch(ctx context.Context, tx *sql.Tx) error {
	owner := &Writer{prepared: map[string]*sql.Stmt{}}
	t := transaction{ctx: ctx, tx: tx, owner: owner, stmt: map[string]*sql.Stmt{}, tags: map[int64]bool{}, normalizer: NormalizeQuery}
	defer t.close()
	for _, entity := range []struct {
		table, id string
		refresh   func(*transaction, int64) error
	}{
		{"works", "work_id", func(t *transaction, id int64) error { return refreshWork(t, id, false) }},
		{"authors", "author_id", refreshAuthor},
		{"tags", "tag_id", refreshTag},
	} {
		var after int64
		for {
			rows, err := tx.QueryContext(ctx, "SELECT "+entity.id+" FROM "+entity.table+" WHERE "+entity.id+">? ORDER BY "+entity.id+" LIMIT 500", after)
			if err != nil {
				return err
			}
			ids := []int64{}
			for rows.Next() {
				var id int64
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				ids = append(ids, id)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			if len(ids) == 0 {
				break
			}
			for _, id := range ids {
				if err = entity.refresh(&t, id); err != nil {
					return err
				}
			}
			after = ids[len(ids)-1]
		}
	}
	return nil
}
