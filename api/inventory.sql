CREATE TABLE IF NOT EXISTS live_scan_files (
  work_id INTEGER NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  relative TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY(work_id,key)
) WITHOUT ROWID;
DELETE FROM media_declarations;
UPDATE media SET metadata_name=NULL,metadata_media_type=NULL,declared_size=NULL,remote_url=NULL,source_hash=NULL,duration_ms=NULL,source_media_id=NULL,metadata_ordinal=NULL;
DELETE FROM author_keys WHERE NOT (platform_id='pixiv' AND author_id IN (SELECT author_id FROM authors WHERE platform_id='pixivFANBOX'));
