import type {
  AtlasCrossRefs,
  AtlasHazardWithRange,
  SourceHighlight,
} from './core/types.js';

export * from './core/types.js';

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
  /** Structured hazards from the database; always present and defaulting to an empty array. */
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
