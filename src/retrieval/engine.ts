import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  getAtlasFile,
  countAtlasChangelog,
  countAtlasChangelogGroups,
  groupAtlasChangelog,
  listAtlasFiles,
  listImportEdges,
  listReferences,
  listSymbols,
  queryAtlasChangelog,
  searchFts,
  timelineAtlasChangelog,
  type AtlasChangelogQuery,
  type AtlasChangelogRecord,
  type AtlasDatabase,
  type AtlasImportEdgeRecord,
  type AtlasReferenceRecord,
  type AtlasSymbolRecord,
} from '../db.js';
import { createAtlasCursor, measureTextCharacters, paginateAtlasItems, parseAtlasCursor } from '../core/queryControl.js';
import type {
  AtlasAuditData,
  AtlasAuditRequest,
  AtlasError,
  AtlasGraphData,
  AtlasGraphRequest,
  AtlasJsonObject,
  AtlasJsonValue,
  AtlasPageMeta,
  AtlasQueryData,
  AtlasQueryRequest,
  AtlasResultMeta,
} from '../core/types.js';
import { computeChangelogDiff, computeDiff, computeSnapshot } from '../tools/diff.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasReadOutcome, AtlasReadRequest } from './types.js';

const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 8_192;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_RESULT_ITEMS = 500;
const MAX_GRAPH_NODES = 2_000;
const MAX_GRAPH_EDGES = 10_000;
const MAX_SCAN_RECORDS = 100_000;
const MAX_SOURCE_LINES = 5_000;
const MAX_TEXT_CHARACTERS = 200_000;

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  usageCount: number;
  confidence: number;
  provenance: string;
  sourceSymbolId: number | null;
  targetSymbolId: number | null;
}

interface SourceRead {
  content: string;
  hash: string;
}

function jsonValue(value: unknown): AtlasJsonValue {
  return JSON.parse(JSON.stringify(value)) as AtlasJsonValue;
}

function jsonObject(value: object): AtlasJsonObject {
  return jsonValue(value) as AtlasJsonObject;
}

function capabilities(): Readonly<Record<string, 'available' | 'degraded' | 'unavailable' | 'disabled'>> {
  return {
    lexical_search: 'available',
    vector_search: 'unavailable',
    source_authority: 'available',
    graph: 'available',
    history: 'available',
  };
}

function resultMeta(
  workspace: string,
  options: {
    page?: AtlasPageMeta;
    freshness?: 'current' | 'stale' | 'historical' | 'unknown';
    authority?: 'workspace_disk' | 'atlas_store' | 'repository' | 'provider' | 'mixed' | 'unknown';
    completeness?: 'complete' | 'partial' | 'not_applicable' | 'unknown';
    warnings?: AtlasResultMeta['warnings'];
  } = {},
): AtlasResultMeta {
  return {
    workspace,
    capabilities: capabilities(),
    warnings: options.warnings ?? [],
    ...(options.page ? { page: options.page } : {}),
    evidence: {
      authority: options.authority ?? 'atlas_store',
      freshness: options.freshness ?? 'unknown',
      confidence: 'high',
      completeness: options.completeness ?? 'complete',
    },
    extensions: [],
  };
}

function errorOutcome(
  workspace: string,
  code: AtlasError['code'],
  message: string,
  details?: AtlasJsonObject,
): AtlasReadOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      ...(details ? { details } : {}),
    },
    meta: resultMeta(workspace, { freshness: 'unknown', authority: 'unknown' }),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return null;
  }
  return value;
}

function validateCommon(request: { workspace?: string; limit?: number; cursor?: string }): AtlasError | null {
  if (typeof request.workspace !== 'string' || request.workspace.trim().length === 0) {
    return { code: 'ATLAS_INVALID_REQUEST', message: 'workspace is required.', retryable: false };
  }
  if (request.workspace.length > 256) {
    return { code: 'ATLAS_INVALID_REQUEST', message: 'workspace exceeds 256 characters.', retryable: false };
  }
  if (boundedInteger(request.limit, 50, 1, MAX_RESULT_ITEMS) == null) {
    return { code: 'ATLAS_INVALID_REQUEST', message: `limit must be an integer from 1 to ${MAX_RESULT_ITEMS}.`, retryable: false };
  }
  if (request.cursor != null && (typeof request.cursor !== 'string' || request.cursor.length > MAX_CURSOR_LENGTH)) {
    return { code: 'ATLAS_INVALID_REQUEST', message: `cursor must not exceed ${MAX_CURSOR_LENGTH} characters.`, retryable: false };
  }
  return null;
}

function invalidField(message: string): AtlasError {
  return { code: 'ATLAS_INVALID_REQUEST', message, retryable: false };
}

function validOptionalString(value: unknown, maximum = MAX_QUERY_LENGTH): boolean {
  return value == null || (typeof value === 'string' && value.length <= maximum);
}

function validOptionalBoolean(value: unknown): boolean {
  return value == null || typeof value === 'boolean';
}

function validOptionalInteger(value: unknown, minimum: number, maximum: number): boolean {
  return value == null || boundedInteger(value, minimum, minimum, maximum) != null;
}

function validStringArray(value: unknown, maximumItems = 200): boolean {
  return value == null || (Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_QUERY_LENGTH));
}

const QUERY_BASE_FIELDS = ['action', 'workspace', 'format', 'limit', 'cursor'] as const;
const QUERY_ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  search: ['query', 'workspaces', 'pathPrefix', 'cluster', 'includeTestFiles'],
  lookup: ['filePath', 'includeSource', 'includeNeighbors', 'includeCrossRefs', 'sourceStart', 'sourceEnd'],
  brief: ['filePath'],
  snippet: ['filePath', 'symbol', 'startLine', 'endLine'],
  similar: ['filePath', 'minScore', 'includeTestFiles'],
  plan_context: ['query', 'includeNeighbors', 'neighborDepth', 'characterBudget', 'includeTestFiles'],
  cluster: ['cluster', 'pathPrefix', 'includeTestFiles'],
  patterns: ['pattern', 'filePath', 'includeTestFiles'],
  history: ['mode', 'filePath', 'cluster', 'query', 'since', 'until', 'order', 'bucket', 'groupBy', 'breakingChanges', 'principalId', 'runtimeName', 'verificationStatus'],
  catalog: ['query', 'pathPrefix', 'cluster', 'field', 'includeTestFiles'],
  ask: ['query', 'workspaces', 'pathPrefix', 'includeTestFiles', 'characterBudget'],
  snapshot: ['filePath', 'changelogId', 'at', 'maxLines'],
  diff: ['filePath', 'changelogId', 'from', 'to', 'contextLines'],
};

const GRAPH_BASE_FIELDS = ['action', 'workspace', 'format', 'includeTestFiles', 'limit', 'maxNodes', 'maxEdges'] as const;
const GRAPH_ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  impact: ['filePath', 'symbol', 'depth', 'edgeTypes', 'includeReferences', 'includeSymbols'],
  neighbors: ['filePath', 'depth', 'direction', 'edgeTypes', 'includeReferences', 'includeSymbols'],
  trace: ['from', 'to', 'fromSymbol', 'toSymbol', 'maxHops', 'weighted', 'edgeTypes'],
  cycles: ['filePath', 'minSize', 'edgeTypes'],
  reachability: ['mode', 'filePath', 'from', 'to', 'symbol', 'direction', 'includeSymbols'],
  graph: ['filePath', 'depth', 'direction', 'edgeTypes', 'includeSymbols'],
  cluster: ['cluster'],
};

const AUDIT_FIELDS = [
  'action', 'workspace', 'format', 'cluster', 'filePath', 'limit', 'cursor',
  'includeTestFiles', 'gapTypes', 'minSeverity', 'since', 'topN', 'weights',
] as const;

function unknownField(value: Record<string, unknown>, allowed: readonly string[]): AtlasError | null {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !accepted.has(field)).sort()[0];
  return unknown ? invalidField(`Unknown request field: ${unknown}.`) : null;
}

