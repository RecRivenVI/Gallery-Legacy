CREATE TABLE IF NOT EXISTS work_details (
  work_id INTEGER PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  work_type TEXT NOT NULL,
  rating INTEGER CHECK(rating IS NULL OR rating IN(0,1,2)),
  series_id TEXT NOT NULL,
  details_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_idx_work_details_type ON work_details(work_type,work_id);
CREATE INDEX IF NOT EXISTS live_idx_work_details_rating ON work_details(rating,work_id);
CREATE INDEX IF NOT EXISTS live_idx_work_details_series ON work_details(series_id,work_id);
CREATE TABLE IF NOT EXISTS author_keys (
  author_id INTEGER NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY(author_id,platform_id,source_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS live_idx_author_keys_identity ON author_keys(platform_id,source_id,author_id);
