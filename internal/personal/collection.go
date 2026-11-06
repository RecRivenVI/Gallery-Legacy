package personal

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/api"
	"github.com/google/uuid"
)

func (s *Store) Collections(ctx context.Context, account string) ([]api.Collection, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT c.id,c.name,count(cw.stable_path),coalesce(max(cw.added_at),0) FROM collections c LEFT JOIN collection_works cw ON cw.collection_id=c.id WHERE c.account_id=? GROUP BY c.id ORDER BY c.name", account)
	if err != nil {
		return nil, fmt.Errorf("list collections: %w", err)
	}
	result := []api.Collection{}
	for rows.Next() {
		var c api.Collection
		c.Covers = []string{}
		if err = rows.Scan(&c.ID, &c.Name, &c.Count, &c.LatestAt); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		rows, err = s.DB.QueryContext(ctx, "SELECT stable_path FROM collection_works WHERE collection_id=? ORDER BY added_at DESC LIMIT 3", result[i].ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var p string
			if err = rows.Scan(&p); err != nil {
				rows.Close()
				return nil, err
			}
			result[i].Covers = append(result[i].Covers, p)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (s *Store) Collection(ctx context.Context, account, id, name, action string) (string, error) {
	if action == "delete" {
		_, err := s.DB.ExecContext(ctx, "DELETE FROM collections WHERE id=? AND account_id=?", id, account)
		if err != nil {
			return "", fmt.Errorf("delete collection: %w", err)
		}
		return id, nil
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", failure("COLLECTION_NAME_REQUIRED")
	}
	if id == "" {
		id = uuid.NewString()
		_, err := s.DB.ExecContext(ctx, "INSERT INTO collections VALUES(?,?,?,?)", id, account, name, time.Now().UnixMilli())
		if err != nil {
			return "", fmt.Errorf("create collection: %w", err)
		}
	} else {
		_, err := s.DB.ExecContext(ctx, "UPDATE collections SET name=? WHERE id=? AND account_id=?", name, id, account)
		if err != nil {
			return "", fmt.Errorf("rename collection: %w", err)
		}
	}
	return id, nil
}
func setCollections(ctx context.Context, tx *sql.Tx, account, platform, key, path string, ids []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM collection_works WHERE platform=? AND relative_key=? AND collection_id IN(SELECT id FROM collections WHERE account_id=?)", platform, key, account); err != nil {
		return fmt.Errorf("replace collection membership: %w", err)
	}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		result, err := tx.ExecContext(ctx, "INSERT INTO collection_works SELECT id,?,?,?,? FROM collections WHERE id=? AND account_id=? ON CONFLICT DO NOTHING", platform, key, path, now, id, account)
		if err != nil {
			return fmt.Errorf("add collection work: %w", err)
		}
		if changed, err := result.RowsAffected(); err != nil {
			return fmt.Errorf("read collection membership change: %w", err)
		} else if changed == 0 {
			return failure("COLLECTION_NOT_FOUND")
		}
	}
	if len(ids) > 0 {
		_, err := tx.ExecContext(ctx, "UPDATE work_state SET favorite_at=CASE WHEN favorite_at>0 THEN favorite_at ELSE ? END WHERE account_id=? AND platform=? AND relative_key=?", now, account, platform, key)
		if err != nil {
			return fmt.Errorf("favorite collection work: %w", err)
		}
	}
	return nil
}