function validateQueryRequest(request: AtlasQueryRequest): AtlasError | null {
  const value = request as unknown as Record<string, unknown>;
  if (!validOptionalString(value.format, 4) || (value.format != null && !['json', 'text'].includes(String(value.format)))) {
    return invalidField('format must be "json" or "text".');
  }
  for (const field of ['includeSource', 'includeNeighbors', 'includeCrossRefs', 'includeTestFiles', 'breakingChanges']) {
    if (!validOptionalBoolean(value[field])) return invalidField(`${field} must be a boolean.`);
  }
  for (const field of ['query', 'pathPrefix', 'cluster', 'pattern', 'symbol', 'filePath', 'principalId', 'runtimeName', 'since', 'until']) {
    if (!validOptionalString(value[field], field === 'filePath' || field === 'pathPrefix' ? MAX_PATH_LENGTH : MAX_QUERY_LENGTH)) {
      return invalidField(`${field} exceeds its public string bound.`);
    }
  }
  if (value.filePath != null && canonicalFilePath(value.filePath) == null) {
    return invalidField('filePath must be a canonical workspace-relative path.');
  }
  if (!validStringArray(value.workspaces) || !validStringArray(value.gapTypes) || !validStringArray(value.edgeTypes)) {
    return invalidField('Request arrays must contain at most 200 bounded strings.');
  }
  if (value.field != null && !['blurb', 'purpose'].includes(String(value.field))) {
    return invalidField('field must be "blurb" or "purpose".');
  }
  for (const field of ['startLine', 'endLine', 'sourceStart', 'sourceEnd']) {
    if (!validOptionalInteger(value[field], 1, 10_000_000)) return invalidField(`${field} must be a bounded positive integer.`);
  }
  if (!validOptionalInteger(value.neighborDepth, 0, 5)) return invalidField('neighborDepth must be an integer from 0 to 5.');
  if (!validOptionalInteger(value.characterBudget, 1, MAX_TEXT_CHARACTERS)) {
    return invalidField(`characterBudget must be an integer from 1 to ${MAX_TEXT_CHARACTERS}.`);
  }
  if (!validOptionalInteger(value.maxLines, 1, MAX_SOURCE_LINES)) return invalidField(`maxLines must be an integer from 1 to ${MAX_SOURCE_LINES}.`);
  if (!validOptionalInteger(value.contextLines, 0, 20)) return invalidField('contextLines must be an integer from 0 to 20.');
  if (value.minScore != null && (typeof value.minScore !== 'number' || !Number.isFinite(value.minScore) || value.minScore < 0 || value.minScore > 1)) {
    return invalidField('minScore must be between 0 and 1.');
  }
  for (const field of ['at', 'from', 'to']) {
    const candidate = value[field];
    if (candidate != null && !validOptionalString(candidate) && !(typeof candidate === 'number' && Number.isSafeInteger(candidate))) {
      return invalidField(`${field} must be a bounded string or safe integer.`);
    }
  }
  if (value.changelogId != null && (!Number.isSafeInteger(value.changelogId) || Number(value.changelogId) <= 0)) {
    return invalidField('changelogId must be a positive safe integer.');
  }
  const knownActions = new Set([
    'search', 'lookup', 'brief', 'snippet', 'similar', 'plan_context', 'cluster',
    'patterns', 'history', 'catalog', 'ask', 'snapshot', 'diff',
  ]);
  if (typeof value.action !== 'string' || !knownActions.has(value.action)) {
    return { code: 'ATLAS_UNSUPPORTED_ACTION', message: `Unsupported query action: ${String(value.action)}.`, retryable: false };
  }
  const unknown = unknownField(value, [...QUERY_BASE_FIELDS, ...QUERY_ACTION_FIELDS[value.action]!]);
  if (unknown) return unknown;
  if (value.action === 'search' || value.action === 'ask' || value.action === 'plan_context') {
    if (typeof value.query !== 'string' || value.query.length === 0) return invalidField(`${value.action} requires query.`);
  }
  if (value.action === 'lookup' || value.action === 'brief' || value.action === 'snippet'
    || value.action === 'similar') {
    if (canonicalFilePath(value.filePath) == null) return invalidField('filePath must be a canonical workspace-relative path.');
  }
  if ((value.action === 'snapshot' || value.action === 'diff')
    && canonicalFilePath(value.filePath) == null
    && value.changelogId == null) {
    return invalidField(`${value.action} requires filePath or changelogId.`);
  }
  if (value.action === 'snippet') {
    const hasSymbol = typeof value.symbol === 'string' && value.symbol.length > 0;
    const hasRange = value.startLine != null || value.endLine != null;
    if (hasSymbol === hasRange) return invalidField('snippet requires exactly one of symbol or startLine/endLine.');
  }
  if (value.action === 'history') {
    if (value.mode != null && !['entries', 'count', 'timeline', 'group'].includes(String(value.mode))) return invalidField('Unsupported history mode.');
    if (value.order != null && !['asc', 'desc'].includes(String(value.order))) return invalidField('Unsupported history order.');
    if (value.bucket != null && !['day', 'week', 'month'].includes(String(value.bucket))) return invalidField('Unsupported history bucket.');
    if (value.groupBy != null && !['file_path', 'cluster', 'principal_id', 'runtime_name', 'verification_status'].includes(String(value.groupBy))) {
      return invalidField('Unsupported history grouping.');
    }
  }
  return null;
}

function validateGraphRequest(request: AtlasGraphRequest): AtlasError | null {
  const value = request as unknown as Record<string, unknown>;
  if (!validOptionalString(value.format, 4) || (value.format != null && !['json', 'text'].includes(String(value.format)))) {
    return invalidField('format must be "json" or "text".');
  }
  for (const field of ['includeTestFiles', 'includeReferences', 'includeSymbols', 'weighted']) {
    if (!validOptionalBoolean(value[field])) return invalidField(`${field} must be a boolean.`);
  }
  for (const field of ['filePath', 'from', 'to', 'fromSymbol', 'toSymbol', 'symbol', 'cluster']) {
    if (!validOptionalString(value[field], field.includes('Symbol') || field === 'symbol' || field === 'cluster' ? MAX_QUERY_LENGTH : MAX_PATH_LENGTH)) {
      return invalidField(`${field} exceeds its public string bound.`);
    }
  }
  if (!validStringArray(value.edgeTypes)) return invalidField('edgeTypes must contain at most 200 bounded strings.');
  if (value.filePath != null && canonicalFilePath(value.filePath) == null) return invalidField('filePath must be a canonical workspace-relative path.');
  if (!validOptionalInteger(value.maxNodes, 1, MAX_GRAPH_NODES)) return invalidField(`maxNodes must be an integer from 1 to ${MAX_GRAPH_NODES}.`);
  if (!validOptionalInteger(value.maxEdges, 1, MAX_GRAPH_EDGES)) return invalidField(`maxEdges must be an integer from 1 to ${MAX_GRAPH_EDGES}.`);
  if (!validOptionalInteger(value.depth, 0, 20)) return invalidField('depth must be an integer from 0 to 20.');
  if (!validOptionalInteger(value.maxHops, 1, 50)) return invalidField('maxHops must be an integer from 1 to 50.');
  if (!validOptionalInteger(value.minSize, 1, MAX_GRAPH_NODES)) return invalidField('minSize must be a bounded positive integer.');
  const knownActions = new Set(['impact', 'neighbors', 'trace', 'cycles', 'reachability', 'graph', 'cluster']);
  if (typeof value.action !== 'string' || !knownActions.has(value.action)) {
    return { code: 'ATLAS_UNSUPPORTED_ACTION', message: `Unsupported graph action: ${String(value.action)}.`, retryable: false };
  }
  const unknown = unknownField(value, [...GRAPH_BASE_FIELDS, ...GRAPH_ACTION_FIELDS[value.action]!]);
  if (unknown) return unknown;
  if (value.direction != null && !['imports', 'importers', 'both'].includes(String(value.direction))) return invalidField('Unsupported graph direction.');
  if (value.action === 'trace') {
    const hasFiles = value.from != null || value.to != null;
    const hasSymbols = value.fromSymbol != null || value.toSymbol != null;
    if (hasFiles === hasSymbols) return invalidField('trace requires exactly one file or symbol endpoint pair.');
    if (hasFiles && (canonicalFilePath(value.from) == null || canonicalFilePath(value.to) == null)) return invalidField('Trace paths must be canonical.');
    if (hasSymbols && (!(typeof value.fromSymbol === 'string' && value.fromSymbol) || !(typeof value.toSymbol === 'string' && value.toSymbol))) {
      return invalidField('Symbol trace requires fromSymbol and toSymbol.');
    }
  }
  if (value.action === 'impact' || value.action === 'neighbors') {
    if (canonicalFilePath(value.filePath) == null) return invalidField(`${value.action} requires canonical filePath.`);
  }
  if (value.action === 'cluster' && !(typeof value.cluster === 'string' && value.cluster.length > 0)) return invalidField('cluster requires a non-empty cluster.');
  if (value.action === 'reachability' && !['dead_exports', 'dead_files', 'path_query', 'entrypoints'].includes(String(value.mode))) {
    return invalidField('Unsupported reachability mode.');
  }
  return null;
}

