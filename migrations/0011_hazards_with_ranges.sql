-- Adds a parallel `hazards_with_ranges` TEXT column to atlas_files for storing
-- structured hazard entries with optional line ranges, alongside the existing
-- `hazards` TEXT column. The empty-array default keeps existing rows readable,
-- and writers may opt in without requiring an immediate data backfill.
--
-- Type contract (src/types.ts):
--   interface AtlasHazardWithRange {
--     text: string;
--     startLine?: number | null;
--     endLine?: number | null;
--   }
--   AtlasFileExtraction.hazards_with_ranges?: AtlasHazardWithRange[]
--   AtlasFileRecord.hazards_with_ranges: AtlasHazardWithRange[]
--
-- Reader/writer (src/db.ts):
--   mapFileRecord       — parses JSON into AtlasHazardWithRange[]
--   upsertFileRecord    — JSON.stringify(record.hazards_with_ranges ?? [])
--   AtlasFileUpsertInput.hazards_with_ranges?: AtlasHazardWithRange[]
--
-- Handler (src/tools/commit.ts):
--   atlas_commit accepts optional hazards_with_ranges entries and passes them
--   through to upsertFileRecord.
--
-- Readers union structured and legacy hazard text. File-level structured
-- entries use null startLine/endLine values.

ALTER TABLE atlas_files
  ADD COLUMN hazards_with_ranges TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(hazards_with_ranges));
