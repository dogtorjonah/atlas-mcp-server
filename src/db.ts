import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
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
  transaction<F extends (...args: any[]) => unknown>(fn: F): any;
  close(): void;
}

export interface AtlasSearchHit {
  file: AtlasFileRecord;
  rank: number;
  score: number;
  source: 'fts' | 'vector';
}

export interface AtlasExportRow {
  file: AtlasFileRecord;
  embedding: number[] | null;
}

export interface AtlasChangelogRecord {
  id: number;
  workspace: string;
  file_path: string;
  summary: string;
  patterns_added: string[];
  patterns_removed: string[];
  hazards_added: string[];
  hazards_removed: string[];
  cluster: string | null;
  breaking_changes: boolean;
  commit_sha: string | null;
  author_instance_id: string | null;
  author_engine: string | null;
  review_entry_id: string | null;
  source: string;
  verification_status: string;
  verification_notes: string | null;
  created_at: string;
}

export interface AtlasChangelogInsertInput {
  workspace: string;
  file_path: string;
  summary: string;
  patterns_added?: string[];
  patterns_removed?: string[];
  hazards_added?: string[];
  hazards_removed?: string[];
  cluster?: string | null;
  breaking_changes?: boolean;
  commit_sha?: string | null;
  author_instance_id?: string | null;
  author_engine?: string | null;
  review_entry_id?: string | null;
  source?: string;
  verification_status?: string;
  verification_notes?: string | null;
}

export interface AtlasChangelogQuery {
  workspace: string;
  file?: string;
  file_prefix?: string;
  query?: string;
  cluster?: string;
  since?: string;
  until?: string;
  verification_status?: string;
  breaking_only?: boolean;
  limit?: number;
}

export interface AtlasChangelogSearchHit {
  record: AtlasChangelogRecord;
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

function resolveSqliteVecPath(explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') return sv.getLoadablePath();
  } catch { /* not installed */ }
  return null;
}