function validateAuditRequest(request: AtlasAuditRequest): AtlasError | null {
  const value = request as unknown as Record<string, unknown>;
  if (!['gaps', 'smells', 'hotspots'].includes(String(value.action))) {
    return { code: 'ATLAS_UNSUPPORTED_ACTION', message: `Unsupported audit action: ${String(value.action)}.`, retryable: false };
  }
  const unknown = unknownField(value, AUDIT_FIELDS);
  if (unknown) return unknown;
  if (!validOptionalBoolean(value.includeTestFiles)) return invalidField('includeTestFiles must be a boolean.');
  if (!validOptionalString(value.format, 4) || (value.format != null && !['json', 'text'].includes(String(value.format)))) {
    return invalidField('format must be "json" or "text".');
  }
  if (!validOptionalString(value.filePath, MAX_PATH_LENGTH) || (value.filePath != null && canonicalFilePath(value.filePath) == null)) {
    return invalidField('filePath must be a canonical workspace-relative path.');
  }
  if (!validOptionalString(value.cluster) || !validOptionalString(value.since)) return invalidField('Audit string input exceeds its public bound.');
  if (!validStringArray(value.gapTypes)) return invalidField('gapTypes must contain at most 200 bounded strings.');
  if (!validOptionalInteger(value.topN, 1, MAX_RESULT_ITEMS)) return invalidField(`topN must be an integer from 1 to ${MAX_RESULT_ITEMS}.`);
  if (value.minSeverity != null && !['low', 'medium', 'high'].includes(String(value.minSeverity))) return invalidField('Unsupported minimum severity.');
  if (value.weights != null && (typeof value.weights !== 'object' || Array.isArray(value.weights))) return invalidField('weights must be an object.');
  return null;
}

function canonicalFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return null;
  return path.posix.normalize(normalized);
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|test|tests|fixtures)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function sourceRootFor(db: AtlasDatabase, workspace: string): string | null {
  const row = db.prepare(
    'SELECT source_root FROM atlas_meta WHERE workspace = ? LIMIT 1',
  ).get(workspace) as { source_root?: unknown } | undefined;
  return typeof row?.source_root === 'string' && row.source_root.length > 0 ? row.source_root : null;
}

async function readWorkspaceSource(sourceRoot: string | null, filePath: string): Promise<SourceRead | null> {
  if (!sourceRoot) return null;
  const root = await realpath(sourceRoot).catch(() => null);
  if (!root) return null;
  const candidate = path.resolve(root, ...filePath.split('/'));
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) return null;
  const content = await readFile(resolved, 'utf8').catch(() => null);
  if (content == null) return null;
  return {
    content,
    hash: createHash('sha1').update(content).digest('hex'),
  };
}

function trimString(value: string, maximum = 20_000): string {
  return Array.from(value).slice(0, maximum).join('');
}

function trimArray<T>(values: readonly T[], maximum = 50): readonly T[] {
  return values.slice(0, maximum);
}

function fileItem(file: AtlasFileRecord, extras: Record<string, unknown> = {}): AtlasJsonObject {
  return jsonObject({
    workspace: file.workspace,
    file_path: file.file_path,
    file_hash: file.file_hash,
    cluster: file.cluster,
    line_count: file.loc,
    blurb: trimString(file.blurb),
    purpose: trimString(file.purpose),
    exports: trimArray(file.exports),
    patterns: trimArray(file.patterns),
    tags: trimArray(file.tags),
    hazards: trimArray(file.hazards),
    conventions: trimArray(file.conventions),
    language: file.language,
    extraction_provider: file.extraction_model,
    extracted_at: file.last_extracted,
    ...extras,
  });
}

function fileRecordItem(file: AtlasFileRecord, extras: Record<string, unknown> = {}): AtlasJsonObject {
  return jsonObject({
    ...fileItem(file),
    public_api: trimArray(file.public_api),
    dependencies: file.dependencies,
    data_flows: trimArray(file.data_flows),
    key_types: trimArray(file.key_types),
    ranged_hazards: trimArray(file.hazards_with_ranges),
    cross_references: file.cross_refs,
    source_highlights: trimArray(file.source_highlights),
    ...extras,
  });
}

function changelogItem(entry: AtlasChangelogRecord): AtlasJsonObject {
  return jsonObject({
    id: entry.id,
    file_path: entry.file_path,
    summary: trimString(entry.summary),
    patterns_added: trimArray(entry.patterns_added),
    patterns_removed: trimArray(entry.patterns_removed),
    hazards_added: trimArray(entry.hazards_added),
    hazards_removed: trimArray(entry.hazards_removed),
    cluster: entry.cluster,
    breaking_changes: entry.breaking_changes,
    repository_revision: entry.commit_sha,
    principal_id: entry.author_instance_id,
    runtime_name: entry.author_engine,
    source: entry.source,
    verification_status: entry.verification_status,
    verification_notes: entry.verification_notes,
    created_at: entry.created_at,
  });
}

function cursorScope(family: string, request: object): AtlasJsonValue {
  const copy = { family, ...request } as Record<string, unknown>;
  delete copy.cursor;
  delete copy.format;
  return jsonValue(copy);
}

function paginate<T>(
  family: string,
  request: { limit?: number; cursor?: string },
  items: readonly T[],
): { items: readonly T[]; page: AtlasPageMeta } | AtlasError {
  const result = paginateAtlasItems(items, {
    scope: cursorScope(family, request),
    limit: request.limit,
    cursor: request.cursor,
  });
  if (!result.ok) {
    return {
      code: 'ATLAS_INVALID_REQUEST',
      message: `Invalid Atlas cursor (${result.code}).`,
      retryable: false,
      details: jsonObject({ cursor_error: result.code }),
    };
  }
  return result;
}

function queryText(request: AtlasQueryRequest): string | null {
  if ('query' in request && request.query != null) {
    if (typeof request.query !== 'string' || request.query.length === 0 || request.query.length > MAX_QUERY_LENGTH) {
      return null;
    }
    return request.query;
  }
  return '';
}

function filterFiles(
  files: readonly AtlasFileRecord[],
  request: { includeTestFiles?: boolean; pathPrefix?: string; cluster?: string },
): AtlasFileRecord[] {
  return files
    .filter((file) => request.includeTestFiles === true || !isTestFile(file.file_path))
    .filter((file) => !request.pathPrefix || file.file_path.startsWith(request.pathPrefix))
    .filter((file) => !request.cluster || file.cluster === request.cluster)
    .sort((a, b) => a.file_path.localeCompare(b.file_path));
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 1));
}

