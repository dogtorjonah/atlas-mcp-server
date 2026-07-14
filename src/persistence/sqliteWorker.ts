import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import {
  closeAtlasDatabase,
  deleteAtlasFile,
  getAtlasFile,
  insertAtlasChangelog,
  insertSnapshot,
  listAtlasFiles,
  openAtlasDatabase,
  searchFts,
  upsertFileRecord,
  type AtlasDatabase,
} from '../db.js';
import { canonicalizeWorkspaceName } from '../core/paths.js';
import { runRuntimeReindex } from '../pipeline/index.js';
import {
  ATLAS_WORKER_PROTOCOL_VERSION,
  AtlasPersistenceError,
  serializeAtlasPersistenceError,
  type AtlasBackupRecord,
  type AtlasDbOperation,
  type AtlasDbOperationPayloads,
  type AtlasDbOperationResults,
  type AtlasStoreStatus,
  type AtlasWorkerInboundMessage,
  type AtlasWorkerRequest,
  type SqliteAtlasStoreOptions,
} from './types.js';

const STORE_DOMAIN = '@voxxo/atlas';
const SCHEMA_GENERATION = 'atlas-public-1';

interface WorkerOptions {
  dbPath: string;
  migrationDir: string;
  backupDir: string;
  lockPath: string;
  lockToken: string;
  embeddingDimensions?: number;
  sqliteVecExtension?: string;
}

interface MigrationManifestEntry {
  filename: string;
  checksum: string;
}

const options = workerData as WorkerOptions;
if (!parentPort) throw new Error('Atlas SQLite worker requires a parent port.');

let database: AtlasDatabase | null = null;
let status: AtlasStoreStatus | null = null;
let ownsLock = false;
let closing = false;
let stopped = false;
let requestChain: Promise<void> = Promise.resolve();

function persistenceError(
  code: ConstructorParameters<typeof AtlasPersistenceError>[0]['code'],
  message: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): AtlasPersistenceError {
  return new AtlasPersistenceError({ code, message, retryable, ...(details ? { details } : {}) });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function checksum(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readMigrationManifest(): MigrationManifestEntry[] {
  if (!fs.existsSync(options.migrationDir)) {
    throw persistenceError(
      'ATLAS_SCHEMA_HISTORY_DIVERGED',
      'The configured migration directory does not exist.',
      false,
    );
  }
  return fs.readdirSync(options.migrationDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      checksum: checksum(fs.readFileSync(path.join(options.migrationDir, filename), 'utf8')),
    }));
}

function readIntegrity(db: AtlasDatabase): 'ok' | string {
  const rows = db.pragma('integrity_check') as Array<Record<string, unknown>>;
  const value = rows[0]?.integrity_check;
  return value === 'ok' ? 'ok' : String(value ?? 'unknown integrity failure');
}

