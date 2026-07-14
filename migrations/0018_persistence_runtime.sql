ALTER TABLE atlas_schema_migrations ADD COLUMN checksum TEXT;

CREATE TABLE IF NOT EXISTS atlas_store_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS atlas_operation_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_atlas_operation_idempotency_created
  ON atlas_operation_idempotency(created_at);