function similarity(left: AtlasFileRecord, right: AtlasFileRecord): number {
  const leftTokens = tokenize([
    left.file_path, left.blurb, left.purpose, ...left.tags, ...left.patterns, ...left.exports.map((item) => item.name),
  ].join(' '));
  const rightTokens = tokenize([
    right.file_path, right.blurb, right.purpose, ...right.tags, ...right.patterns, ...right.exports.map((item) => item.name),
  ].join(' '));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function historyFilters(
  workspace: string,
  request: Extract<AtlasQueryRequest, { action: 'history' }>,
): AtlasChangelogQuery {
  return {
    workspace,
    ...(request.filePath ? { file: canonicalFilePath(request.filePath)! } : {}),
    ...(request.cluster ? { cluster: request.cluster } : {}),
    ...(request.query ? { query: request.query } : {}),
    ...(request.since ? { since: request.since } : {}),
    ...(request.until ? { until: request.until } : {}),
    ...(request.breakingChanges == null ? {} : { breaking: request.breakingChanges }),
    ...(request.principalId ? { author_instance_id: request.principalId } : {}),
    ...(request.runtimeName ? { author_engine: request.runtimeName } : {}),
    ...(request.verificationStatus ? { verification_status: request.verificationStatus } : {}),
    order: request.query ? 'relevance' : request.order ?? 'desc',
  };
}

async function executeQuery(db: AtlasDatabase, request: AtlasQueryRequest): Promise<AtlasReadOutcome> {
  const commonError = validateCommon(request);
  const workspace = request.workspace ?? '';
  if (commonError) return { ok: false, error: commonError, meta: resultMeta(workspace) };
  const queryError = validateQueryRequest(request);
  if (queryError) return { ok: false, error: queryError, meta: resultMeta(workspace) };
  if (queryText(request) == null) {
    return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `query must contain 1 to ${MAX_QUERY_LENGTH} characters.`);
  }
  const sourceRoot = sourceRootFor(db, workspace);
  const fileFilters = {
    ...('includeTestFiles' in request ? { includeTestFiles: request.includeTestFiles } : {}),
    ...('pathPrefix' in request ? { pathPrefix: request.pathPrefix } : {}),
    ...('cluster' in request ? { cluster: request.cluster } : {}),
  };
  const allFiles = (): AtlasFileRecord[] => filterFiles(listAtlasFiles(db, workspace, MAX_SCAN_RECORDS), fileFilters);

  if (request.action === 'search' || request.action === 'ask' || request.action === 'plan_context') {
    const maximum = request.action === 'plan_context' ? 100 : MAX_RESULT_ITEMS;
    const searchWorkspaces = 'workspaces' in request && request.workspaces?.length
      ? [...new Set(request.workspaces)].sort()
      : [workspace];
    const rankedFiles = searchWorkspaces.flatMap((candidateWorkspace) =>
      searchFts(db, candidateWorkspace, request.query, maximum).map((hit) => ({ ...hit, candidateWorkspace })))
      .filter((hit) => request.includeTestFiles === true || !isTestFile(hit.file.file_path))
      .filter((hit) => !('pathPrefix' in request) || !request.pathPrefix || hit.file.file_path.startsWith(request.pathPrefix))
      .filter((hit) => request.action !== 'search' || !request.cluster || hit.file.cluster === request.cluster)
      .sort((a, b) => a.score - b.score
        || a.candidateWorkspace.localeCompare(b.candidateWorkspace)
        || a.file.file_path.localeCompare(b.file.file_path));
    const candidates = new Map<string, AtlasJsonObject>();
    for (const hit of rankedFiles) {
      candidates.set(`${hit.candidateWorkspace}\0${hit.file.file_path}`, fileItem(hit.file, {
        rank: hit.rank,
        score: hit.score,
        source: hit.source,
        selection_reason: 'lexical_match',
        selection_reasons: ['lexical_match'],
      }));
    }
    if (request.action === 'plan_context' && request.includeNeighbors !== false) {
      const depth = boundedInteger(request.neighborDepth, 1, 0, 5);
      if (depth == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'neighborDepth must be an integer from 0 to 5.');
      const fileByPath = new Map(listAtlasFiles(db, workspace, MAX_SCAN_RECORDS).map((file) => [file.file_path, file]));
      const planEdges = buildEdges(
        listImportEdges(db, workspace, MAX_SCAN_RECORDS),
        listReferences(db, workspace, undefined, MAX_SCAN_RECORDS),
      );
      const graph = adjacency(planEdges);
      const reverseGraph = adjacency(planEdges, true);
      for (const hit of rankedFiles.filter((item) => item.candidateWorkspace === workspace).slice(0, 20)) {
        const related = new Set([
          ...traverse(hit.file.file_path, graph, depth, maximum).nodes,
          ...traverse(hit.file.file_path, reverseGraph, depth, maximum).nodes,
        ]);
        for (const relatedPath of [...related].sort()) {
          const file = fileByPath.get(relatedPath);
          const key = `${workspace}\0${relatedPath}`;
          const existing = candidates.get(key);
          if (existing) {
            candidates.set(key, jsonObject({
              ...existing,
              selection_reasons: ['lexical_match', 'neighbor_expansion'],
            }));
          } else if (file && (request.includeTestFiles === true || !isTestFile(relatedPath))) {
            candidates.set(key, fileItem(file, {
              rank: candidates.size + 1,
              score: null,
              source: 'graph',
              selection_reason: 'neighbor_expansion',
              selection_reasons: ['neighbor_expansion'],
            }));
          }
        }
      }
    }
    const hits = [...candidates.values()].slice(0, maximum);
    const page = paginate(`query:${request.action}`, request, hits);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    const characterBudget = 'characterBudget' in request
      ? boundedInteger(request.characterBudget, 50_000, 1, MAX_TEXT_CHARACTERS)
      : 50_000;
    if (characterBudget == null) {
      return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `characterBudget must be an integer from 1 to ${MAX_TEXT_CHARACTERS}.`);
    }
    let returned = page.items;
    let usedCharacters = measureTextCharacters(JSON.stringify(returned));
    while (returned.length > 0 && usedCharacters > characterBudget) {
      returned = returned.slice(0, returned.length - 1);
      usedCharacters = measureTextCharacters(JSON.stringify(returned));
    }
    if (returned.length === 0 && page.items.length > 0) {
      return errorOutcome(
        workspace,
        'ATLAS_INVALID_REQUEST',
        'characterBudget is too small to encode one result item; increase the budget.',
      );
    }
    const scope = cursorScope(`query:${request.action}`, request);
    const startOffset = request.cursor ? parseAtlasCursor(request.cursor, scope) : { ok: true as const, offset: 0 };
    if (!startOffset.ok) {
      return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `Invalid Atlas cursor (${startOffset.code}).`);
    }
    const nextOffset = startOffset.offset + returned.length;
    const boundedPage: AtlasPageMeta = {
      next_cursor: nextOffset < hits.length ? createAtlasCursor(scope, nextOffset) : null,
      returned: returned.length,
      total: hits.length,
      truncated: nextOffset < hits.length,
    };
    return {
      ok: true,
      data: {
        action: request.action,
        items: returned,
        summary: jsonObject({
          matches: hits.length,
          returned: returned.length,
          lexical_fallback: true,
          character_budget: characterBudget,
          returned_characters: usedCharacters,
        }),
      },
      meta: resultMeta(workspace, { page: boundedPage }),
    };
  }

  if (request.action === 'catalog') {
    const needle = request.query?.toLowerCase();
    const files = allFiles()
      .filter((file) => !needle || `${file.file_path} ${file[request.field ?? 'blurb']}`.toLowerCase().includes(needle))
      .map((file) => fileItem(file));
    const page = paginate('query:catalog', request, files);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    return {
      ok: true,
      data: { action: 'catalog', items: page.items, summary: jsonObject({ files: files.length }) },
      meta: resultMeta(workspace, { page: page.page }),
    };
  }

  if (request.action === 'lookup' || request.action === 'brief' || request.action === 'snippet') {
    const filePath = canonicalFilePath(request.filePath);
    if (!filePath) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath must be a canonical workspace-relative path.');
    const file = getAtlasFile(db, workspace, filePath);
    if (!file) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No Atlas record exists for ${filePath}.`);
    const source = request.action === 'brief' ? null : await readWorkspaceSource(sourceRoot, filePath);
    const stale = source != null && file.file_hash != null && source.hash !== file.file_hash;
    let sourceData: AtlasJsonObject | undefined;
    if (request.action === 'snippet') {
      if (!source) return errorOutcome(workspace, 'ATLAS_CAPABILITY_UNAVAILABLE', `Current source is unavailable for ${filePath}.`);
      const lines = source.content.split('\n');
      let start: number;
      let end: number;
      if (typeof request.symbol === 'string' && request.symbol.length > 0) {
        const symbol = listSymbols(db, workspace, filePath, MAX_SCAN_RECORDS).find((item) => item.name === request.symbol);
        if (!symbol?.line_start || !symbol.line_end) {
          return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No ranged symbol named ${request.symbol} exists in ${filePath}.`);
        }
        start = symbol.line_start;
        end = symbol.line_end;
      } else if (typeof request.startLine === 'number' && typeof request.endLine === 'number') {
        start = request.startLine;
        end = request.endLine;
      } else {
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'Snippet requires either symbol or startLine/endLine.');
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_SOURCE_LINES) {
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `Snippet range must be ordered and contain at most ${MAX_SOURCE_LINES} lines.`);
      }
      sourceData = jsonObject({
        file_path: filePath,
        start_line: start,
        end_line: Math.min(end, lines.length),
        total_lines: lines.length,
        content: trimString(lines.slice(start - 1, end).join('\n'), MAX_TEXT_CHARACTERS),
        content_hash: source.hash,
      });
    } else if (request.action === 'lookup' && request.includeSource && source) {
      const lines = source.content.split('\n');
      const start = boundedInteger(request.sourceStart, 1, 1, Math.max(lines.length, 1));
      const end = boundedInteger(request.sourceEnd, Math.min(lines.length, MAX_SOURCE_LINES), 1, Math.max(lines.length, 1));
      if (start == null || end == null || end < start || end - start + 1 > MAX_SOURCE_LINES) {
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `Source range must be ordered and contain at most ${MAX_SOURCE_LINES} lines.`);
      }
      sourceData = jsonObject({
        file_path: filePath,
        start_line: start,
        end_line: end,
        total_lines: lines.length,
        content: trimString(lines.slice(start - 1, end).join('\n'), MAX_TEXT_CHARACTERS),
        content_hash: source.hash,
      });
    }
    const lookupExtras: Record<string, unknown> = {
      indexed_hash: file.file_hash,
      current_hash: source?.hash ?? null,
      stale,
    };
    if (request.action === 'lookup' && request.includeCrossRefs === false) {
      lookupExtras.cross_references = null;
    }
    if (request.action === 'lookup' && request.includeNeighbors) {
      const imports = listImportEdges(db, workspace, MAX_SCAN_RECORDS);
      lookupExtras.neighbors = [...new Set(imports.flatMap((edge) => {
        if (edge.source_file === filePath) return [edge.target_file];
        if (edge.target_file === filePath) return [edge.source_file];
        return [];
      }))].sort();
    }
    const data: AtlasQueryData = {
      action: request.action,
      items: [],
      record: fileRecordItem(file, lookupExtras),
      ...(sourceData ? { source: sourceData } : {}),
      summary: jsonObject({ found: true, source_available: source != null, stale }),
    };
    return {
      ok: true,
      data,
      meta: resultMeta(workspace, {
        authority: source ? 'mixed' : 'atlas_store',
        freshness: source ? (stale ? 'stale' : 'current') : 'unknown',
        warnings: source || request.action === 'brief'
          ? []
          : [{ code: 'SOURCE_UNAVAILABLE', message: `Current source is unavailable for ${filePath}.` }],
      }),
    };
  }

  if (request.action === 'similar') {
    const filePath = canonicalFilePath(request.filePath);
    if (!filePath) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath must be a canonical workspace-relative path.');
    const files = allFiles();
    const source = files.find((file) => file.file_path === filePath);
    if (!source) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No Atlas record exists for ${filePath}.`);
    const minimum = request.minScore ?? 0;
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
      return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'minScore must be between 0 and 1.');
    }
    const items = files
      .filter((file) => file.file_path !== filePath)
      .map((file) => ({ file, score: similarity(source, file) }))
      .filter((item) => item.score >= minimum)
      .sort((a, b) => b.score - a.score || a.file.file_path.localeCompare(b.file.file_path))
      .map((item) => fileItem(item.file, { score: item.score }));
    const page = paginate('query:similar', request, items);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    return {
      ok: true,
      data: { action: 'similar', items: page.items, summary: jsonObject({ candidates: items.length }) },
      meta: resultMeta(workspace, { page: page.page }),
    };
  }

  if (request.action === 'cluster') {
    const files = allFiles();
    const items = request.cluster
      ? files.filter((file) => file.cluster === request.cluster).map((file) => fileItem(file))
      : [...new Set(files.map((file) => file.cluster).filter((cluster): cluster is string => cluster != null))]
        .sort()
        .map((cluster) => jsonObject({ cluster, files: files.filter((file) => file.cluster === cluster).length }));
    const page = paginate('query:cluster', request, items);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    return {
      ok: true,
      data: { action: 'cluster', items: page.items, summary: jsonObject({ clusters: new Set(files.map((file) => file.cluster).filter(Boolean)).size }) },
      meta: resultMeta(workspace, { page: page.page }),
    };
  }

  if (request.action === 'patterns') {
    const files = allFiles();
    let items: AtlasJsonObject[];
    if (request.filePath) {
      const filePath = canonicalFilePath(request.filePath);
      if (!filePath) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath must be a canonical workspace-relative path.');
      const file = files.find((item) => item.file_path === filePath);
      if (!file) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No Atlas record exists for ${filePath}.`);
      items = file.patterns.map((pattern) => jsonObject({ pattern, file_path: filePath }));
    } else if (request.pattern) {
      items = files.filter((file) => file.patterns.includes(request.pattern!)).map((file) => fileItem(file));
    } else {
      const counts = new Map<string, number>();
      for (const file of files) for (const pattern of file.patterns) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
      items = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([pattern, count]) => jsonObject({ pattern, files: count }));
    }
    const page = paginate('query:patterns', request, items);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    return {
      ok: true,
      data: { action: 'patterns', items: page.items, summary: jsonObject({ results: items.length }) },
      meta: resultMeta(workspace, { page: page.page }),
    };
  }

  if (request.action === 'history') {
    const mode = request.mode ?? 'entries';
    const filters = historyFilters(workspace, request);
    const stats = countAtlasChangelog(db, filters);
    let items: AtlasJsonObject[];
    if (mode === 'count') {
      items = [jsonObject(stats)];
    } else if (mode === 'timeline') {
      items = timelineAtlasChangelog(db, filters, request.bucket ?? 'day').map((entry) => jsonObject(entry));
    } else if (mode === 'group') {
      const groupBy = request.groupBy ?? 'file_path';
      const storeGroup = groupBy === 'principal_id' ? 'author_instance_id'
        : groupBy === 'runtime_name' ? 'author_engine'
          : groupBy;
      const total = countAtlasChangelogGroups(db, filters, storeGroup);
      const scope = cursorScope('query:history:group', request);
      const parsed = request.cursor ? parseAtlasCursor(request.cursor, scope) : { ok: true as const, offset: 0 };
      if (!parsed.ok || parsed.offset > total) {
        const cursorError = !parsed.ok ? parsed.code : 'CURSOR_OUT_OF_RANGE';
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `Invalid Atlas cursor (${cursorError}).`, jsonObject({ cursor_error: cursorError }));
      }
      const limit = request.limit ?? 20;
      items = groupAtlasChangelog(db, filters, storeGroup, limit, parsed.offset)
        .map((entry) => jsonObject({ group: entry.key, count: entry.count, earliest: entry.earliest, latest: entry.latest }));
      const nextOffset = parsed.offset + items.length;
      const page: AtlasPageMeta = {
        next_cursor: nextOffset < total ? createAtlasCursor(scope, nextOffset) : null,
        returned: items.length,
        total,
        truncated: nextOffset < total,
      };
      return {
        ok: true,
        data: { action: 'history', items, summary: jsonObject({ mode, entries: stats.total, groups: total }) },
        meta: resultMeta(workspace, { page, freshness: 'historical' }),
      };
    } else {
      const scope = cursorScope(`query:history:${mode}`, request);
      const parsed = request.cursor ? parseAtlasCursor(request.cursor, scope) : { ok: true as const, offset: 0 };
      if (!parsed.ok || parsed.offset > stats.total) {
        const cursorError = !parsed.ok ? parsed.code : 'CURSOR_OUT_OF_RANGE';
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `Invalid Atlas cursor (${cursorError}).`, jsonObject({ cursor_error: cursorError }));
      }
      const limit = request.limit ?? 20;
      const entries = queryAtlasChangelog(db, { ...filters, limit, offset: parsed.offset });
      const nextOffset = parsed.offset + entries.length;
      const page: AtlasPageMeta = {
        next_cursor: nextOffset < stats.total ? createAtlasCursor(scope, nextOffset) : null,
        returned: entries.length,
        total: stats.total,
        truncated: nextOffset < stats.total,
      };
      return {
        ok: true,
        data: { action: 'history', items: entries.map(changelogItem), summary: jsonObject({ mode, entries: stats.total }) },
        meta: resultMeta(workspace, { page, freshness: 'historical' }),
      };
    }
    const page = paginate(`query:history:${mode}`, request, items);
    if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
    return {
      ok: true,
      data: { action: 'history', items: page.items, summary: jsonObject({ mode, entries: stats.total }) },
      meta: resultMeta(workspace, { page: { ...page.page, total: items.length }, freshness: 'historical' }),
    };
  }

  if (request.action === 'snapshot' || request.action === 'diff') {
    const filePath = request.filePath == null ? null : canonicalFilePath(request.filePath);
    if (!filePath && request.changelogId == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath or changelogId is required.');
    const runtime: AtlasRuntime = {
      db,
      config: {
        workspace,
        sourceRoot: sourceRoot ?? '',
        dbPath: '',
        concurrency: 1,
        sqliteVecExtension: '',
        embeddingModel: '',
        embeddingDimensions: 0,
      },
    };
    if (request.action === 'snapshot') {
      const maximum = boundedInteger(request.maxLines, 400, 1, MAX_SOURCE_LINES);
      if (maximum == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `maxLines must be an integer from 1 to ${MAX_SOURCE_LINES}.`);
      const result = computeSnapshot(runtime, {
        ...(filePath ? { filePath } : {}),
        ...(request.changelogId == null ? {} : { changelogId: request.changelogId }),
        ...(request.at != null ? { at: String(request.at) } : request.changelogId == null ? { at: 'latest' } : {}),
        maxLines: maximum,
        workspace,
      });
      if ('error' in result) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', result.error);
      const bounded = { ...result, content: trimString(result.content, MAX_TEXT_CHARACTERS) };
      return {
        ok: true,
        data: { action: 'snapshot', items: [], record: jsonObject(bounded), summary: jsonObject({ found: true }) },
        meta: resultMeta(workspace, { authority: 'atlas_store', freshness: 'historical' }),
      };
    }
    const contextLines = boundedInteger(request.contextLines, 3, 0, 20);
    if (contextLines == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'contextLines must be an integer from 0 to 20.');
    const result = request.changelogId == null
      ? computeDiff(runtime, {
        filePath: filePath!,
        from: request.from == null ? 'prev' : String(request.from),
        to: request.to == null ? 'latest' : String(request.to),
        mode: 'unified',
        contextLines,
        workspace,
      })
      : computeChangelogDiff(runtime, {
        changelogId: request.changelogId,
        from: request.from == null ? undefined : String(request.from),
        to: request.to == null ? undefined : String(request.to),
        mode: 'unified',
        workspace,
      });
    if ('error' in result) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', result.error);
    const bounded = {
      ...result,
      diff_content: result.diff_content == null ? null : trimString(result.diff_content, MAX_TEXT_CHARACTERS),
    };
    return {
      ok: true,
      data: { action: 'diff', items: [], record: jsonObject(bounded), summary: jsonObject({ found: true }) },
      meta: resultMeta(workspace, { authority: 'atlas_store', freshness: 'historical' }),
    };
  }

  return errorOutcome(workspace, 'ATLAS_UNSUPPORTED_ACTION', `Unsupported query action: ${(request as { action: string }).action}.`);
}

