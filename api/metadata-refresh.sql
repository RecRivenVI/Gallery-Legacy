-- Optional task state. Keep it outside the live fact tables so older
-- candidates can still open a catalog after a rollback.
CREATE TABLE IF NOT EXISTS metadata_refresh (
  work_id INTEGER PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  adapter_version INTEGER NOT NULL,
  title_fix INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT -1,
  state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS metadata_refresh_order ON metadata_refresh(state,(position<0),position,work_id);
CREATE TABLE IF NOT EXISTS metadata_refresh_rules (
  name TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metadata_refresh_authors (
  author_id INTEGER PRIMARY KEY REFERENCES authors(author_id) ON DELETE CASCADE,
  projection BLOB NOT NULL
);
