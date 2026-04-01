export type AtlasProviderName = 'openai' | 'anthropic' | 'ollama' | 'gemini';

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

export interface AtlasFileExtraction {
  purpose: string;
  public_api: AtlasPublicApiEntry[];
  exports?: Array<{ name: string; type: string }>;
  patterns: string[];
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: AtlasKeyTypeEntry[];
  hazards: string[];
  conventions: string[];
}

export interface AtlasProvider {
  kind: AtlasProviderName;
  generateBlurb(input: {
    filePath: string;
    sourceText: string;
  }): Promise<string>;
  extractFile(input: {
    filePath: string;
    sourceText: string;
    blurb: string;
  }): Promise<AtlasFileExtraction>;
  embedText(text: string): Promise<number[]>;
  extractCrossRefs(input: {
    filePath: string;
    symbolName?: string;
    sourceText?: string;
  }): Promise<unknown>;
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
  pass2_model?: string;
  pass2_timestamp?: string;
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
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: unknown[];
  hazards: string[];
  conventions: string[];
  cross_refs: AtlasCrossRefs | null;
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

export interface AtlasMetaRecord {
  workspace: string;
  source_root: string;
  provider: string | null;
  provider_config: Record<string, unknown>;
  updated_at: string;
}

export interface AtlasServerConfig {
  workspace: string;
  sourceRoot: string;
  dbPath: string;
  provider: AtlasProviderName;
  openAiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  voyageApiKey: string;
  ollamaBaseUrl: string;
  concurrency: number;
  sqliteVecExtension: string;
}

export interface AtlasRuntime {
  config: AtlasServerConfig;
  db: import('./db.js').AtlasDatabase;
  provider?: AtlasProvider;
  server?: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
}
