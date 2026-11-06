package catalog

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/gob"
	"errors"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
	"sort"
	"strings"
)

func stageEncode(value any) ([]byte, error) {
	var b bytes.Buffer
	err := gob.NewEncoder(&b).Encode(value)
	return b.Bytes(), err
}

func decodeStageRow(b []byte) (Row, error) {
	var row Row
	err := gob.NewDecoder(bytes.NewReader(b)).Decode(&row)
	return row, err
}

func stageRow(tx *sql.Tx, ctx context.Context, collection string, ordinal int, value Row) error {
	b, err := stageEncode(value)
	if err != nil {
		return fmt.Errorf("encode work stage row: %w", err)
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO stage_records VALUES (?,?,?)", collection, ordinal, b)
	return err
}

// Stage bodies are durable before their complete marker. Reading an interrupted
// stage fails the work transaction; no partial media or Search becomes visible.
func sealPrepared(ctx context.Context, db *sql.DB, p *PreparedWork) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for table, rows := range p.Children {
		for i, r := range rows {
			if err = stageRow(tx, ctx, table, i, r); err != nil {
				return err
			}
		}
	}
	for i, r := range p.Media {
		if err = stageRow(tx, ctx, "media", i, r); err != nil {
			return err
		}
	}
	p.Children, p.Media = nil, nil
	p.Normalized.Primary, p.Normalized.Supplementary = nil, nil
	p.Normalized.Structured = nil
	p.Normalized.Work, p.Normalized.Flags, p.Normalized.Access, p.Normalized.Metrics = nil, nil, nil, nil
	p.Normalized.Relations, p.Normalized.Evidence = nil, nil
	p.Bytes = int64(len(metadata.JSON(p)))
	if _, err = tx.ExecContext(ctx, "UPDATE stage_state SET complete=1 WHERE singleton=1"); err != nil {
		return err
	}
	return tx.Commit()
}

type preparedRows struct {
	db *sql.DB
	p  PreparedWork
}

func openPrepared(ctx context.Context, p PreparedWork) (*preparedRows, error) {
	r := &preparedRows{p: p}
	if p.StageFile == "" {
		return r, nil
	}
	u := "file:/" + strings.ReplaceAll(p.StageFile, `\`, "/") + "?mode=ro&_pragma=cache_size(-4096)"
	db, err := sql.Open("sqlite", u)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var complete int
	if err = db.QueryRowContext(ctx, "SELECT complete FROM stage_state WHERE singleton=1").Scan(&complete); err != nil || complete != 1 {
		db.Close()
		return nil, errors.New("WORK_STAGE_INCOMPLETE")
	}
	r.db = db
	return r, nil
}

func (r *preparedRows) close() {
	if r.db != nil {
		r.db.Close()
	}
}

func (r *preparedRows) each(ctx context.Context, collection string, accept func(Row) error) error {
	if r.db == nil {
		rows := r.p.Children[collection]
		if collection == "media" {
			rows = r.p.Media

		}
		for _, row := range rows {
			if err := accept(row); err != nil {
				return err
			}
		}
		return ctx.Err()
	}
	rows, err := r.db.QueryContext(ctx, "SELECT payload FROM stage_records WHERE collection=? ORDER BY ordinal", collection)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		var row Row
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = gob.NewDecoder(bytes.NewReader(b)).Decode(&row); err != nil {
			return fmt.Errorf("WORK_STAGE_INCOMPLETE: %w", err)
		}
		if err = accept(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (r *preparedRows) collections(ctx context.Context) ([]string, error) {
	if r.db == nil {
		names := make([]string, 0, len(r.p.Children))
		for name := range r.p.Children {
			names = append(names, name)
		}
		sort.Strings(names)
		return names, nil
	}
	rows, err := r.db.QueryContext(ctx, "SELECT DISTINCT collection FROM stage_records WHERE collection <> 'media' ORDER BY collection")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err = rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}