function buildEdges(imports: readonly AtlasImportEdgeRecord[], references: readonly AtlasReferenceRecord[]): GraphEdge[] {
  const edges: GraphEdge[] = [
    ...imports.map((edge) => ({
      source: edge.source_file,
      target: edge.target_file,
      type: 'import',
      usageCount: 1,
      confidence: 1,
      provenance: 'parser',
      sourceSymbolId: null,
      targetSymbolId: null,
    })),
    ...references.map((edge) => ({
      source: edge.source_file,
      target: edge.target_file,
      type: edge.edge_type,
      usageCount: edge.usage_count,
      confidence: edge.confidence,
      provenance: edge.provenance,
      sourceSymbolId: edge.source_symbol_id,
      targetSymbolId: edge.target_symbol_id,
    })),
  ];
  return edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type));
}

function adjacency(edges: readonly GraphEdge[], reverse = false): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = reverse ? edge.target : edge.source;
    const to = reverse ? edge.source : edge.target;
    const targets = result.get(from) ?? new Set<string>();
    targets.add(to);
    result.set(from, targets);
  }
  return new Map([...result].map(([key, values]) => [key, [...values].sort()]));
}

function traverse(start: string, graph: Map<string, string[]>, depth: number, maximum: number): { nodes: string[]; paths: string[][] } {
  const seen = new Set([start]);
  const paths: string[][] = [[start]];
  const queue: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
  while (queue.length > 0 && seen.size < maximum) {
    const current = queue.shift()!;
    if (current.path.length - 1 >= depth) continue;
    for (const next of graph.get(current.node) ?? []) {
      if (seen.has(next)) continue;
      const nextPath = [...current.path, next];
      seen.add(next);
      paths.push(nextPath);
      queue.push({ node: next, path: nextPath });
      if (seen.size >= maximum) break;
    }
  }
  return { nodes: [...seen].sort(), paths };
}

