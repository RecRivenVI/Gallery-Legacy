package personal

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/RecRivenVI/Gallery-Legacy/internal/catalog"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func (s *Store) Change(ctx context.Context, account string, c api.PersonalChange) error {
	platform, key, ok := reading.DecodePath(c.Work)
	if !ok {
		return failure("INVALID_PATH")
	}
	if c.Action == "rating" && (c.Number < 0 || c.Number > 5) {
		return failure("INVALID_PARAMETER")
	}
	if c.Action == "mode" && !slices.Contains([]string{"single", "double", "continuous"}, c.Text) {
		return failure("INVALID_PARAMETER")
	}
	if c.Action == "read" {
		prefs, err := s.Preferences(ctx, account)
		if err != nil {
			return err
		}
		var p struct {
			History *bool `json:"history"`
		}
		if err = json.Unmarshal(prefs, &p); err != nil {
			return fmt.Errorf("decode history preference: %w", err)
		}
		if p.History != nil && !*p.History {
			return nil
		}
		if c.Number < 1 {
			return failure("INVALID_PARAMETER")
		}
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO work_state(account_id,platform,relative_key,stable_path) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", account, platform, key, c.Work)
		if err != nil {
			return fmt.Errorf("prepare reading state: %w", err)
		}
		where := " WHERE account_id=? AND platform=? AND relative_key=?"
		identity := []any{account, platform, key}
		var query string
		args := []any{}
		switch c.Action {
		case "favorite":
			at := int64(0)
			if c.Value {
				at = time.Now().UnixMilli()
			}
			query = "UPDATE work_state SET favorite_at=?"
			args = append(args, at)
			if !c.Value {
				if _, err = tx.ExecContext(ctx, "DELETE FROM collection_works WHERE platform=? AND relative_key=? AND collection_id IN (SELECT id FROM collections WHERE account_id=?)", platform, key, account); err != nil {
					return fmt.Errorf("remove collection membership: %w", err)
				}
			}
		case "rating":
			query = "UPDATE work_state SET rating=?"
			args = append(args, c.Number)
		case "read":
			query = "UPDATE work_state SET page=?,read_at=?"
			args = append(args, c.Number, time.Now().UnixMilli())
		case "read.remove":
			query = "UPDATE work_state SET page=0,read_at=0"
		case "mode":
			query = "UPDATE work_state SET reading_mode=?,rtl=?,cover_alone=?"
			args = append(args, c.Text, c.RTL, c.CoverAlone)
		case "tag.add", "tag.remove":
			label := strings.TrimSpace(c.Text)
			if label == "" {
				return nil
			}
			if c.Action == "tag.add" {
				_, err = tx.ExecContext(ctx, "INSERT INTO work_tags VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", account, platform, key, label, catalog.Normalize(label))
			} else {
				_, err = tx.ExecContext(ctx, "DELETE FROM work_tags WHERE account_id=? AND platform=? AND relative_key=? AND normalized=?", account, platform, key, catalog.Normalize(label))
			}
			if err != nil {
				return fmt.Errorf("change personal tag: %w", err)
			}
			return nil
		case "collections":
			return setCollections(ctx, tx, account, platform, key, c.Work, c.Values)
		default:
			return failure("INVALID_PARAMETER")
		}
		_, err = tx.ExecContext(ctx, query+where, append(args, identity...)...)
		if err != nil {
			return fmt.Errorf("change reading state: %w", err)
		}
		return nil
	})
}

func (s *Store) ClearHistory(ctx context.Context, id string) error {
	_, err := s.DB.ExecContext(ctx, "UPDATE work_state SET page=0,read_at=0 WHERE account_id=?", id)
	if err != nil {
		return fmt.Errorf("clear reading history: %w", err)
	}
	return nil
}
func (s *Store) Tags(ctx context.Context, id string) ([]api.Tag, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT min(label),count(*) FROM work_tags WHERE account_id=? GROUP BY normalized ORDER BY normalized", id)
	if err != nil {
		return nil, fmt.Errorf("list personal tags: %w", err)
	}
	defer rows.Close()
	result := []api.Tag{}
	for rows.Next() {
		var t api.Tag
		if err = rows.Scan(&t.Label, &t.WorkCount); err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, rows.Err()
}
func (s *Store) Counts(ctx context.Context, id string) (map[string]int64, error) {
	var favorite, history int64
	if err := s.DB.QueryRowContext(ctx, "SELECT coalesce(sum(favorite_at>0),0),coalesce(sum(read_at>0),0) FROM work_state WHERE account_id=?", id).Scan(&favorite, &history); err != nil {
		return nil, fmt.Errorf("count personal works: %w", err)
	}
	return map[string]int64{"favorites": favorite, "history": history}, nil
}
