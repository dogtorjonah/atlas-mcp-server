-- Replace the historical standalone candidate-memory storage name with the
-- public operator-memory schema while preserving every row and relationship.
--
-- Migration 0012 is immutable and may already be recorded by 0.1.0 databases,
-- so its legacy table and index identifiers are recognized only as this
-- migration's input. Current code opens and writes atlas_operator_memory.

ALTER TABLE atlas_jonah_memory RENAME TO atlas_operator_memory;

DROP INDEX IF EXISTS idx_jonah_memory_workspace_created;
DROP INDEX IF EXISTS idx_jonah_memory_category;
DROP INDEX IF EXISTS idx_jonah_memory_changelog;
DROP INDEX IF EXISTS idx_jonah_memory_dedupe;

CREATE INDEX IF NOT EXISTS idx_operator_memory_workspace_created
  ON atlas_operator_memory(workspace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_memory_category
  ON atlas_operator_memory(workspace, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_memory_changelog
  ON atlas_operator_memory(workspace, changelog_id);

CREATE INDEX IF NOT EXISTS idx_operator_memory_dedupe
  ON atlas_operator_memory(workspace, dedupe_key);
