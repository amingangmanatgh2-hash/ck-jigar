-- Two storage tiers for files: R2 is the hot tier (every upload lands there), Google Drive the cold tier.
-- A background job moves old or large files to Drive so the R2 bucket does not fill up; downloads are proxied
-- through the Worker (with the usual access checks), so clients never see where a file lives.

ALTER TABLE files ADD COLUMN tier TEXT NOT NULL DEFAULT 'r2' CHECK (tier IN ('r2', 'moving', 'drive'));
ALTER TABLE files ADD COLUMN drive_id TEXT;
ALTER TABLE files ADD COLUMN tier_changed_at INTEGER;
-- set once the stored bytes of a deleted file are really gone (R2 object or Drive file), so a failed delete is retried
ALTER TABLE files ADD COLUMN purged_at INTEGER;

-- The offload job runs every few minutes: each of its queries must read only the rows it will act on, never the whole table.
-- (SQLite uses a partial index only when the query repeats its WHERE terms literally — the job's SQL does.)
CREATE INDEX idx_files_tier_age ON files (tier, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_large ON files (size) WHERE tier = 'r2' AND deleted_at IS NULL;
CREATE INDEX idx_files_unpurged ON files (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_files_purged ON files (purged_at) WHERE purged_at IS NOT NULL;

-- Small key/value state of the storage layer (Drive folder id, health of the Drive connection, last job run …).
CREATE TABLE storage_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