function loadSqliteVec(db: AtlasDatabase, extensionPath?: string): boolean {
  const vecPath = resolveSqliteVecPath(extensionPath);
  if (!vecPath) {
    console.warn('[atlas] sqlite-vec extension not found — vector search will be unavailable');
    return false;
  }

  try {
    db.loadExtension(vecPath);
    return true;
  } catch (err) {
    console.warn(`[atlas] Failed to load sqlite-vec from ${vecPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function healVec0Table(
  db: AtlasDatabase,
  tableName: 'atlas_embeddings' | 'atlas_changelog_embeddings',
  idColumn: 'file_id' | 'changelog_id',
): void {
  try {
    // Probe with a real insert + immediate delete.
    // vec0 v0.1.x requires integer primary keys as SQL literals, not bound params.
    db.prepare(`INSERT INTO ${tableName} (${idColumn}, embedding) VALUES (-1, ?)`)
      .run(JSON.stringify(new Array(1536).fill(0)));
    db.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} = -1`).run();
  } catch {
    // Probe failed — table is broken. Recreate it.
    console.warn(`[atlas] ${tableName} vec0 table is non-functional — recreating`);
    try {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
      db.exec(`CREATE VIRTUAL TABLE ${tableName} USING vec0(${idColumn} INTEGER PRIMARY KEY, embedding float[1536])`);
      console.log(`[atlas] ${tableName} vec0 table recreated successfully`);
    } catch (err) {
      console.warn(`[atlas] Failed to recreate ${tableName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function openAtlasDatabase(options: AtlasDbOptions): AtlasDatabase {
  ensureDirectory(options.dbPath);

  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const vecLoaded = loadSqliteVec(db, options.sqliteVecExtension);

  for (const migrationPath of readMigrationFiles(options.migrationDir)) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    // Run everything except vec0 statements first, then attempt vec0 separately
    const vec0Pattern = /CREATE\s+VIRTUAL\s+TABLE[^;]*USING\s+vec0\s*\([^)]*\)\s*;/gi;
    const vec0Statements = sql.match(vec0Pattern) ?? [];
    const sqlWithoutVec0 = sql.replace(vec0Pattern, '');

    db.exec(sqlWithoutVec0);

    for (const vec0Stmt of vec0Statements) {
      try {
        db.exec(vec0Stmt);
      } catch {
        console.warn('[atlas] Skipping vec0 table — sqlite-vec extension not available');
      }
    }
  }

  // If the extension loaded, verify the vec0 table is functional and heal if needed
  if (vecLoaded) {
    healVec0Table(db, 'atlas_embeddings', 'file_id');
    healVec0Table(db, 'atlas_changelog_embeddings', 'changelog_id');
  }

  return db;
}

export function deleteAtlasDatabaseFiles(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const filePath of sidecars) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export function resetAtlasDatabase(options: AtlasDbOptions, currentDb?: AtlasDatabase): AtlasDatabase {
  if (currentDb) {
    try {
      currentDb.close();
    } catch {
      // Ignore close errors during reset; the file delete below is the source of truth.
    }
  }

  deleteAtlasDatabaseFiles(options.dbPath);
  return openAtlasDatabase(options);
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

function parseEmbeddingValue(value: unknown): number[] | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'number') ? value as number[] : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'number')
        ? parsed as number[]
        : null;
    } catch {
      return null;
    }
  }

  if (Buffer.isBuffer(value)) {
    return parseEmbeddingValue(value.toString('utf8'));
  }

  return null;
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

// Common English stopwords that poison FTS5 implicit-AND queries
const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'who',
  'which', 'what', 'where', 'when', 'how', 'why', 'if', 'then', 'so',
  'no', 'not', 'all', 'each', 'every', 'any', 'some', 'such', 'only',
  'about', 'up', 'out', 'just', 'into', 'also', 'than', 'very', 'too',
]);

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prepare a user query for FTS5 MATCH.
 * Strips punctuation, removes stopwords, uses OR semantics for NL queries.
 */
export function prepareFtsQuery(raw: string): string {
  const normalized = normalizeSearchText(raw);
  const cleaned = normalized.replace(/[?!@#$%^&*(){}[\]<>:;"'`,.|\\~/+=]/g, ' ');
  const tokens = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return '';
  return tokens.join(' OR ');
}

function ftsDocumentForRecord(record: AtlasFileRecord): Record<string, string> {
  return {
    file_path: normalizeSearchText(record.file_path),
    blurb: normalizeSearchText(record.blurb),
    purpose: normalizeSearchText(record.purpose),
    public_api: normalizeSearchText(stringifyFtsValue(record.public_api)),
    patterns: normalizeSearchText(stringifyFtsValue(record.patterns)),
    hazards: normalizeSearchText(stringifyFtsValue(record.hazards)),
    cross_refs: normalizeSearchText(stringifyFtsValue(record.cross_refs ?? {})),
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

export function mapChangelogRecord(row: Record<string, unknown>): AtlasChangelogRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    summary: String(row.summary ?? ''),
    patterns_added: parseJson<string[]>(row.patterns_added, []),
    patterns_removed: parseJson<string[]>(row.patterns_removed, []),
    hazards_added: parseJson<string[]>(row.hazards_added, []),
    hazards_removed: parseJson<string[]>(row.hazards_removed, []),
    cluster: row.cluster == null ? null : String(row.cluster),
    breaking_changes: Number(row.breaking_changes ?? 0) !== 0,
    commit_sha: row.commit_sha == null ? null : String(row.commit_sha),
    author_instance_id: row.author_instance_id == null ? null : String(row.author_instance_id),
    author_engine: row.author_engine == null ? null : String(row.author_engine),
    review_entry_id: row.review_entry_id == null ? null : String(row.review_entry_id),
    source: String(row.source ?? 'agent'),
    verification_status: String(row.verification_status ?? 'pending'),
    verification_notes: row.verification_notes == null ? null : String(row.verification_notes),
    created_at: String(row.created_at ?? ''),
  };
}

export function getAtlasFile(db: AtlasDatabase, workspace: string, filePath: string): AtlasFileRecord | null {
  const row = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as Record<string, unknown> | undefined;
  return row ? mapFileRecord(row) : null;
}

export function searchAtlasFiles(db: AtlasDatabase, workspace: string, query: string, limit = 5): AtlasFileRecord[] {
  // Split into meaningful tokens with stopword removal (OR semantics across tokens)
  const tokens = normalizeSearchText(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return [];

  const conditions = tokens.map(
    () => '(file_path LIKE ? OR blurb LIKE ? OR purpose LIKE ? OR exports LIKE ? OR patterns LIKE ? OR hazards LIKE ?)',
  );
  const whereClause = conditions.join(' OR ');
  const params: (string | number)[] = [workspace];
  for (const token of tokens) {
    const like = `%${token}%`;
    params.push(like, like, like, like, like, like);
  }
  params.push(limit);

  const rows = db.prepare(
    `SELECT * FROM atlas_files
     WHERE workspace = ?
       AND (${whereClause})
     ORDER BY updated_at DESC, file_path ASC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function searchFts(db: AtlasDatabase, workspace: string, query: string, limit = 10): AtlasSearchHit[] {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    const rows = db.prepare(
      `SELECT f.*, rank
       FROM atlas_fts
       JOIN atlas_files AS f ON f.id = atlas_fts.rowid
       WHERE f.workspace = ?
         AND atlas_fts MATCH ?
       ORDER BY rank ASC, f.file_path ASC
       LIMIT ?`,
    ).all(workspace, ftsQuery, limit) as Array<Record<string, unknown> & { rank?: number }>;

    return rows.map((row, index) => ({
      file: mapFileRecord(row),
      rank: index + 1,
      score: typeof row.rank === 'number' ? row.rank : index + 1,
      source: 'fts',
    }));
  } catch (err) {
    console.warn('[atlas-core] FTS search failed for query:', JSON.stringify(ftsQuery), (err as Error).message);
    return [];
  }
}

export function searchVector(db: AtlasDatabase, workspace: string, embedding: number[], limit = 10): AtlasSearchHit[] {
  try {
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
  } catch (err) {
    console.warn('[atlas-core] vector search failed:', (err as Error).message);
    return [];
  }
}

export function searchChangelogFts(
  db: AtlasDatabase,
  workspace: string,
  query: string,
  limit = 10,
): AtlasChangelogSearchHit[] {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const rows = db.prepare(
      `SELECT c.*, rank
       FROM atlas_changelog_fts
       JOIN atlas_changelog AS c ON c.id = atlas_changelog_fts.rowid
       WHERE c.workspace = ?
         AND atlas_changelog_fts MATCH ?
       ORDER BY rank ASC, c.created_at DESC, c.id DESC
       LIMIT ?`,
    ).all(workspace, ftsQuery, limit) as Array<Record<string, unknown> & { rank?: number }>;

    return rows.map((row, index) => ({
      record: mapChangelogRecord(row),
      rank: index + 1,
      score: typeof row.rank === 'number' ? row.rank : index + 1,
      source: 'fts',
    }));
  } catch (err) {
    console.warn('[atlas-core] changelog FTS search failed for query:', JSON.stringify(ftsQuery), (err as Error).message);
    return [];
  }
}

export function searchChangelogVector(
  db: AtlasDatabase,
  workspace: string,
  embedding: number[],
  limit = 10,
): AtlasChangelogSearchHit[] {
  try {
    const rows = db.prepare(
      `SELECT c.*, distance
       FROM atlas_changelog_embeddings
       JOIN atlas_changelog AS c ON c.id = atlas_changelog_embeddings.changelog_id
       WHERE c.workspace = ?
         AND embedding MATCH ?
         AND k = ?
       ORDER BY distance ASC, c.created_at DESC, c.id DESC
       LIMIT ?`,
    ).all(workspace, JSON.stringify(embedding), limit, limit) as Array<Record<string, unknown> & { distance?: number }>;

    return rows.map((row, index) => ({
      record: mapChangelogRecord(row),
      rank: index + 1,
      score: typeof row.distance === 'number' ? row.distance : index + 1,
      source: 'vector',
    }));
  } catch (err) {
    console.warn('[atlas-core] changelog vector search failed:', (err as Error).message);
    return [];
  }
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

function changelogFtsDocumentForRecord(record: AtlasChangelogRecord): Record<string, string> {
  return {
    file_path: normalizeSearchText(record.file_path),
    summary: normalizeSearchText(record.summary),
    cluster: normalizeSearchText(record.cluster ?? ''),
    patterns_added: normalizeSearchText(stringifyFtsValue(record.patterns_added)),
    hazards_added: normalizeSearchText(stringifyFtsValue(record.hazards_added)),
  };
}

export function populateChangelogFts(db: AtlasDatabase, changelogId: number): void {
  const row = db.prepare('SELECT * FROM atlas_changelog WHERE id = ? LIMIT 1').get(changelogId) as Record<string, unknown> | undefined;
  if (!row) {
    return;
  }

  const record = mapChangelogRecord(row);
  const document = changelogFtsDocumentForRecord(record);

  db.prepare('DELETE FROM atlas_changelog_fts WHERE rowid = ?').run(changelogId);
  db.prepare(
    `INSERT INTO atlas_changelog_fts (
      rowid, file_path, summary, cluster, patterns_added, hazards_added
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    changelogId,
    document.file_path,
    document.summary,
    document.cluster,
    document.patterns_added,
    document.hazards_added,
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

export function insertAtlasChangelog(db: AtlasDatabase, input: AtlasChangelogInsertInput): AtlasChangelogRecord {
  const result = db.prepare(
    `INSERT INTO atlas_changelog (
      workspace, file_path, summary, patterns_added, patterns_removed,
      hazards_added, hazards_removed, cluster, breaking_changes, commit_sha,
      author_instance_id, author_engine, review_entry_id, source,
      verification_status, verification_notes
    ) VALUES (
      @workspace, @file_path, @summary, @patterns_added, @patterns_removed,
      @hazards_added, @hazards_removed, @cluster, @breaking_changes, @commit_sha,
      @author_instance_id, @author_engine, @review_entry_id, @source,
      @verification_status, @verification_notes
    )`,
  ).run({
    workspace: input.workspace,
    file_path: input.file_path,
    summary: input.summary,
    patterns_added: JSON.stringify(input.patterns_added ?? []),
    patterns_removed: JSON.stringify(input.patterns_removed ?? []),
    hazards_added: JSON.stringify(input.hazards_added ?? []),
    hazards_removed: JSON.stringify(input.hazards_removed ?? []),
    cluster: input.cluster ?? null,
    breaking_changes: input.breaking_changes ? 1 : 0,
    commit_sha: input.commit_sha ?? null,
    author_instance_id: input.author_instance_id ?? null,
    author_engine: input.author_engine ?? null,
    review_entry_id: input.review_entry_id ?? null,
    source: input.source ?? 'agent',
    verification_status: input.verification_status ?? 'pending',
    verification_notes: input.verification_notes ?? null,
  }) as { lastInsertRowid?: number | bigint };

  const insertId = result.lastInsertRowid == null ? null : Number(result.lastInsertRowid);
  if (insertId == null || !Number.isFinite(insertId)) {
    throw new Error('Failed to determine atlas_changelog insert id.');
  }

  const row = db.prepare(
    'SELECT * FROM atlas_changelog WHERE id = ? LIMIT 1',
  ).get(insertId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('Inserted atlas_changelog row could not be read back.');
  }
  return mapChangelogRecord(row);
}

export function upsertChangelogEmbedding(
  db: AtlasDatabase,
  changelogId: number,
  embedding: number[],
): void {
  try {
    db.prepare('DELETE FROM atlas_changelog_embeddings WHERE changelog_id = ?').run(changelogId);
    db.prepare(
      'INSERT INTO atlas_changelog_embeddings (changelog_id, embedding) VALUES (?, ?)',
    ).run(changelogId, JSON.stringify(embedding));
  } catch (err) {
    console.warn(`[atlas] changelog embedding write failed for changelog_id=${changelogId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function queryAtlasChangelog(db: AtlasDatabase, filters: AtlasChangelogQuery): AtlasChangelogRecord[] {
  const whereParts: string[] = ['c.workspace = ?'];
  const params: Array<string | number> = [filters.workspace];

  if (filters.file) {
    whereParts.push('c.file_path = ?');
    params.push(filters.file);
  }
  if (filters.file_prefix) {
    whereParts.push('c.file_path LIKE ?');
    params.push(`${filters.file_prefix}%`);
  }
  if (filters.cluster) {
    whereParts.push('c.cluster = ?');
    params.push(filters.cluster);
  }
  if (filters.since) {
    whereParts.push('c.created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    whereParts.push('c.created_at <= ?');
    params.push(filters.until);
  }
  if (filters.verification_status) {
    whereParts.push('c.verification_status = ?');
    params.push(filters.verification_status);
  }
  if (filters.breaking_only) {
    whereParts.push('c.breaking_changes = 1');
  }

  let fromClause = 'atlas_changelog AS c';
  if (filters.query) {
    const ftsQuery = prepareFtsQuery(filters.query);
    if (!ftsQuery) {
      return [];
    }
    fromClause = 'atlas_changelog_fts JOIN atlas_changelog AS c ON c.id = atlas_changelog_fts.rowid';
    whereParts.push('atlas_changelog_fts MATCH ?');
    params.push(ftsQuery);
  }

  const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));
  params.push(limit);

  const rows = db.prepare(
    `SELECT c.*
     FROM ${fromClause}
     WHERE ${whereParts.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(mapChangelogRecord);
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

export function getAtlasEmbedding(db: AtlasDatabase, workspace: string, filePath: string): number[] | null {
  const fileId = getAtlasFileId(db, workspace, filePath);
  if (fileId == null) return null;

  try {
    const row = db.prepare(
      `SELECT embedding
       FROM atlas_embeddings
       WHERE file_id = ${fileId}
       LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    return row ? parseEmbeddingValue(row.embedding) : null;
  } catch {
    return null;
  }
}

export function listAtlasExportRows(
  db: AtlasDatabase,
  workspace: string,
  filePaths?: string[],
): AtlasExportRow[] {
  const files = listAtlasFiles(db, workspace);
  const selected = filePaths && filePaths.length > 0
    ? new Set(filePaths)
    : null;

  return files
    .filter((file) => !selected || selected.has(file.file_path))
    .map((file) => ({
      file,
      embedding: getAtlasEmbedding(db, workspace, file.file_path),
    }));
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

export function listImports(db: AtlasDatabase, workspace: string, sourceFile: string): string[] {
  const rows = db.prepare(
    'SELECT target_file FROM import_edges WHERE workspace = ? AND source_file = ?',
  ).all(workspace, sourceFile) as Array<{ target_file: string }>;
  return rows.map((row) => row.target_file);
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

/**
 * Resume-safe Pass 0 upsert: updates ONLY structural fields (hash, cluster, loc,
 * imports/exports, language) while PRESERVING AI-generated fields (blurb, purpose,
 * patterns, hazards, conventions, cross_refs, extraction_model, last_extracted).
 *
 * For new files, inserts with empty AI fields. For existing files with AI data,
 * only the structural columns are touched.
 */
export function upsertPass0Record(db: AtlasDatabase, record: {
  workspace: string;
  file_path: string;
  file_hash: string | null;
  cluster: string | null;
  loc: number;
  exports: Array<{ name: string; type: string }>;
  dependencies: Record<string, unknown>;
  language: string;
}): void {
  db.prepare(
    `INSERT INTO atlas_files (
       workspace, file_path, file_hash, cluster, loc, blurb, purpose,
       public_api, exports, patterns, dependencies, data_flows, key_types, hazards,
       conventions, cross_refs, language, extraction_model, last_extracted, updated_at
     ) VALUES (
       @workspace, @file_path, @file_hash, @cluster, @loc, '', '',
       '[]', @exports, '[]', @dependencies, '[]', '[]', '[]',
       '[]', 'null', @language, NULL, NULL, CURRENT_TIMESTAMP
     )
     ON CONFLICT(workspace, file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       cluster = excluded.cluster,
       loc = excluded.loc,
       exports = excluded.exports,
       dependencies = excluded.dependencies,
       language = excluded.language,
       updated_at = CURRENT_TIMESTAMP`,
  ).run({
    workspace: record.workspace,
    file_path: record.file_path,
    file_hash: record.file_hash ?? null,
    cluster: record.cluster ?? null,
    loc: record.loc,
    exports: JSON.stringify(record.exports),
    dependencies: JSON.stringify(record.dependencies),
    language: record.language,
  });

  const fileId = getAtlasFileId(db, record.workspace, record.file_path);
  if (fileId != null) {
    populateFts(db, fileId);
  }
}

/**
 * Check if a file's atlas record is "complete" — has non-empty AI-generated
 * fields AND the file content hasn't changed since extraction.
 */
export function isFileComplete(db: AtlasDatabase, workspace: string, filePath: string, currentHash: string): boolean {
  const row = db.prepare(
    `SELECT file_hash, blurb, purpose, extraction_model, cross_refs
     FROM atlas_files
     WHERE workspace = ? AND file_path = ? LIMIT 1`,
  ).get(workspace, filePath) as {
    file_hash: string | null;
    blurb: string | null;
    purpose: string | null;
    extraction_model: string | null;
    cross_refs: string | null;
  } | undefined;

  if (!row) return false;
  if (row.file_hash !== currentHash) return false;
  if (!row.blurb || row.blurb.trim() === '') return false;
  if (!row.purpose || row.purpose.trim() === '') return false;
  if (!row.extraction_model || row.extraction_model === 'scaffold') return false;
  if (!row.cross_refs || row.cross_refs === 'null' || row.cross_refs === '{}') return false;
  return true;
}

/**
 * Check which phase a file has reached (for granular resume).
 * Returns the last completed phase: 'none' | 'pass05' | 'pass1' | 'embed' | 'pass2'
 *
 * Phase logic:
 *   - 'none':   no data, or file hash changed → needs full run
 *   - 'pass05': has blurb, but no real extraction (purpose empty or scaffold)
 *   - 'pass1':  has real extraction (purpose + non-scaffold model), but cross_refs
 *               are missing or have no actual symbol data → needs embed + pass2
 *   - 'pass2':  cross_refs contain real symbol data → fully complete
 */
function hasEmbedding(db: AtlasDatabase, fileId: number): boolean {
  try {
    const row = db.prepare(
      'SELECT 1 FROM atlas_embeddings_rowids WHERE id = ? LIMIT 1',
    ).get(fileId) as Record<string, unknown> | undefined;
    return row !== undefined;
  } catch {
    // vec0 backing table may not exist
    return false;
  }
}

export function getFilePhase(db: AtlasDatabase, workspace: string, filePath: string, currentHash: string): 'none' | 'pass05' | 'pass1' | 'embed' | 'pass2' {
  const row = db.prepare(
    `SELECT id, file_hash, blurb, purpose, extraction_model, cross_refs
     FROM atlas_files
     WHERE workspace = ? AND file_path = ? LIMIT 1`,
  ).get(workspace, filePath) as {
    id: number;
    file_hash: string | null;
    blurb: string | null;
    purpose: string | null;
    extraction_model: string | null;
    cross_refs: string | null;
  } | undefined;

  if (!row) return 'none';
  // If hash changed, file needs full re-processing
  if (row.file_hash !== currentHash) return 'none';
  if (!row.blurb || row.blurb.trim() === '') return 'none';
  if (!row.purpose || row.purpose.trim() === '' || row.extraction_model === 'scaffold') return 'pass05';

  // Has real extraction — at least pass1 complete.
  // Check cross_refs for actual symbol data (not just empty '{}' or 'null').
  const crossRefs = row.cross_refs;
  if (crossRefs && crossRefs !== 'null' && crossRefs !== '{}') {
    try {
      const parsed = JSON.parse(crossRefs);
      // A real cross_refs has a 'symbols' object with at least one key,
      // OR has total_exports_analyzed > 0 (meaning pass2 ran, even if no symbols found)
      if (parsed && typeof parsed === 'object' && (
        (parsed.symbols && Object.keys(parsed.symbols).length > 0) ||
        (typeof parsed.total_exports_analyzed === 'number' && parsed.total_exports_analyzed >= 0 && parsed.pass2_timestamp)
      )) {
        // Cross-refs exist, but verify embedding also exists.
        // Embed can silently fail (e.g. broken vec0 table) while pass2 succeeds,
        // leaving the file stuck without an embedding forever.
        if (!hasEmbedding(db, row.id)) {
          return 'pass1'; // re-run from embed onwards
        }
        return 'pass2';
      }
    } catch {
      // Invalid JSON — treat as incomplete
    }
  }

  return 'pass1';
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

  try {
    // vec0 virtual tables do not support ON CONFLICT / UPSERT,
    // so we delete-then-insert to achieve upsert semantics.
    // IMPORTANT: vec0 v0.1.x cannot handle bound params for the primary key column —
    // the integer must be a SQL literal.  Only the embedding vector is bound.
    db.prepare(`DELETE FROM atlas_embeddings WHERE file_id = ${fileId}`).run();
    db.prepare(
      `INSERT INTO atlas_embeddings (file_id, embedding) VALUES (${fileId}, ?)`,
    ).run(JSON.stringify(embedding));
  } catch (err) {
    // vec0 table may not exist if sqlite-vec extension isn't loaded
    console.warn(`[atlas] embedding write failed for file_id=${fileId}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
       public_api, exports, patterns, dependencies, data_flows, key_types, hazards,
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