function shortestPath(from: string, to: string, graph: Map<string, string[]>, maxHops: number): string[] | null {
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = current[current.length - 1]!;
    if (node === to) return current;
    if (current.length - 1 >= maxHops) continue;
    for (const next of graph.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...current, next]);
    }
  }
  return null;
}

function graphEdgeWeight(edge: GraphEdge): number {
  const edgeType = edge.type.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (edgeType === 'import' || edgeType === 'runtime_call') return 1;
  if (edgeType === 'reexport') return 0.75;
  if (edgeType === 'type_ref') return 1.25;
  if (edgeType === 'config_ref') return 1.5;
  return 1.1;
}

function weightedShortestPath(
  from: string,
  to: string,
  edges: readonly GraphEdge[],
  maxHops: number,
): { path: string[]; cost: number } | null {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const values = outgoing.get(edge.source) ?? [];
    values.push(edge);
    outgoing.set(edge.source, values);
  }
  for (const values of outgoing.values()) {
    values.sort((left, right) => left.target.localeCompare(right.target) || left.type.localeCompare(right.type));
  }
  const frontier: Array<{ node: string; path: string[]; cost: number }> = [{ node: from, path: [from], cost: 0 }];
  const best = new Map<string, { cost: number; pathKey: string }>([
    [`${from}\0${0}`, { cost: 0, pathKey: from }],
  ]);
  while (frontier.length > 0) {
    frontier.sort((left, right) => left.cost - right.cost
      || left.path.length - right.path.length
      || left.path.join('\0').localeCompare(right.path.join('\0')));
    const current = frontier.shift()!;
    if (current.node === to) return { path: current.path, cost: current.cost };
    if (current.path.length - 1 >= maxHops) continue;
    for (const edge of outgoing.get(current.node) ?? []) {
      if (current.path.includes(edge.target)) continue;
      const path = [...current.path, edge.target];
      const cost = current.cost + graphEdgeWeight(edge);
      const hops = path.length - 1;
      const candidate = { cost, pathKey: path.join('\0') };
      const stateKey = `${edge.target}\0${hops}`;
      const prior = best.get(stateKey);
      if (prior && (prior.cost < candidate.cost
        || (prior.cost === candidate.cost && prior.pathKey <= candidate.pathKey))) {
        continue;
      }
      best.set(stateKey, candidate);
      frontier.push({ node: edge.target, path, cost });
    }
  }
  return null;
}

function findCycles(nodes: readonly string[], graph: Map<string, string[]>): string[][] {
  const allowed = new Set(nodes);
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    stacked.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!allowed.has(next)) continue;
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (stacked.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let popped: string;
    do {
      popped = stack.pop()!;
      stacked.delete(popped);
      component.push(popped);
    } while (popped !== node);
    component.sort();
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component);
  };
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function edgeItem(edge: GraphEdge): AtlasJsonObject {
  return jsonObject({
    source_file: edge.source,
    target_file: edge.target,
    edge_type: edge.type,
    usage_count: edge.usageCount,
    confidence: edge.confidence,
    provenance: edge.provenance,
    source_symbol_id: edge.sourceSymbolId,
    target_symbol_id: edge.targetSymbolId,
  });
}

function symbolItem(symbol: AtlasSymbolRecord): AtlasJsonObject {
  return jsonObject({
    id: symbol.id,
    file_path: symbol.file_path,
    name: symbol.name,
    kind: symbol.kind,
    exported: symbol.exported,
    range: symbol.line_start == null || symbol.line_end == null ? null : { start_line: symbol.line_start, end_line: symbol.line_end },
    signature_hash: symbol.signature_hash,
  });
}

