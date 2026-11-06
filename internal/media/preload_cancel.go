package media

func (c *Cache) CancelPreload() error {
	c.mu.Lock()
	if c.preload == nil {
		c.mu.Unlock()
		return nil
	}
	if c.preload.cancel != nil {
		c.preload.cancel()
	}
	c.backgroundPaused = true
	c.preload.restartPlan = false
	c.preload.planning = false
	c.ready.Broadcast()
	c.mu.Unlock()
	_, err := c.index.db.ExecContext(c.ctx, "UPDATE cover_state SET paused=1 WHERE singleton=1;DELETE FROM cover_jobs WHERE state='pending'")
	return err
}
