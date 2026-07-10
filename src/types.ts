export interface AtlasPublicApiEntry {
  name: string;
  type: string;
  signature?: string;
  description?: string;
}

export interface AtlasKeyTypeEntry {
  name: string;
  kind: string;
  exported: boolean;
  description?: string;
}

/**
 * Wave 44 — structured hazard entry with optional line-range metadata. Stored
 * in the `hazards_with_ranges` column on atlas_files (relay/src/atlas/migrations/
 * 0011_hazards_with_ranges.sql), parallel to the legacy `hazards: string[]`
 * column which remains the canonical text-only hazard array. Phase 1 ships
 * zero behavior change for hint helpers / FTS / lookup output; the new field
 * is populated only when atlas_commit callers opt in via the matching input
 * parameter on the atlas_commit handler (relay/src/atlas/tools/commit.ts).
 *
 * Phase 2 (NOT this wave) will wire buildLookupHint / buildBriefHint /
 * buildSnippetHint in relay/src/atlas/tools/query.ts to read this field and
 * surface line-range-aware advice (the long-deferred "hazard line-range
 * granularity" enhancement from Waves 35-38 signposts).
 *
 * `startLine` and `endLine` are 1-indexed file line numbers and may both be
 * null when a hazard applies to the file as a whole (the "file-level hazard"
 * case the hint helpers currently emit for ALL hazards in pre-Wave-44).
 */
export interface AtlasHazardWithRange {
  text: string;
  startLine?: number | null;
  endLine?: number | null;
}

/**
 * AI-curated source code snippet. During atlas_commit, the agent selects the
 * most important/relevant sections of the file — potentially disjointed segments
 * from a large file. This replaces naive top-N line truncation with intelligent
 * curation by the agent that has maximum context.
 *
 * Snippets are numbered for referencing: changelog entries can say "refer to snippet 3".
 */
export interface SourceHighlight {
  /** 1-indexed snippet number for referencing ("see snippet 3") */
  id: number;
  /** Optional description ("main export", "error handling", "config parsing") */
  label?: string;
  /** 1-indexed start line in the source file */
  startLine: number;
  /** 1-indexed end line in the source file */
  endLine: number;
  /** The actual source code text of this segment */
  content: string;
}

export type AtlasSourceChunkKind = 'highlight' | 'raw';

export interface AtlasSourceChunk {
  kind: AtlasSourceChunkKind;
  label: string | null;
  startLine: number;
  endLine: number;
  content: string;
  textHash: string;
}

export interface AtlasFileExtraction {
  purpose: string;
  public_api: AtlasPublicApiEntry[];
  exports?: Array<{ name: string; type: string }>;
  patterns: string[];
  tags: string[];
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: AtlasKeyTypeEntry[];
  hazards: string[];
  /** Wave 44 — optional structured hazard entries with line-range metadata. Parallel to `hazards` (legacy text-only). Phase 1: writer-side opt-in only; no readers yet. See AtlasHazardWithRange JSDoc. */
  hazards_with_ranges?: AtlasHazardWithRange[];
  conventions: string[];
}

export interface AtlasCrossRefCallSite {
  file: string;
  usage_type: string;
  count: number;
  context: string;
}

export interface AtlasCrossRefSymbol {
  type: string;
  call_sites: AtlasCrossRefCallSite[];
  total_usages: number;
  blast_radius: string;
}

export interface AtlasCrossRefs {
  symbols: Record<string, AtlasCrossRefSymbol>;
  total_exports_analyzed: number;
  total_cross_references: number;
  crossref_model?: string;
  crossref_timestamp?: string;
}

export interface AtlasFileRecord {
  id: number;
  workspace: string;
  file_path: string;
  file_hash: string | null;
  cluster: string | null;
  loc: number;
  blurb: string;
  purpose: string;
  public_api: unknown[];
  exports: Array<{ name: string; type: string }>;
  patterns: string[];
  tags: string[];
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: unknown[];
  hazards: string[];
  /** Wave 44 — structured hazard entries with optional line-range metadata, populated from the hazards_with_ranges DB column. Always present (defaults to []) so callers do not need to nullish-check. Parallel to `hazards` (canonical text-only). See AtlasHazardWithRange JSDoc. */
  hazards_with_ranges: AtlasHazardWithRange[];
  conventions: string[];
  cross_refs: AtlasCrossRefs | null;
  source_highlights: SourceHighlight[];
  language: string;
  extraction_model: string | null;
  last_extracted: string | null;
}

export interface AtlasEmbeddingRecord {
  file_id: number;
  embedding: Buffer | string;
}

export interface AtlasQueueRecord {
  id: number;
  workspace: string;
  file_path: string;
  trigger_reason: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: string;
  error_message: string | null;
}

export type AtlasFileWitnessInteraction =
  | 'read'
  | 'searched'
  | 'edited'
  | 'committed'
  | 'reviewed'
  | 'discussed'
  | 'claimed'
  | 'other';

export interface AtlasFileWitnessEvidence {
  interaction: AtlasFileWitnessInteraction;
  eventId: string | null;
  turnId: string | null;
  toolName: string | null;
  createdAt: string;
}

export interface AtlasFileWitnessRecord {
  id: number;
  workspace: string;
  file_path: string;
  instance_id: string;
  instance_name: string | null;
  engine: string | null;
  interaction_counts: Partial<Record<AtlasFileWitnessInteraction, number>>;
  evidence: AtlasFileWitnessEvidence[];
  confidence: number;
  first_seen_at: string;
  last_seen_at: string;
  last_event_id: string | null;
  last_turn_id: string | null;
  last_tool: string | null;
  last_interaction: AtlasFileWitnessInteraction;
}

export interface AtlasMetaRecord {
  workspace: string;
  source_root: string;
  updated_at: string;
}

export interface AtlasServerConfig {
  workspace: string;
  sourceRoot: string;
  dbPath: string;
  concurrency: number;
  sqliteVecExtension: string;
  embeddingModel: string;
  embeddingDimensions: number;
  force?: boolean;
}

export interface AtlasRuntime {
  config: AtlasServerConfig;
  db: import('./db.js').AtlasDatabase;
  server?: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
}
