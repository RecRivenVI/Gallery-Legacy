package media

import (
	"database/sql"
)

func (c *Cache) takeCover(disk string) (coverJob, bool, error) {
	var j coverJob
	tx, err := c.index.db.BeginTx(c.ctx, nil)
	if err != nil {
		return j, false, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(c.ctx, `SELECT key,platform,relative,work_id,media_id,kind,size,mtime,disk,media_relative FROM cover_jobs WHERE disk=? AND state='pending' ORDER BY CASE WHEN position>=0 THEN 0 ELSE 1 END,position,work_id LIMIT 1`, disk).Scan(&j.key, &j.platform, &j.relative, &j.work, &j.media, &j.kind, &j.size, &j.mtime, &j.disk, &j.mediaRelative)
	if err == sql.ErrNoRows {
		return j, false, nil
	}
	if err != nil {
		return j, false, err
	}
	if _, err = tx.ExecContext(c.ctx, "UPDATE cover_jobs SET state='running' WHERE key=?", j.key); err != nil {
		return j, false, err
	}
	return j, true, tx.Commit()
}