async function executeGraph(db: AtlasDatabase, request: AtlasGraphRequest): Promise<AtlasReadOutcome> {
  const commonError = validateCommon(request);
  const workspace = request.workspace ?? '';
  if (commonError) return { ok: false, error: commonError, meta: resultMeta(workspace) };
  const graphError = validateGraphRequest(request);
  if (graphError) return { ok: false, error: graphError, meta: resultMeta(workspace) };
  const maxNodes = boundedInteger(request.maxNodes, 200, 1, MAX_GRAPH_NODES);
  const maxEdges = boundedInteger(request.maxEdges, 1_000, 1, MAX_GRAPH_EDGES);
  if (maxNodes == null || maxEdges == null) {
    return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `maxNodes/maxEdges must be bounded integers (${MAX_GRAPH_NODES}/${MAX_GRAPH_EDGES}).`);
  }
  const scannedFiles = listAtlasFiles(db, workspace, MAX_SCAN_RECORDS);
  const importEdges = listImportEdges(db, workspace, MAX_SCAN_RECORDS);
  const references = listReferences(db, workspace, undefined, MAX_SCAN_RECORDS);
  const allSymbols = listSymbols(db, workspace, undefined, MAX_SCAN_RECORDS);
  const scanTruncated = scannedFiles.length >= MAX_SCAN_RECORDS
    || importEdges.length >= MAX_SCAN_RECORDS
    || references.length >= MAX_SCAN_RECORDS
    || allSymbols.length >= MAX_SCAN_RECORDS;
  const files = scannedFiles
    .filter((file) => request.includeTestFiles === true || !isTestFile(file.file_path))
    .sort((a, b) => a.file_path.localeCompare(b.file_path));
  const fileSet = new Set(files.map((file) => file.file_path));
  let edges = buildEdges(importEdges, references)
    .filter((edge) => fileSet.has(edge.source) && fileSet.has(edge.target));
  if ((request.action === 'impact' && request.includeReferences === false)
    || (request.action === 'neighbors' && request.includeReferences !== true)) {
    edges = edges.filter((edge) => edge.type === 'import');
  }
  if ('edgeTypes' in request && request.edgeTypes?.length) {
    const accepted = new Set<string>(request.edgeTypes);
    edges = edges.filter((edge) => accepted.has(edge.type));
  }
  const forward = adjacency(edges);
  const reverse = adjacency(edges, true);
  let nodes: string[] = [];
  let paths: string[][] = [];
  let cycles: string[][] = [];
  let symbols: AtlasSymbolRecord[] = [];
  let traceCost: number | null = null;

  if (request.action === 'impact' || request.action === 'neighbors') {
    const filePath = canonicalFilePath(request.filePath);
    if (!filePath) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath must be a canonical workspace-relative path.');
    if (!fileSet.has(filePath)) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No Atlas record exists for ${filePath}.`);
    const depth = boundedInteger(request.depth, request.action === 'impact' ? 3 : 1, 0, 20);
    if (depth == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'depth must be an integer from 0 to 20.');
    if (request.action === 'impact' && request.symbol) {
      const target = allSymbols.find((symbol) => symbol.file_path === filePath && symbol.name === request.symbol);
      if (!target) return errorOutcome(workspace, 'ATLAS_NOT_FOUND', `No symbol named ${request.symbol} exists in ${filePath}.`);
      const direct = [...new Set(references
        .filter((reference) => reference.target_symbol_id === target.id)
        .map((reference) => reference.source_file))].sort();
      nodes = [filePath];
      paths = [[filePath]];
      for (const importer of direct) {
        const transitive = traverse(importer, reverse, Math.max(0, depth - 1), maxNodes);
        nodes.push(...transitive.nodes);
        paths.push(...transitive.paths.map((route) => [filePath, ...route]));
      }
      nodes = [...new Set(nodes)].sort().slice(0, maxNodes);
      symbols = [target];
    } else if (request.action === 'impact' || request.direction === 'importers') {
      ({ nodes, paths } = traverse(filePath, reverse, depth, maxNodes));
    } else if (request.direction === 'imports') {
      ({ nodes, paths } = traverse(filePath, forward, depth, maxNodes));
    } else {
      const outgoing = traverse(filePath, forward, depth, maxNodes);
      const incoming = traverse(filePath, reverse, depth, maxNodes);
      nodes = [...new Set([...outgoing.nodes, ...incoming.nodes])].sort().slice(0, maxNodes);
      paths = [...outgoing.paths, ...incoming.paths].sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
    }
    if (request.includeSymbols) symbols = allSymbols.filter((symbol) => nodes.includes(symbol.file_path));
  } else if (request.action === 'trace') {
    let from: string | null;
    let to: string | null;
    if ('fromSymbol' in request && request.fromSymbol && request.toSymbol) {
      const fromMatches = allSymbols.filter((symbol) => symbol.name === request.fromSymbol);
      const toMatches = allSymbols.filter((symbol) => symbol.name === request.toSymbol);
      if (fromMatches.length !== 1 || toMatches.length !== 1) {
        return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'Symbol trace endpoints must each resolve to exactly one indexed symbol.', jsonObject({
          from_matches: fromMatches.map((symbol) => symbol.file_path),
          to_matches: toMatches.map((symbol) => symbol.file_path),
        }));
      }
      from = fromMatches[0]!.file_path;
      to = toMatches[0]!.file_path;
      symbols = [fromMatches[0]!, toMatches[0]!];
    } else {
      from = canonicalFilePath('from' in request ? request.from : null);
      to = canonicalFilePath('to' in request ? request.to : null);
    }
    if (!from || !to) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'Trace endpoints must be canonical workspace-relative paths.');
    const maxHops = boundedInteger(request.maxHops, 8, 1, 50);
    if (maxHops == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'maxHops must be an integer from 1 to 50.');
    const weighted = request.weighted === true
      ? weightedShortestPath(from, to, edges, maxHops)
      : null;
    const found = request.weighted === true
      ? weighted?.path ?? null
      : shortestPath(from, to, forward, maxHops);
    paths = found ? [found] : [];
    nodes = found ?? [];
    traceCost = request.weighted === true ? weighted?.cost ?? null : found ? found.length - 1 : null;
  } else if (request.action === 'cycles') {
    const minSize = boundedInteger(request.minSize, 2, 1, MAX_GRAPH_NODES);
    if (minSize == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'minSize must be a bounded positive integer.');
    cycles = findCycles([...fileSet].sort().slice(0, maxNodes), forward).filter((cycle) => cycle.length >= minSize);
    if (request.filePath) cycles = cycles.filter((cycle) => cycle.includes(canonicalFilePath(request.filePath)!));
    cycles = cycles.slice(0, request.limit ?? 20);
    nodes = [...new Set(cycles.flat())].sort().slice(0, maxNodes);
  } else if (request.action === 'reachability') {
    if (request.mode === 'path_query') {
      const from = canonicalFilePath(request.from);
      const to = canonicalFilePath(request.to);
      if (!from || !to) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'path_query requires canonical from and to paths.');
      const found = shortestPath(from, to, forward, 50);
      paths = found ? [found] : [];
      nodes = found ?? [];
    } else if (request.mode === 'entrypoints') {
      nodes = [...fileSet].filter((node) => (reverse.get(node) ?? []).length === 0).sort().slice(0, maxNodes);
    } else if (request.mode === 'dead_files') {
      nodes = [...fileSet].filter((node) => (reverse.get(node) ?? []).length === 0 && (forward.get(node) ?? []).length === 0).sort().slice(0, maxNodes);
    } else {
      const exportedSymbols = allSymbols.filter((symbol) => symbol.exported);
      const used = new Set(references.map((reference) => reference.target_symbol_id).filter((id): id is number => id != null));
      symbols = exportedSymbols
        .filter((candidate) => !used.has(candidate.id))
        .filter((candidate) => !request.filePath || candidate.file_path === canonicalFilePath(request.filePath))
        .filter((candidate) => !request.symbol || candidate.name === request.symbol)
        .slice(0, request.limit ?? 20);
      nodes = [...new Set(symbols.map((symbol) => symbol.file_path))].sort().slice(0, maxNodes);
    }
  } else if (request.action === 'cluster') {
    nodes = files.filter((file) => file.cluster === request.cluster).map((file) => file.file_path).slice(0, maxNodes);
  } else if (request.action === 'graph') {
    if (request.filePath) {
      const filePath = canonicalFilePath(request.filePath);
      if (!filePath) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'filePath must be a canonical workspace-relative path.');
      const depth = boundedInteger(request.depth, 2, 0, 20);
      if (depth == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'depth must be an integer from 0 to 20.');
      if (request.direction === 'both') {
        const imports = traverse(filePath, forward, depth, maxNodes);
        const importers = traverse(filePath, reverse, depth, maxNodes);
        nodes = [...new Set([...imports.nodes, ...importers.nodes])].sort().slice(0, maxNodes);
        paths = [...imports.paths, ...importers.paths];
      } else {
        const selected = traverse(filePath, request.direction === 'importers' ? reverse : forward, depth, maxNodes);
        nodes = selected.nodes;
        paths = selected.paths;
      }
    } else {
      nodes = [...fileSet].sort().slice(0, maxNodes);
    }
    if (request.includeSymbols) symbols = allSymbols.filter((symbol) => nodes.includes(symbol.file_path));
  } else {
    return errorOutcome(workspace, 'ATLAS_UNSUPPORTED_ACTION', `Unsupported graph action: ${(request as { action: string }).action}.`);
  }

  const nodeSet = new Set(nodes);
  const selectedEdges = edges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target)).slice(0, maxEdges);
  const data: AtlasGraphData = {
    action: request.action,
    nodes,
    edges: selectedEdges.map(edgeItem),
    paths: paths.slice(0, request.limit ?? 20),
    cycles,
    symbols: symbols.slice(0, request.limit ?? 20).map(symbolItem),
    summary: jsonObject({
      nodes: nodes.length,
      edges: selectedEdges.length,
      paths: paths.length,
      cycles: cycles.length,
      ...(request.action === 'trace' ? { weighted: request.weighted === true, total_cost: traceCost } : {}),
      scan_truncated: scanTruncated,
      truncated: nodes.length >= maxNodes || selectedEdges.length >= maxEdges,
    }),
  };
  return {
    ok: true,
    data,
    meta: resultMeta(workspace, {
      completeness: scanTruncated ? 'partial' : 'complete',
      warnings: scanTruncated
        ? [{ code: 'SCAN_LIMIT_REACHED', message: `Graph scan reached the ${MAX_SCAN_RECORDS}-record safety bound.` }]
        : [],
    }),
  };
}

function auditSeverityRank(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

async function executeAudit(db: AtlasDatabase, request: AtlasAuditRequest): Promise<AtlasReadOutcome> {
  const commonError = validateCommon(request);
  const workspace = request.workspace ?? '';
  if (commonError) return { ok: false, error: commonError, meta: resultMeta(workspace) };
  const auditError = validateAuditRequest(request);
  if (auditError) return { ok: false, error: auditError, meta: resultMeta(workspace) };
  const requestedFilePath = request.filePath ? canonicalFilePath(request.filePath) : null;
  const scannedFiles = listAtlasFiles(db, workspace, MAX_SCAN_RECORDS);
  const scannedImports = listImportEdges(db, workspace, MAX_SCAN_RECORDS);
  const scannedReferences = listReferences(db, workspace, undefined, MAX_SCAN_RECORDS);
  const scanTruncated = scannedFiles.length >= MAX_SCAN_RECORDS
    || scannedImports.length >= MAX_SCAN_RECORDS
    || scannedReferences.length >= MAX_SCAN_RECORDS;
  const files = scannedFiles
    .filter((file) => request.includeTestFiles === true || !isTestFile(file.file_path))
    .filter((file) => !requestedFilePath || file.file_path === requestedFilePath)
    .filter((file) => !request.cluster || file.cluster === request.cluster)
    .sort((a, b) => a.file_path.localeCompare(b.file_path));
  const edges = buildEdges(
    scannedImports,
    scannedReferences,
  );
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  let items: AtlasJsonObject[] = [];
  if (request.action === 'gaps') {
    for (const file of files) {
      const gaps: Array<{ gap: string; severity: 'low' | 'medium' | 'high' }> = [];
      if (!file.purpose.trim()) gaps.push({ gap: 'purpose', severity: 'high' });
      if (!file.blurb.trim()) gaps.push({ gap: 'blurb', severity: 'high' });
      if (file.tags.length === 0) gaps.push({ gap: 'tags', severity: 'medium' });
      if (file.patterns.length === 0) gaps.push({ gap: 'patterns', severity: 'low' });
      if (file.source_highlights.length === 0) gaps.push({ gap: 'source_highlights', severity: 'medium' });
      if (!file.cross_refs) gaps.push({ gap: 'cross_references', severity: 'medium' });
      for (const gap of gaps) {
        if (request.gapTypes?.length && !request.gapTypes.includes(gap.gap)) continue;
        items.push(jsonObject({ file_path: file.file_path, ...gap }));
      }
    }
  } else if (request.action === 'smells') {
    for (const file of files) {
      if (file.loc >= 1_000) items.push(jsonObject({ file_path: file.file_path, smell: 'large_file', severity: 'high', line_count: file.loc }));
      if ((degree.get(file.file_path) ?? 0) >= 10) items.push(jsonObject({ file_path: file.file_path, smell: 'high_coupling', severity: 'medium', degree: degree.get(file.file_path)! }));
      if (file.hazards.length >= 5) items.push(jsonObject({ file_path: file.file_path, smell: 'hazard_density', severity: 'medium', hazards: file.hazards.length }));
    }
    const cycles = findCycles(files.map((file) => file.file_path).slice(0, MAX_GRAPH_NODES), adjacency(edges));
    for (const cycle of cycles) items.push(jsonObject({ smell: 'dependency_cycle', severity: 'high', files: cycle }));
  } else if (request.action === 'hotspots') {
    const changes = new Map<string, number>();
    const changeRows = db.prepare(
      `SELECT file_path, COUNT(*) AS count
       FROM atlas_changelog
       WHERE workspace = ?${request.since ? ' AND created_at >= ?' : ''}
       GROUP BY file_path`,
    ).all(...(request.since ? [workspace, request.since] : [workspace])) as Array<{ file_path: string; count: number }>;
    for (const entry of changeRows) {
      changes.set(entry.file_path, entry.count);
    }
    const weights = {
      changes: request.weights?.changes ?? 3,
      degree: request.weights?.degree ?? 2,
      size: request.weights?.size ?? 1,
    };
    if (Object.values(weights).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
      return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', 'Hotspot weights must be finite numbers from 0 to 100.');
    }
    items = files.map((file) => {
      const score = (changes.get(file.file_path) ?? 0) * weights.changes
        + (degree.get(file.file_path) ?? 0) * weights.degree
        + Math.log2(Math.max(1, file.loc)) * weights.size;
      return jsonObject({
        file_path: file.file_path,
        score,
        changes: changes.get(file.file_path) ?? 0,
        degree: degree.get(file.file_path) ?? 0,
        line_count: file.loc,
      });
    }).sort((left, right) => Number(right.score) - Number(left.score) || String(left.file_path).localeCompare(String(right.file_path)));
    const topN = boundedInteger(request.topN, request.limit ?? 20, 1, MAX_RESULT_ITEMS);
    if (topN == null) return errorOutcome(workspace, 'ATLAS_INVALID_REQUEST', `topN must be an integer from 1 to ${MAX_RESULT_ITEMS}.`);
    items = items.slice(0, topN);
  } else {
    return errorOutcome(workspace, 'ATLAS_UNSUPPORTED_ACTION', `Unsupported audit action: ${(request as { action: string }).action}.`);
  }
  if (request.minSeverity && request.action !== 'hotspots') {
    const threshold = auditSeverityRank(request.minSeverity);
    items = items.filter((item) => auditSeverityRank(String(item.severity) as 'low' | 'medium' | 'high') >= threshold);
  }
  if (request.action !== 'hotspots') {
    items.sort((left, right) => String(left.file_path ?? '').localeCompare(String(right.file_path ?? '')) || String(left.gap ?? left.smell ?? '').localeCompare(String(right.gap ?? right.smell ?? '')));
  }
  const page = paginate(`audit:${request.action}`, request, items);
  if ('code' in page) return { ok: false, error: page, meta: resultMeta(workspace) };
  const data: AtlasAuditData = {
    action: request.action,
    items: page.items,
    summary: jsonObject({
      findings: items.length,
      files_scanned: files.length,
      graph_scan_truncated: request.action === 'smells' && files.length > MAX_GRAPH_NODES,
      store_scan_truncated: scanTruncated,
    }),
  };
  return {
    ok: true,
    data,
    meta: resultMeta(workspace, {
      page: page.page,
      completeness: scanTruncated ? 'partial' : 'complete',
      warnings: scanTruncated
        ? [{ code: 'SCAN_LIMIT_REACHED', message: `Audit scan reached the ${MAX_SCAN_RECORDS}-record safety bound.` }]
        : [],
    }),
  };
}

export async function executeAtlasRead(db: AtlasDatabase, input: AtlasReadRequest): Promise<AtlasReadOutcome> {
  if (!input || typeof input !== 'object' || !('family' in input) || !('request' in input)) {
    return errorOutcome('', 'ATLAS_INVALID_REQUEST', 'A read family and request are required.');
  }
  if (input.family === 'query') return executeQuery(db, input.request);
  if (input.family === 'graph') return executeGraph(db, input.request);
  if (input.family === 'audit') return executeAudit(db, input.request);
  return errorOutcome('', 'ATLAS_UNSUPPORTED_ACTION', `Unsupported read family: ${(input as { family: string }).family}.`);
}
