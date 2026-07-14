/** JSON values accepted at Atlas serialization boundaries. */
export type AtlasJsonPrimitive = string | number | boolean | null;

export type AtlasJsonValue =
  | AtlasJsonPrimitive
  | { readonly [key: string]: AtlasJsonValue }
  | readonly AtlasJsonValue[];

export type AtlasJsonObject = Readonly<Record<string, AtlasJsonValue>>;

export type AtlasOutputFormat = 'json' | 'text';
export type AtlasCapabilityStatus = 'available' | 'degraded' | 'unavailable' | 'disabled';
export type AtlasVerificationStatus = 'pending' | 'verified' | 'disputed' | 'needs_review';
export type AtlasEvidenceConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type AtlasEvidenceCompleteness = 'complete' | 'partial' | 'not_applicable' | 'unknown';
export type AtlasEvidenceFreshness = 'current' | 'stale' | 'historical' | 'unknown';
export type AtlasEvidenceAuthority =
  | 'workspace_disk'
  | 'atlas_store'
  | 'repository'
  | 'provider'
  | 'mixed'
  | 'unknown';

export type AtlasPrincipalKind = 'human' | 'service' | 'automation' | 'unknown';

export interface AtlasPrincipal {
  id?: string;
  displayName?: string;
  kind: AtlasPrincipalKind;
}

export interface AtlasAttribution {
  principal?: AtlasPrincipal;
  runtime?: {
    name?: string;
    version?: string;
  };
  toolId?: string;
  source?: string;
}

export type AtlasEvidenceSubjectKind = 'file' | 'symbol' | 'snapshot' | 'changelog' | 'operation';
export type AtlasEvidenceKind =
  | 'authored'
  | 'observed'
  | 'modified'
  | 'committed'
  | 'reviewed'
  | 'referenced'
  | 'other';
export type AtlasProvenanceAuthority = 'caller' | 'repository' | 'provider' | 'verified-external';

export interface AtlasProvenanceEvidence {
  namespace: string;
  schemaVersion: string;
  providerId: string;
  providerVersion: string;
  evidenceId: string;
  subject: {
    kind: AtlasEvidenceSubjectKind;
    workspace: string;
    key: string;
  };
  kind: AtlasEvidenceKind;
  principal?: AtlasPrincipal;
  occurredAt?: string;
  observedAt: string;
  authority: AtlasProvenanceAuthority;
  confidence: AtlasEvidenceConfidence;
  sourceRef?: string;
  payload: AtlasJsonValue;
  payloadHash: string;
}

export interface AtlasPrincipalWire {
  id?: string;
  display_name?: string;
  kind: AtlasPrincipalKind;
}

export interface AtlasAttributionWire {
  principal?: AtlasPrincipalWire;
  runtime?: {
    name?: string;
    version?: string;
  };
  tool_id?: string;
  source?: string;
}

export interface AtlasProvenanceEvidenceWire {
  namespace: string;
  schema_version: string;
  provider_id: string;
  provider_version: string;
  evidence_id: string;
  subject: {
    kind: AtlasEvidenceSubjectKind;
    workspace: string;
    key: string;
  };
  kind: AtlasEvidenceKind;
  principal?: AtlasPrincipalWire;
  occurred_at?: string;
  observed_at: string;
  authority: AtlasProvenanceAuthority;
  confidence: AtlasEvidenceConfidence;
  source_ref?: string;
  payload: AtlasJsonValue;
  payload_hash: string;
}

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

export interface AtlasExportEntry {
  name: string;
  type: string;
}

/** A 1-indexed inclusive source range. */
export interface AtlasLineRange {
  startLine: number;
  endLine: number;
}

/** A text hazard that may apply to a source range or the whole file. */
export interface AtlasHazardWithRange {
  text: string;
  startLine?: number | null;
  endLine?: number | null;
}

export interface AtlasSourceHighlight extends AtlasLineRange {
  id: number;
  label?: string;
  content: string;
}

/** Compatibility name used by the 0.1 implementation. */
export type SourceHighlight = AtlasSourceHighlight;

