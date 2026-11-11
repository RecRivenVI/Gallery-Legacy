package media

func (c *Cache) CancelPreload() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.preload == nil {
		return nil
	}
	if c.preload.cancel != nil {
		c.preload.cancel()
	}
	c.backgroundPaused = true
	c.preload.restartPlan = false
	c.preload.planning = false
	c.preload.failure = ""
	c.ready.Broadcast()
	tx, err := c.index.db.BeginTx(c.ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(c.ctx, "UPDATE cover_state SET paused=1,replan=0 WHERE singleton=1;DELETE FROM cover_jobs WHERE state IN ('pending','running');DELETE FROM cover_task"); err != nil {
		return err
	}
	return tx.Commit()
}
