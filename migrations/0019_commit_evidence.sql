ALTER TABLE atlas_changelog ADD COLUMN attribution_json TEXT
  CHECK (attribution_json IS NULL OR json_valid(attribution_json));

CREATE TABLE IF NOT EXISTS atlas_provenance_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  changelog_id INTEGER NOT NULL REFERENCES atlas_changelog(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_atlas_provenance_evidence_changelog
  ON atlas_provenance_evidence(workspace, changelog_id, id);