export type AtlasSourceChunkKind = 'highlight' | 'raw';

export interface AtlasSourceChunk extends AtlasLineRange {
  kind: AtlasSourceChunkKind;
  label: string | null;
  content: string;
  textHash: string;
}

export interface AtlasFileExtraction {
  purpose: string;
  public_api: AtlasPublicApiEntry[];
  exports?: AtlasExportEntry[];
  patterns: string[];
  tags: string[];
  dependencies: AtlasJsonObject;
  data_flows: string[];
  key_types: AtlasKeyTypeEntry[];
  hazards: string[];
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

export interface AtlasCrossReferenceCallSite {
  file: string;
  usageType: string;
  count: number;
  context: string;
}

export interface AtlasCrossReferenceSymbol {
  type: string;
  callSites: readonly AtlasCrossReferenceCallSite[];
  totalUsages: number;
  blastRadius: string;
}

export interface AtlasCrossReferences {
  symbols: Readonly<Record<string, AtlasCrossReferenceSymbol>>;
  totalExportsAnalyzed: number;
  totalCrossReferences: number;
  provider?: string;
  generatedAt?: string;
}

/** Stable host-neutral file record used by the public core and service ports. */
export interface AtlasFile {
  id: number;
  workspace: string;
  filePath: string;
  fileHash: string | null;
  cluster: string | null;
  lineCount: number;
  blurb: string;
  purpose: string;
  publicApi: readonly AtlasPublicApiEntry[];
  exports: readonly AtlasExportEntry[];
  patterns: readonly string[];
  tags: readonly string[];
  dependencies: AtlasJsonObject;
  dataFlows: readonly string[];
  keyTypes: readonly AtlasKeyTypeEntry[];
  hazards: readonly string[];
  rangedHazards: readonly AtlasHazardWithRange[];
  conventions: readonly string[];
  crossReferences: AtlasCrossReferences | null;
  sourceHighlights: readonly AtlasSourceHighlight[];
  language: string;
  extractionProvider: string | null;
  extractedAt: string | null;
}

export type AtlasSymbolKind =
  | 'function'
  | 'class'
  | 'type'
  | 'interface'
  | 'const'
  | 'enum'
  | 'namespace'
  | 're-export'
  | 'value'
  | 'default'
  | 'unknown';

export interface AtlasSymbol {
  id: number;
  workspace: string;
  filePath: string;
  name: string;
  kind: AtlasSymbolKind;
  exported: boolean;
  range: AtlasLineRange | null;
  signatureHash: string | null;
}

export interface AtlasSymbolIdentity {
  id: number;
  workspace: string;
  filePath: string;
  symbol: string;
  purpose: string;
  hazards: readonly string[];
  attribution?: AtlasAttribution;
  createdAt: string;
  updatedAt: string;
}

export type AtlasGraphEdgeType =
  | 'import'
  | 'imported_by'
  | 'CALLS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'HAS_METHOD'
  | 'CONSUMES'
  | 'PRODUCES'
  | 'DATA_FLOWS_TO'
  | 'TRIGGERS';

export interface AtlasGraphEdge {
  id: number | null;
  workspace: string;
  sourceFile: string;
  targetFile: string;
  sourceSymbolId: number | null;
  targetSymbolId: number | null;
  edgeType: AtlasGraphEdgeType;
  usageCount: number;
  confidence: number;
  provenance: string;
  lastVerifiedAt: string | null;
}

export interface AtlasGraphSlice {
  nodes: readonly AtlasFile[];
  symbols: readonly AtlasSymbol[];
  edges: readonly AtlasGraphEdge[];
  truncated: boolean;
}

export interface AtlasChangelogEntry {
  id: number;
  workspace: string;
  filePath: string;
  summary: string;
  patternsAdded: readonly string[];
  patternsRemoved: readonly string[];
  hazardsAdded: readonly string[];
  hazardsRemoved: readonly string[];
  cluster: string | null;
  breakingChanges: boolean;
  repositoryRevision: string | null;
  attribution?: AtlasAttribution;
  evidence: readonly AtlasProvenanceEvidence[];
  source: string;
  verificationStatus: AtlasVerificationStatus;
  verificationNotes: string | null;
  createdAt: string;
}

/** Exact snake_case file shape used by MCP, CLI JSON, workers, and fixtures. */
export interface AtlasFileWire {
  id: number;
  workspace: string;
  file_path: string;
  file_hash: string | null;
  cluster: string | null;
  line_count: number;
  blurb: string;
  purpose: string;
  public_api: readonly AtlasPublicApiEntry[];
  exports: readonly AtlasExportEntry[];
  patterns: readonly string[];
  tags: readonly string[];
  dependencies: AtlasJsonObject;
  data_flows: readonly string[];
  key_types: readonly AtlasKeyTypeEntry[];
  hazards: readonly string[];
  ranged_hazards: readonly {
    text: string;
    start_line?: number | null;
    end_line?: number | null;
  }[];
  conventions: readonly string[];
  cross_references: AtlasCrossRefs | null;
  source_highlights: readonly {
    id: number;
    label?: string;
    start_line: number;
    end_line: number;
    content: string;
  }[];
  language: string;
  extraction_provider: string | null;
  extracted_at: string | null;
}

export interface AtlasSymbolWire {
  id: number;
  workspace: string;
  file_path: string;
  name: string;
  kind: AtlasSymbolKind;
  exported: boolean;
  range: { start_line: number; end_line: number } | null;
  signature_hash: string | null;
}

export interface AtlasSymbolIdentityWire {
  id: number;
  workspace: string;
  file_path: string;
  symbol: string;
  purpose: string;
  hazards: readonly string[];
  attribution?: AtlasAttributionWire;
  created_at: string;
  updated_at: string;
}

export interface AtlasGraphEdgeWire {
  id: number | null;
  workspace: string;
  source_file: string;
  target_file: string;
  source_symbol_id: number | null;
  target_symbol_id: number | null;
  edge_type: AtlasGraphEdgeType;
  usage_count: number;
  confidence: number;
  provenance: string;
  last_verified_at: string | null;
}

export interface AtlasChangelogEntryWire {
  id: number;
  workspace: string;
  file_path: string;
  summary: string;
  patterns_added: readonly string[];
  patterns_removed: readonly string[];
  hazards_added: readonly string[];
  hazards_removed: readonly string[];
  cluster: string | null;
  breaking_changes: boolean;
  repository_revision: string | null;
  attribution?: AtlasAttributionWire;
  evidence: readonly AtlasProvenanceEvidenceWire[];
  source: string;
  verification_status: AtlasVerificationStatus;
  verification_notes: string | null;
  created_at: string;
}

export type AtlasQueryAction =
  | 'search'
  | 'lookup'
  | 'brief'
  | 'snippet'
  | 'similar'
  | 'plan_context'
  | 'cluster'
  | 'patterns'
  | 'history'
  | 'catalog'
  | 'ask';

export type AtlasHistoryMode = 'entries' | 'count' | 'timeline' | 'group';
export type AtlasHistoryOrder = 'asc' | 'desc';
export type AtlasHistoryBucket = 'day' | 'week' | 'month';
export type AtlasHistoryGroupBy =
  | 'file_path'
  | 'cluster'
  | 'principal_id'
  | 'runtime_name'
  | 'verification_status';
export type AtlasCatalogField = 'blurb' | 'purpose';

export interface AtlasQueryBaseRequest {
  action: AtlasQueryAction;
  workspace?: string;
  format?: AtlasOutputFormat;
  limit?: number;
  cursor?: string;
}

export interface AtlasSearchRequest extends AtlasQueryBaseRequest {
  action: 'search';
  query: string;
  workspaces?: readonly string[];
  pathPrefix?: string;
  cluster?: string;
  includeTestFiles?: boolean;
}

export interface AtlasLookupRequest extends AtlasQueryBaseRequest {
  action: 'lookup';
  filePath: string;
  includeSource?: boolean;
  includeNeighbors?: boolean;
  includeCrossRefs?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface AtlasBriefRequest extends AtlasQueryBaseRequest {
  action: 'brief';
  filePath: string;
}

export type AtlasSnippetRequest = AtlasQueryBaseRequest & {
  action: 'snippet';
  filePath: string;
} & (
  | { symbol: string; startLine?: never; endLine?: never }
  | { symbol?: never; startLine: number; endLine: number }
);

export interface AtlasSimilarRequest extends AtlasQueryBaseRequest {
  action: 'similar';
  filePath: string;
  minScore?: number;
  includeTestFiles?: boolean;
}

export interface AtlasPlanContextRequest extends AtlasQueryBaseRequest {
  action: 'plan_context';
  query: string;
  includeNeighbors?: boolean;
  neighborDepth?: number;
  characterBudget?: number;
  includeTestFiles?: boolean;
}

export interface AtlasClusterRequest extends AtlasQueryBaseRequest {
  action: 'cluster';
  cluster?: string;
  pathPrefix?: string;
  includeTestFiles?: boolean;
}

export interface AtlasPatternsRequest extends AtlasQueryBaseRequest {
  action: 'patterns';
  pattern?: string;
  filePath?: string;
  includeTestFiles?: boolean;
}

export interface AtlasHistoryRequest extends AtlasQueryBaseRequest {
  action: 'history';
  mode?: AtlasHistoryMode;
  filePath?: string;
  cluster?: string;
  query?: string;
  since?: string;
  until?: string;
  order?: AtlasHistoryOrder;
  bucket?: AtlasHistoryBucket;
  groupBy?: AtlasHistoryGroupBy;
  breakingChanges?: boolean;
  principalId?: string;
  runtimeName?: string;
  verificationStatus?: AtlasVerificationStatus;
}

export interface AtlasCatalogRequest extends AtlasQueryBaseRequest {
  action: 'catalog';
  query?: string;
  pathPrefix?: string;
  cluster?: string;
  field?: AtlasCatalogField;
  includeTestFiles?: boolean;
}

export interface AtlasAskRequest extends AtlasQueryBaseRequest {
  action: 'ask';
  query: string;
  workspaces?: readonly string[];
  pathPrefix?: string;
  includeTestFiles?: boolean;
  characterBudget?: number;
}

export type AtlasQueryRequest =
  | AtlasSearchRequest
  | AtlasLookupRequest
  | AtlasBriefRequest
  | AtlasSnippetRequest
  | AtlasSimilarRequest
  | AtlasPlanContextRequest
  | AtlasClusterRequest
  | AtlasPatternsRequest
  | AtlasHistoryRequest
  | AtlasCatalogRequest
  | AtlasAskRequest;

interface AtlasQueryWireBase {
  action: AtlasQueryAction;
  workspace?: string;
  format?: AtlasOutputFormat;
  limit?: number;
  cursor?: string;
}

export type AtlasQueryWireRequest =
  | (AtlasQueryWireBase & {
      action: 'search';
      query: string;
      workspaces?: readonly string[];
      path_prefix?: string;
      cluster?: string;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'lookup';
      file_path: string;
      include_source?: boolean;
      include_neighbors?: boolean;
      include_cross_refs?: boolean;
      source_start?: number;
      source_end?: number;
    })
  | (AtlasQueryWireBase & { action: 'brief'; file_path: string })
  | (AtlasQueryWireBase & { action: 'snippet'; file_path: string } & (
      | { symbol: string; start_line?: never; end_line?: never }
      | { symbol?: never; start_line: number; end_line: number }
    ))
  | (AtlasQueryWireBase & {
      action: 'similar';
      file_path: string;
      min_score?: number;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'plan_context';
      query: string;
      include_neighbors?: boolean;
      neighbor_depth?: number;
      character_budget?: number;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'cluster';
      cluster?: string;
      path_prefix?: string;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'patterns';
      pattern?: string;
      file_path?: string;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'history';
      mode?: AtlasHistoryMode;
      file_path?: string;
      cluster?: string;
      query?: string;
      since?: string;
      until?: string;
      order?: AtlasHistoryOrder;
      bucket?: AtlasHistoryBucket;
      group_by?: AtlasHistoryGroupBy;
      breaking_changes?: boolean;
      principal_id?: string;
      runtime_name?: string;
      verification_status?: AtlasVerificationStatus;
    })
  | (AtlasQueryWireBase & {
      action: 'catalog';
      query?: string;
      path_prefix?: string;
      cluster?: string;
      field?: AtlasCatalogField;
      include_test_files?: boolean;
    })
  | (AtlasQueryWireBase & {
      action: 'ask';
      query: string;
      workspaces?: readonly string[];
      path_prefix?: string;
      include_test_files?: boolean;
      character_budget?: number;
    });

export type AtlasGraphAction =
  | 'impact'
  | 'neighbors'
  | 'trace'
  | 'cycles'
  | 'reachability'
  | 'graph'
  | 'cluster';
export type AtlasGraphDirection = 'imports' | 'importers' | 'both';
export type AtlasReachabilityMode = 'dead_exports' | 'dead_files' | 'path_query' | 'entrypoints';

interface AtlasGraphBaseRequest {
  action: AtlasGraphAction;
  workspace?: string;
  format?: AtlasOutputFormat;
  includeTestFiles?: boolean;
  limit?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export type AtlasGraphRequest =
  | (AtlasGraphBaseRequest & {
      action: 'impact';
      filePath: string;
      symbol?: string;
      depth?: number;
      edgeTypes?: readonly AtlasGraphEdgeType[];
      includeReferences?: boolean;
      includeSymbols?: boolean;
    })
  | (AtlasGraphBaseRequest & {
      action: 'neighbors';
      filePath: string;
      depth?: number;
      direction?: AtlasGraphDirection;
      edgeTypes?: readonly AtlasGraphEdgeType[];
      includeReferences?: boolean;
      includeSymbols?: boolean;
    })
  | (AtlasGraphBaseRequest & {
      action: 'trace';
      maxHops?: number;
      weighted?: boolean;
      edgeTypes?: readonly AtlasGraphEdgeType[];
    } & (
      | { from: string; to: string; fromSymbol?: never; toSymbol?: never }
      | { from?: never; to?: never; fromSymbol: string; toSymbol: string }
    ))
  | (AtlasGraphBaseRequest & {
      action: 'cycles';
      filePath?: string;
      minSize?: number;
      edgeTypes?: readonly AtlasGraphEdgeType[];
    })
  | (AtlasGraphBaseRequest & {
      action: 'reachability';
      mode: AtlasReachabilityMode;
      filePath?: string;
      from?: string;
      to?: string;
      symbol?: string;
      direction?: AtlasGraphDirection;
      includeSymbols?: boolean;
    })
  | (AtlasGraphBaseRequest & {
      action: 'graph';
      filePath?: string;
      depth?: number;
      direction?: AtlasGraphDirection;
      edgeTypes?: readonly AtlasGraphEdgeType[];
      includeSymbols?: boolean;
    })
  | (AtlasGraphBaseRequest & { action: 'cluster'; cluster: string });

interface AtlasGraphWireBase {
  action: AtlasGraphAction;
  workspace?: string;
  format?: AtlasOutputFormat;
  include_test_files?: boolean;
  limit?: number;
  max_nodes?: number;
  max_edges?: number;
}

export type AtlasGraphWireRequest =
  | (AtlasGraphWireBase & {
      action: 'impact';
      file_path: string;
      symbol?: string;
      depth?: number;
      edge_types?: readonly AtlasGraphEdgeType[];
      include_references?: boolean;
      include_symbols?: boolean;
    })
  | (AtlasGraphWireBase & {
      action: 'neighbors';
      file_path: string;
      depth?: number;
      direction?: AtlasGraphDirection;
      edge_types?: readonly AtlasGraphEdgeType[];
      include_references?: boolean;
      include_symbols?: boolean;
    })
  | (AtlasGraphWireBase & {
      action: 'trace';
      max_hops?: number;
      weighted?: boolean;
      edge_types?: readonly AtlasGraphEdgeType[];
    } & (
      | { from: string; to: string; from_symbol?: never; to_symbol?: never }
      | { from?: never; to?: never; from_symbol: string; to_symbol: string }
    ))
  | (AtlasGraphWireBase & {
      action: 'cycles';
      file_path?: string;
      min_size?: number;
      edge_types?: readonly AtlasGraphEdgeType[];
    })
  | (AtlasGraphWireBase & {
      action: 'reachability';
      mode: AtlasReachabilityMode;
      file_path?: string;
      from?: string;
      to?: string;
      symbol?: string;
      direction?: AtlasGraphDirection;
      include_symbols?: boolean;
    })
  | (AtlasGraphWireBase & {
      action: 'graph';
      file_path?: string;
      depth?: number;
      direction?: AtlasGraphDirection;
      edge_types?: readonly AtlasGraphEdgeType[];
      include_symbols?: boolean;
    })
  | (AtlasGraphWireBase & { action: 'cluster'; cluster: string });

export type AtlasErrorCode =
  | 'ATLAS_INVALID_REQUEST'
  | 'ATLAS_UNSUPPORTED_ACTION'
  | 'ATLAS_NOT_FOUND'
  | 'ATLAS_WORKSPACE_NOT_FOUND'
  | 'ATLAS_PATH_OUTSIDE_REPOSITORY'
  | 'ATLAS_PERMISSION_DENIED'
  | 'ATLAS_CAPABILITY_UNAVAILABLE'
  | 'ATLAS_BUSY'
  | 'ATLAS_DEADLINE_EXCEEDED'
  | 'ATLAS_CANCELLED'
  | 'ATLAS_STORE_LOCKED'
  | 'ATLAS_WRITE_CONFLICT'
  | 'ATLAS_INDETERMINATE_WRITE'
  | 'ATLAS_SCHEMA_NEWER'
  | 'ATLAS_SCHEMA_HISTORY_DIVERGED'
  | 'ATLAS_SCHEMA_CHECKSUM_MISMATCH'
  | 'ATLAS_SCHEMA_WRONG_DOMAIN'
  | 'ATLAS_STORE_IDENTITY_MISMATCH'
  | 'ATLAS_STORE_CORRUPT'
  | 'ATLAS_IO_ERROR'
  | 'ATLAS_INTERNAL';

export interface AtlasErrorAction {
  label: string;
  command?: string;
  documentation?: string;
}

export interface AtlasError {
  code: AtlasErrorCode;
  message: string;
  retryable: boolean;
  details?: AtlasJsonObject;
  actions?: readonly AtlasErrorAction[];
  cause_code?: string;
}

export interface AtlasWarning {
  code: string;
  message: string;
  details?: AtlasJsonObject;
}

export interface AtlasPageMeta {
  next_cursor: string | null;
  returned: number;
  total?: number;
  truncated: boolean;
}

export interface AtlasResultEvidenceMeta {
  authority: AtlasEvidenceAuthority;
  freshness: AtlasEvidenceFreshness;
  confidence: AtlasEvidenceConfidence;
  completeness: AtlasEvidenceCompleteness;
}

export interface AtlasResultMeta {
  workspace?: string;
  repository_id?: string;
  capabilities: Readonly<Record<string, AtlasCapabilityStatus>>;
  warnings: readonly AtlasWarning[];
  page?: AtlasPageMeta;
  evidence?: AtlasResultEvidenceMeta;
  extensions: readonly AtlasProvenanceEvidenceWire[];
}

export interface AtlasSuccess<T> {
  protocol_version: '1';
  ok: true;
  request_id: string;
  data: T;
  meta: AtlasResultMeta;
}

export interface AtlasFailure {
  protocol_version: '1';
  ok: false;
  request_id: string;
  error: AtlasError;
  meta: AtlasResultMeta;
}

export type AtlasResult<T> = AtlasSuccess<T> | AtlasFailure;

export interface AtlasListData<T> {
  items: readonly T[];
}