function acquireLock(): void {
  fs.mkdirSync(path.dirname(options.lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, token: options.lockToken });
  const tryCreate = () => {
    const descriptor = fs.openSync(options.lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, payload, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
    ownsLock = true;
  };

  try {
    tryCreate();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  try {
    const existing = JSON.parse(fs.readFileSync(options.lockPath, 'utf8')) as { pid?: number };
    if (typeof existing.pid === 'number') process.kill(existing.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || error instanceof SyntaxError) {
      fs.rmSync(options.lockPath, { force: true });
      tryCreate();
      return;
    }
  }

  throw persistenceError(
    'ATLAS_STORE_LOCKED',
    'Another Atlas store owns the database writer lock.',
    true,
    { lockFile: path.basename(options.lockPath) },
  );
}

function releaseLock(): void {
  if (!ownsLock) return;
  try {
    const existing = JSON.parse(fs.readFileSync(options.lockPath, 'utf8')) as { token?: string };
    if (existing.token === options.lockToken) fs.rmSync(options.lockPath, { force: true });
  } catch {
    // Lock cleanup is best effort; the next process can reclaim a dead-owner lock.
  }
  ownsLock = false;
}

function verifyAndRecordMigrations(db: AtlasDatabase): MigrationManifestEntry[] {
  const manifest = readMigrationManifest();
  const expected = new Map(manifest.map((entry) => [entry.filename, entry]));
  const rows = db.prepare(
    'SELECT filename, checksum FROM atlas_schema_migrations ORDER BY filename ASC',
  ).all() as Array<{ filename: string; checksum: string | null }>;

  for (const row of rows) {
    const entry = expected.get(row.filename);
    if (!entry) {
      const code = row.filename > (manifest.at(-1)?.filename ?? '')
        ? 'ATLAS_SCHEMA_NEWER'
        : 'ATLAS_SCHEMA_HISTORY_DIVERGED';
      throw persistenceError(
        code,
        `The database records unknown migration ${row.filename}.`,
        false,
        { migration: row.filename },
      );
    }
    if (row.checksum && row.checksum !== entry.checksum) {
      throw persistenceError(
        'ATLAS_SCHEMA_CHECKSUM_MISMATCH',
        `Migration checksum mismatch for ${row.filename}.`,
        false,
        { migration: row.filename, expected: entry.checksum, actual: row.checksum },
      );
    }
  }

  const applied = new Set(rows.map((row) => row.filename));
  const missing = manifest.filter((entry) => !applied.has(entry.filename));
  if (missing.length > 0) {
    throw persistenceError(
      'ATLAS_SCHEMA_HISTORY_DIVERGED',
      'The database did not reach the packaged migration head.',
      false,
      { missing: missing.map((entry) => entry.filename) },
    );
  }

  const backfill = db.transaction(() => {
    const statement = db.prepare(
      'UPDATE atlas_schema_migrations SET checksum = ? WHERE filename = ? AND checksum IS NULL',
    );
    for (const entry of manifest) statement.run(entry.checksum, entry.filename);
  });
  backfill();
  return manifest;
}

function metadataValue(db: AtlasDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM atlas_store_metadata WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function verifyStoreIdentity(db: AtlasDatabase): void {
  const domain = metadataValue(db, 'store_domain');
  if (domain && domain !== STORE_DOMAIN) {
    throw persistenceError(
      'ATLAS_SCHEMA_WRONG_DOMAIN',
      `Database belongs to ${domain}, not ${STORE_DOMAIN}.`,
      false,
      { detectedDomain: domain, expectedDomain: STORE_DOMAIN },
    );
  }
  const generation = metadataValue(db, 'schema_generation');
  if (generation && generation !== SCHEMA_GENERATION) {
    throw persistenceError(
      'ATLAS_SCHEMA_HISTORY_DIVERGED',
      `Unsupported schema generation ${generation}.`,
      false,
      { detectedGeneration: generation, supportedGeneration: SCHEMA_GENERATION },
    );
  }
  const insert = db.prepare('INSERT OR IGNORE INTO atlas_store_metadata (key, value) VALUES (?, ?)');
  insert.run('store_domain', STORE_DOMAIN);
  insert.run('schema_generation', SCHEMA_GENERATION);
  insert.run('store_id', randomUUID());
}

function openAndVerify(state: AtlasStoreStatus['state']): AtlasStoreStatus {
  database = openAtlasDatabase({
    dbPath: options.dbPath,
    migrationDir: options.migrationDir,
    ...(options.embeddingDimensions == null ? {} : { embeddingDimensions: options.embeddingDimensions }),
    ...(options.sqliteVecExtension == null ? {} : { sqliteVecExtension: options.sqliteVecExtension }),
  });
  const integrity = readIntegrity(database);
  if (integrity !== 'ok') {
    throw persistenceError('ATLAS_STORE_CORRUPT', `Atlas integrity check failed: ${integrity}`, false);
  }
  const manifest = verifyAndRecordMigrations(database);
  verifyStoreIdentity(database);
  const vectorTable = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE name = 'atlas_embeddings' LIMIT 1",
  ).get() as { present: number } | undefined;
  return {
    state,
    databasePath: path.resolve(options.dbPath),
    schemaGeneration: SCHEMA_GENERATION,
    migrationHead: manifest.at(-1)?.filename ?? null,
    migrationCount: manifest.length,
    lexicalSearch: 'available',
    vectorSearch: vectorTable ? 'available' : 'unavailable',
  };
}

function verifyBackup(backupPath: string): boolean {
  let backup: AtlasDatabase | null = null;
  try {
    backup = new Database(backupPath, { readonly: true });
    const rows = backup.pragma('integrity_check') as Array<Record<string, unknown>>;
    return rows.length === 1 && rows[0]?.integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    try { backup?.close(); } catch { /* already closed */ }
  }
}

function createBackup(): AtlasBackupRecord {
  if (!database || !status) throw persistenceError('ATLAS_WORKER_UNAVAILABLE', 'Store is not ready.', true);
  fs.mkdirSync(options.backupDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const backupId = `${path.basename(options.dbPath, path.extname(options.dbPath))}_${stamp}_${randomUUID()}.sqlite`;
  const backupPath = path.join(options.backupDir, backupId);
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  if (!verifyBackup(backupPath)) {
    fs.rmSync(backupPath, { force: true });
    throw persistenceError('ATLAS_STORE_CORRUPT', 'The new Atlas backup failed integrity verification.', false);
  }
  const prefix = `${path.basename(options.dbPath, path.extname(options.dbPath))}_`;
  const backups = fs.readdirSync(options.backupDir)
    .filter((filename) => filename.startsWith(prefix) && filename.endsWith('.sqlite'))
    .sort()
    .reverse();
  for (const expired of backups.slice(5)) {
    fs.rmSync(path.join(options.backupDir, expired), { force: true });
  }
  return {
    backupId,
    createdAt,
    path: backupPath,
    integrity: 'ok',
    migrationHead: status.migrationHead,
  };
}

function corruptionLike(error: unknown): boolean {
  if (error instanceof AtlasPersistenceError) return error.code === 'ATLAS_STORE_CORRUPT';
  return /not a database|database disk image is malformed|database corruption|file is encrypted/i
    .test(error instanceof Error ? error.message : String(error));
}

function recoverLatestBackup(): AtlasBackupRecord | null {
  if (!fs.existsSync(options.backupDir)) return null;
  const prefix = `${path.basename(options.dbPath, path.extname(options.dbPath))}_`;
  const candidates = fs.readdirSync(options.backupDir)
    .filter((filename) => filename.startsWith(prefix) && filename.endsWith('.sqlite'))
    .sort()
    .reverse();
  for (const filename of candidates) {
    const backupPath = path.join(options.backupDir, filename);
    if (!verifyBackup(backupPath)) continue;
    const temporaryPath = `${options.dbPath}.recovery-${options.lockToken}.tmp`;
    const quarantinePath = `${options.dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    fs.copyFileSync(backupPath, temporaryPath);
    if (!verifyBackup(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
      continue;
    }
    for (const sidecar of [`${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      fs.rmSync(sidecar, { force: true });
    }
    let quarantined = false;
    try {
      if (fs.existsSync(options.dbPath)) {
        fs.renameSync(options.dbPath, quarantinePath);
        quarantined = true;
      }
      fs.renameSync(temporaryPath, options.dbPath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      if (quarantined && !fs.existsSync(options.dbPath)) fs.renameSync(quarantinePath, options.dbPath);
      throw error;
    }
    return {
      backupId: filename,
      createdAt: fs.statSync(backupPath).mtime.toISOString(),
      path: backupPath,
      integrity: 'ok',
      migrationHead: null,
    };
  }
  return null;
}

function executeOperation<Operation extends AtlasDbOperation>(
  operation: Operation,
  payload: AtlasDbOperationPayloads[Operation],
): AtlasDbOperationResults[Operation] {
  if (!database || !status) throw persistenceError('ATLAS_WORKER_UNAVAILABLE', 'Store is not ready.', true);
  switch (operation) {
    case 'health': {
      const integrity = readIntegrity(database);
      if (integrity !== 'ok') throw persistenceError('ATLAS_STORE_CORRUPT', integrity, false);
      return {
        integrity: 'ok',
        migrationHead: status.migrationHead,
        migrationCount: status.migrationCount,
        schemaGeneration: status.schemaGeneration,
      } as AtlasDbOperationResults[Operation];
    }
    case 'get-file': {
      const input = payload as AtlasDbOperationPayloads['get-file'];
      return getAtlasFile(database, input.workspace, input.filePath) as AtlasDbOperationResults[Operation];
    }
    case 'list-files': {
      const input = payload as AtlasDbOperationPayloads['list-files'];
      return listAtlasFiles(database, input.workspace) as AtlasDbOperationResults[Operation];
    }
    case 'search-fts': {
      const input = payload as AtlasDbOperationPayloads['search-fts'];
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
      return searchFts(database, input.workspace, input.query, limit) as AtlasDbOperationResults[Operation];
    }
    case 'upsert-file': {
      const input = payload as AtlasDbOperationPayloads['upsert-file'];
      if (input.file.workspace !== input.workspace) {
        throw persistenceError('ATLAS_INVALID_REQUEST', 'File workspace does not match the command workspace.', false);
      }
      upsertFileRecord(database, input.file);
      return null as AtlasDbOperationResults[Operation];
    }
    case 'delete-file': {
      const input = payload as AtlasDbOperationPayloads['delete-file'];
      return deleteAtlasFile(database, input.workspace, input.filePath) as AtlasDbOperationResults[Operation];
    }
    case 'insert-changelog': {
      const input = payload as AtlasDbOperationPayloads['insert-changelog'];
      if (input.changelog.workspace !== input.workspace) {
        throw persistenceError('ATLAS_INVALID_REQUEST', 'Changelog workspace does not match the command workspace.', false);
      }
      return insertAtlasChangelog(database, input.changelog) as AtlasDbOperationResults[Operation];
    }
    case 'insert-snapshot': {
      const input = payload as AtlasDbOperationPayloads['insert-snapshot'];
      return insertSnapshot(
        database,
        input.filePath,
        input.workspace,
        input.content,
        input.changelogId,
      ) as AtlasDbOperationResults[Operation];
    }
    case 'index-repository':
      throw persistenceError(
        'ATLAS_INVALID_REQUEST',
        'Repository indexing requires the asynchronous worker dispatch path.',
        false,
      );
    case 'backup':
      return createBackup() as AtlasDbOperationResults[Operation];
  }
}

function executeIdempotently<Operation extends AtlasDbOperation>(
  request: AtlasWorkerRequest<AtlasDbOperationPayloads[Operation]>,
): AtlasDbOperationResults[Operation] {
  if (!database || !request.idempotencyKey || request.workClass !== 'db-write') {
    return executeOperation(request.operation as Operation, request.payload);
  }
  const payloadHash = checksum(canonicalJson(request.payload));
  const existing = database.prepare(
    'SELECT operation, payload_hash, result_json FROM atlas_operation_idempotency WHERE idempotency_key = ?',
  ).get(request.idempotencyKey) as
    | { operation: string; payload_hash: string; result_json: string }
    | undefined;
  if (existing) {
    if (existing.operation !== request.operation || existing.payload_hash !== payloadHash) {
      throw persistenceError(
        'ATLAS_CONFLICT',
        'Idempotency key was already used with a different operation or payload.',
        false,
        { idempotencyKey: request.idempotencyKey },
      );
    }
    return JSON.parse(existing.result_json) as AtlasDbOperationResults[Operation];
  }

  const transaction = database.transaction(() => {
    const result = executeOperation(request.operation as Operation, request.payload);
    database?.prepare(
      `INSERT INTO atlas_operation_idempotency
       (idempotency_key, operation, payload_hash, result_json) VALUES (?, ?, ?, ?)`,
    ).run(request.idempotencyKey, request.operation, payloadHash, JSON.stringify(result));
    return result;
  });
  return transaction() as AtlasDbOperationResults[Operation];
}

function normalizeOperationError(error: unknown): AtlasPersistenceError {
  if (error instanceof AtlasPersistenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) {
    return persistenceError('ATLAS_STORE_LOCKED', message, true);
  }
  if (corruptionLike(error)) return persistenceError('ATLAS_STORE_CORRUPT', message, false);
  if (/constraint|unique/i.test(message)) return persistenceError('ATLAS_CONFLICT', message, false);
  return persistenceError('ATLAS_INVALID_REQUEST', message, false);
}

function respond(requestId: string, result: unknown): void {
  parentPort?.postMessage({ type: 'response', response: { requestId, ok: true, result } });
}

function reject(requestId: string, error: unknown): void {
  parentPort?.postMessage({
    type: 'response',
    response: { requestId, ok: false, error: serializeAtlasPersistenceError(normalizeOperationError(error)) },
  });
}

async function executeIndexRepository(
  request: AtlasWorkerRequest<AtlasDbOperationPayloads['index-repository']>,
): Promise<AtlasDbOperationResults['index-repository']> {
  if (!database) throw persistenceError('ATLAS_WORKER_UNAVAILABLE', 'Store is not ready.', true);
  if (request.idempotencyKey) {
    throw persistenceError(
      'ATLAS_INVALID_REQUEST',
      'Repository indexing is convergence-idempotent and does not accept a command idempotency key.',
      false,
    );
  }
  const input: unknown = request.payload;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw persistenceError(
      'ATLAS_INVALID_REQUEST',
      'Repository indexing requires an object payload.',
      false,
    );
  }
  const value = input as AtlasDbOperationPayloads['index-repository'];
  const workspaceInput = typeof value.workspace === 'string' ? value.workspace : '';
  const canonicalWorkspace = canonicalizeWorkspaceName(workspaceInput);
  const sourceRoot = typeof value.sourceRoot === 'string' ? value.sourceRoot.trim() : '';
  if (!canonicalWorkspace.ok || !sourceRoot || sourceRoot.length > 4_096) {
    throw persistenceError(
      'ATLAS_INVALID_REQUEST',
      'Repository indexing requires bounded non-empty workspace and sourceRoot values.',
      false,
    );
  }
  const workspace = canonicalWorkspace.name;
  if (value.mode != null && !['full', 'incremental', 'repair'].includes(value.mode)) {
    throw persistenceError('ATLAS_INVALID_REQUEST', 'Index mode is not supported.', false);
  }
  const requestedConcurrency = value.concurrency ?? 4;
  if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1) {
    throw persistenceError('ATLAS_INVALID_REQUEST', 'Index concurrency must be a positive number.', false);
  }
  const concurrency = Math.min(32, Math.trunc(requestedConcurrency));
  let now: (() => Date) | undefined;
  if (value.now != null) {
    if (typeof value.now !== 'string') {
      throw persistenceError('ATLAS_INVALID_REQUEST', 'Index clock must be an ISO timestamp.', false);
    }
    const timestamp = Date.parse(value.now);
    if (!Number.isFinite(timestamp)) {
      throw persistenceError('ATLAS_INVALID_REQUEST', 'Index clock must be a valid ISO timestamp.', false);
    }
    now = () => new Date(timestamp);
  }
  return runRuntimeReindex({
    db: database,
    workspace,
    rootDir: sourceRoot,
    concurrency,
    mode: value.mode ?? 'incremental',
    ...(now == null ? {} : { now }),
  });
}

async function handleRequest(request: AtlasWorkerRequest): Promise<void> {
  if (closing) {
    reject(request.requestId, persistenceError('ATLAS_CLOSED', 'Atlas worker is closing.', false));
    return;
  }
  if (request.protocolVersion !== ATLAS_WORKER_PROTOCOL_VERSION) {
    reject(request.requestId, persistenceError('ATLAS_INVALID_REQUEST', 'Unsupported worker protocol version.', false));
    return;
  }
  if (request.remainingTimeMs != null && request.remainingTimeMs <= 0) {
    reject(request.requestId, persistenceError('ATLAS_TIMEOUT', 'Operation expired before worker dispatch.', true));
    return;
  }
  try {
    if (request.operation === 'index-repository') {
      respond(
        request.requestId,
        await executeIndexRepository(
          request as AtlasWorkerRequest<AtlasDbOperationPayloads['index-repository']>,
        ),
      );
      return;
    }
    respond(
      request.requestId,
      executeIdempotently(
        request as AtlasWorkerRequest<AtlasDbOperationPayloads[AtlasDbOperation]>,
      ),
    );
  } catch (error) {
    reject(request.requestId, error);
  }
}

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  closing = true;
  if (database) closeAtlasDatabase(options.dbPath);
  database = null;
  releaseLock();
  parentPort?.close();
}

function handleMessage(message: AtlasWorkerInboundMessage): void {
  if (message.type === 'request') {
    requestChain = requestChain.then(() => handleRequest(message.request));
  } else if (message.type === 'close') {
    closing = true;
    void requestChain.finally(shutdown);
  }
  // A synchronous SQLite call cannot be interrupted safely. The supervisor
  // discards late read results and reports dispatched writes as indeterminate.
}

function start(): void {
  acquireLock();
  let recoveredFrom: AtlasBackupRecord | null = null;
  try {
    status = openAndVerify('ready');
  } catch (error) {
    if (!corruptionLike(error)) throw error;
    closeAtlasDatabase(options.dbPath);
    database = null;
    recoveredFrom = recoverLatestBackup();
    if (!recoveredFrom) {
      throw persistenceError(
        'ATLAS_STORE_CORRUPT',
        'Atlas database is corrupt and no verified backup is available.',
        false,
      );
    }
    status = openAndVerify('recovered');
    recoveredFrom.migrationHead = status.migrationHead;
    status = { ...status, backup: recoveredFrom };
  }
  parentPort?.on('message', handleMessage);
  parentPort?.postMessage({ type: 'ready', status });
}

try {
  start();
} catch (error) {
  if (database) closeAtlasDatabase(options.dbPath);
  database = null;
  releaseLock();
  parentPort.postMessage({ type: 'startup-error', error: serializeAtlasPersistenceError(normalizeOperationError(error)) });
  parentPort.close();
}

process.once('exit', releaseLock);
