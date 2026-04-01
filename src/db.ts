import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  AtlasCrossRefs,
  AtlasFileRecord,
  AtlasMetaRecord,
  AtlasQueueRecord,
} from './types.js';

export interface AtlasStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface AtlasDatabase {
  prepare(sql: string): AtlasStatement;
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  loadExtension(extensionPath: string): unknown;
  transaction<F extends (...args: any[]) => unknown>(fn: F): F;
  close(): void;
}

export interface AtlasSearchHit {
  file: AtlasFileRecord;
  rank: number;
  score: number;
  source: 'fts' | 'vector';
}

export interface AtlasDbOptions {
  dbPath: string;
  migrationDir: string;
  sqliteVecExtension?: string;
}

export interface AtlasImportEdgeRecord {
  workspace: string;
  source_file: string;
  target_file: string;
}

export interface AtlasMetaUpsertInput {
  workspace: string;
  source_root: string;
  provider?: string | null;
  provider_config?: Record<string, unknown>;
}

export interface AtlasFileUpsertInput {
  workspace: string;
  file_path: string;
  file_hash?: string | null;
  cluster?: string | null;
  loc?: number;
  blurb?: string;
  purpose?: string;
  public_api?: unknown[];
  exports?: Array<{ name: string; type: string }>;
  patterns?: string[];
  dependencies?: Record<string, unknown>;
  data_flows?: string[];
  key_types?: unknown[];
  hazards?: string[];
  conventions?: string[];
  cross_refs?: AtlasCrossRefs | null;
  language?: string;
  extraction_model?: string | null;
  last_extracted?: string | null;
}

function ensureDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readMigrationFiles(migrationDir: string): string[] {
  if (!fs.existsSync(migrationDir)) {
    return [];
  }
  return fs.readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(migrationDir, name));
}

function loadSqliteVec(db: AtlasDatabase, extensionPath?: string): void {
  if (!extensionPath) {
    return;
  }

  try {
    db.loadExtension(extensionPath);
  } catch {
    // The scaffold should still boot if the extension is unavailable locally.
  }
}

export function openAtlasDatabase(options: AtlasDbOptions): AtlasDatabase {
  ensureDirectory(options.dbPath);

  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  loadSqliteVec(db, options.sqliteVecExtension);

  for (const migrationPath of readMigrationFiles(options.migrationDir)) {
    db.exec(fs.readFileSync(migrationPath, 'utf8'));
  }

  return db;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyFtsValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function ftsDocumentForRecord(record: AtlasFileRecord): Record<string, string> {
  return {
    file_path: record.file_path,
    blurb: record.blurb,
    purpose: record.purpose,
    public_api: stringifyFtsValue(record.public_api),
    patterns: stringifyFtsValue(record.patterns),
    hazards: stringifyFtsValue(record.hazards),
    cross_refs: stringifyFtsValue(record.cross_refs ?? {}),
  };
}

export function mapFileRecord(row: Record<string, unknown>): AtlasFileRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    file_hash: row.file_hash == null ? null : String(row.file_hash),
    cluster: row.cluster == null ? null : String(row.cluster),
    loc: Number(row.loc ?? 0),
    blurb: String(row.blurb ?? ''),
    purpose: String(row.purpose ?? ''),
    public_api: parseJson<unknown[]>(row.public_api, []),
    exports: parseJson<Array<{ name: string; type: string }>>(row.exports, []),
    patterns: parseJson<string[]>(row.patterns, []),
    dependencies: parseJson<Record<string, unknown>>(row.dependencies, {}),
    data_flows: parseJson<string[]>(row.data_flows, []),
    key_types: parseJson<unknown[]>(row.key_types, []),
    hazards: parseJson<string[]>(row.hazards, []),
    conventions: parseJson<string[]>(row.conventions, []),
    cross_refs: parseJson<AtlasCrossRefs | null>(row.cross_refs, null),
    language: String(row.language ?? 'typescript'),
    extraction_model: row.extraction_model == null ? null : String(row.extraction_model),
    last_extracted: row.last_extracted == null ? null : String(row.last_extracted),
  };
}

export function mapQueueRecord(row: Record<string, unknown>): AtlasQueueRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    trigger_reason: String(row.trigger_reason ?? 'file_release'),
    queued_at: String(row.queued_at ?? ''),
    started_at: row.started_at == null ? null : String(row.started_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    status: String(row.status ?? 'pending'),
    error_message: row.error_message == null ? null : String(row.error_message),
  };
}

export function mapMetaRecord(row: Record<string, unknown>): AtlasMetaRecord {
  return {
    workspace: String(row.workspace ?? ''),
    source_root: String(row.source_root ?? ''),
    provider: row.provider == null ? null : String(row.provider),
    provider_config: parseJson<Record<string, unknown>>(row.provider_config, {}),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function getAtlasFile(db: AtlasDatabase, workspace: string, filePath: string): AtlasFileRecord | null {
  const row = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as Record<string, unknown> | undefined;
  return row ? mapFileRecord(row) : null;
}

export function searchAtlasFiles(db: AtlasDatabase, workspace: string, query: string, limit = 5): AtlasFileRecord[] {
  const like = `%${query}%`;
  const rows = db.prepare(
    `SELECT * FROM atlas_files
     WHERE workspace = ?
       AND (
         file_path LIKE ?
         OR blurb LIKE ?
         OR purpose LIKE ?
         OR exports LIKE ?
         OR patterns LIKE ?
         OR hazards LIKE ?
       )
     ORDER BY updated_at DESC, file_path ASC
     LIMIT ?`,
  ).all(workspace, like, like, like, like, like, like, limit) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function searchFts(db: AtlasDatabase, workspace: string, query: string, limit = 10): AtlasSearchHit[] {
  const rows = db.prepare(
    `SELECT f.*, rank
     FROM atlas_fts
     JOIN atlas_files AS f ON f.id = atlas_fts.rowid
     WHERE f.workspace = ?
       AND atlas_fts MATCH ?
     ORDER BY rank ASC, f.file_path ASC
     LIMIT ?`,
  ).all(workspace, query, limit) as Array<Record<string, unknown> & { rank?: number }>;

  return rows.map((row, index) => ({
    file: mapFileRecord(row),
    rank: index + 1,
    score: typeof row.rank === 'number' ? row.rank : index + 1,
    source: 'fts',
  }));
}

export function searchVector(db: AtlasDatabase, workspace: string, embedding: number[], limit = 10): AtlasSearchHit[] {
  const rows = db.prepare(
    `SELECT f.*, distance
     FROM atlas_embeddings
     JOIN atlas_files AS f ON f.id = atlas_embeddings.file_id
     WHERE f.workspace = ?
       AND embedding MATCH ?
       AND k = ?
     ORDER BY distance ASC, f.file_path ASC
     LIMIT ?`,
  ).all(workspace, JSON.stringify(embedding), limit, limit) as Array<Record<string, unknown> & { distance?: number }>;

  return rows.map((row, index) => ({
    file: mapFileRecord(row),
    rank: index + 1,
    score: typeof row.distance === 'number' ? row.distance : index + 1,
    source: 'vector',
  }));
}

export function populateFts(db: AtlasDatabase, fileId: number): void {
  const row = db.prepare('SELECT * FROM atlas_files WHERE id = ? LIMIT 1').get(fileId) as Record<string, unknown> | undefined;
  if (!row) {
    return;
  }

  const record = mapFileRecord(row);
  const document = ftsDocumentForRecord(record);

  db.prepare('DELETE FROM atlas_fts WHERE rowid = ?').run(fileId);
  db.prepare(
    `INSERT INTO atlas_fts (
       rowid, file_path, blurb, purpose, public_api, patterns, hazards, cross_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fileId,
    document.file_path,
    document.blurb,
    document.purpose,
    document.public_api,
    document.patterns,
    document.hazards,
    document.cross_refs,
  );
}

export function rebuildFts(db: AtlasDatabase): void {
  db.prepare('DELETE FROM atlas_fts').run();
  const rows = db.prepare('SELECT id FROM atlas_files ORDER BY id ASC').all() as Array<{ id: number }>;
  for (const row of rows) {
    populateFts(db, row.id);
  }
}

export function listClusterFiles(db: AtlasDatabase, workspace: string, cluster: string): AtlasFileRecord[] {
  const rows = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? AND cluster = ? ORDER BY file_path ASC',
  ).all(workspace, cluster) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function listPatternFiles(db: AtlasDatabase, workspace: string, pattern: string): AtlasFileRecord[] {
  const rows = db.prepare(
    `SELECT * FROM atlas_files
     WHERE workspace = ?
       AND EXISTS (
         SELECT 1
         FROM json_each(atlas_files.patterns)
         WHERE json_each.value = ?
       )
     ORDER BY file_path ASC`,
  ).all(workspace, pattern) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function enqueueReextract(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  triggerReason = 'file_release',
): void {
  db.prepare(
    `INSERT INTO atlas_reextract_queue (workspace, file_path, trigger_reason, status)
     VALUES (?, ?, ?, 'pending')`,
  ).run(workspace, filePath, triggerReason);
}

export function replaceImportEdges(db: AtlasDatabase, workspace: string, edges: AtlasImportEdgeRecord[]): void {
  const deleteStmt = db.prepare('DELETE FROM import_edges WHERE workspace = ?');
  const insertStmt = db.prepare(
    'INSERT INTO import_edges (workspace, source_file, target_file) VALUES (?, ?, ?)',
  );

  const tx = db.transaction((batch: AtlasImportEdgeRecord[]) => {
    deleteStmt.run(workspace);
    for (const edge of batch) {
      insertStmt.run(edge.workspace, edge.source_file, edge.target_file);
    }
  });

  tx(edges);
}

export function upsertAtlasMeta(db: AtlasDatabase, input: AtlasMetaUpsertInput): void {
  db.prepare(
    `INSERT INTO atlas_meta (workspace, source_root, provider, provider_config, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace) DO UPDATE SET
       source_root = excluded.source_root,
       provider = excluded.provider,
       provider_config = excluded.provider_config,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    input.workspace,
    input.source_root,
    input.provider ?? null,
    JSON.stringify(input.provider_config ?? {}),
  );
}

export function listAtlasFiles(db: AtlasDatabase, workspace: string): AtlasFileRecord[] {
  const rows = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? ORDER BY file_path ASC',
  ).all(workspace) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function listImportEdges(db: AtlasDatabase, workspace: string): AtlasImportEdgeRecord[] {
  return db.prepare(
    'SELECT workspace, source_file, target_file FROM import_edges WHERE workspace = ?',
  ).all(workspace) as AtlasImportEdgeRecord[];
}

export function listImportedBy(db: AtlasDatabase, workspace: string, targetFile: string): string[] {
  const rows = db.prepare(
    'SELECT source_file FROM import_edges WHERE workspace = ? AND target_file = ?',
  ).all(workspace, targetFile) as Array<{ source_file: string }>;
  return rows.map((row) => row.source_file);
}

export function getAtlasFileByWorkspacePath(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
): AtlasFileRecord | null {
  return getAtlasFile(db, workspace, filePath);
}

export function getAtlasFileId(db: AtlasDatabase, workspace: string, filePath: string): number | null {
  const row = db.prepare(
    'SELECT id FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as { id?: number } | undefined;
  return row?.id ?? null;
}

export function upsertEmbedding(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  embedding: number[],
): void {
  const fileId = getAtlasFileId(db, workspace, filePath);
  if (fileId == null) {
    return;
  }

  db.prepare(
    'INSERT INTO atlas_embeddings (file_id, embedding) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET embedding = excluded.embedding',
  ).run(fileId, JSON.stringify(embedding));
}

export function listPendingQueue(db: AtlasDatabase, workspace: string): AtlasQueueRecord[] {
  const rows = db.prepare(
    `SELECT * FROM atlas_reextract_queue
     WHERE workspace = ? AND status = 'pending'
     ORDER BY queued_at ASC, id ASC`,
  ).all(workspace) as Record<string, unknown>[];
  return rows.map(mapQueueRecord);
}

export function upsertFileRecord(db: AtlasDatabase, record: AtlasFileUpsertInput): void {
  db.prepare(
    `INSERT INTO atlas_files (
       workspace, file_path, file_hash, cluster, loc, blurb, purpose,
       public_api, patterns, dependencies, data_flows, key_types, hazards,
      conventions, cross_refs, language, extraction_model, last_extracted, updated_at
     ) VALUES (
       @workspace, @file_path, @file_hash, @cluster, @loc, @blurb, @purpose,
       @public_api, @exports, @patterns, @dependencies, @data_flows, @key_types, @hazards,
       @conventions, @cross_refs, @language, @extraction_model, @last_extracted, CURRENT_TIMESTAMP
     )
     ON CONFLICT(workspace, file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       cluster = excluded.cluster,
       loc = excluded.loc,
       blurb = excluded.blurb,
       purpose = excluded.purpose,
       public_api = excluded.public_api,
       exports = excluded.exports,
       patterns = excluded.patterns,
       dependencies = excluded.dependencies,
       data_flows = excluded.data_flows,
       key_types = excluded.key_types,
       hazards = excluded.hazards,
       conventions = excluded.conventions,
       cross_refs = excluded.cross_refs,
       language = excluded.language,
       extraction_model = excluded.extraction_model,
       last_extracted = excluded.last_extracted,
       updated_at = CURRENT_TIMESTAMP`,
  ).run({
    workspace: record.workspace,
    file_path: record.file_path,
    file_hash: record.file_hash ?? null,
    cluster: record.cluster ?? null,
    loc: record.loc ?? 0,
    blurb: record.blurb ?? '',
    purpose: record.purpose ?? '',
    public_api: JSON.stringify(record.public_api ?? []),
    exports: JSON.stringify(record.exports ?? []),
    patterns: JSON.stringify(record.patterns ?? []),
    dependencies: JSON.stringify(record.dependencies ?? {}),
    data_flows: JSON.stringify(record.data_flows ?? []),
    key_types: JSON.stringify(record.key_types ?? []),
    hazards: JSON.stringify(record.hazards ?? []),
    conventions: JSON.stringify(record.conventions ?? []),
    cross_refs: JSON.stringify(record.cross_refs ?? {}),
    language: record.language ?? 'typescript',
    extraction_model: record.extraction_model ?? null,
    last_extracted: record.last_extracted ?? null,
  });

  const fileId = getAtlasFileId(db, record.workspace, record.file_path);
  if (fileId != null) {
    populateFts(db, fileId);
  }
}
