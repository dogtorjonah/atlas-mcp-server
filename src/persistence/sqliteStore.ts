import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { AtlasWorkerSupervisor } from './supervisor.js';
import {
  AtlasPersistenceError,
  type AtlasBackupRecord,
  type AtlasDbOperation,
  type AtlasDbOperationPayloads,
  type AtlasDbOperationResults,
  type AtlasHealthResult,
  type AtlasStoreOperationOptions,
  type AtlasStore,
  type AtlasStoreStatus,
  type AtlasWorkerEndpoint,
  type AtlasWorkerOutboundMessage,
  type AtlasWorkerRequest,
  type AtlasWorkerResponse,
  type SqliteAtlasStoreOptions,
} from './types.js';

interface ResolvedWorkerOptions {
  dbPath: string;
  migrationDir: string;
  backupDir: string;
  lockPath: string;
  lockToken: string;
  embeddingDimensions?: number;
  sqliteVecExtension?: string;
}

function workerModuleUrl(): URL {
  return new URL(
    import.meta.url.endsWith('.ts') ? './sqliteWorkerBootstrap.ts' : './sqliteWorkerBootstrap.js',
    import.meta.url,
  );
}

class WorkerThreadEndpoint implements AtlasWorkerEndpoint {
  readonly ready: Promise<AtlasStoreStatus>;

  private readonly worker: Worker;
  private readonly responseListeners = new Set<(response: AtlasWorkerResponse) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly lockPath: string;
  private readonly lockToken: string;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private readonly exitPromise: Promise<number>;
  private resolveReady!: (status: AtlasStoreStatus) => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private ownsLock = false;
  private closing = false;

  constructor(options: ResolvedWorkerOptions, startupTimeoutMs: number) {
    this.lockPath = options.lockPath;
    this.lockToken = options.lockToken;
    this.ready = new Promise<AtlasStoreStatus>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(workerModuleUrl(), {
      workerData: options,
      execArgv: process.execArgv,
      stdout: true,
      stderr: true,
    });
    this.worker.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.worker.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.exitPromise = new Promise<number>((resolve) => {
      this.worker.once('exit', resolve);
    });
    this.worker.on('message', (message: AtlasWorkerOutboundMessage) => this.handleMessage(message));
    this.worker.on('error', (error) => this.handleFailure(error));
    this.worker.on('exit', (code) => {
      if (!this.closing && (code !== 0 || this.readySettled)) {
        this.handleFailure(new Error(`Atlas database worker exited with code ${code}.`));
      }
      if (this.ownsLock) void this.cleanupOwnedLock();
    });
    this.startupTimer = setTimeout(() => {
      if (this.readySettled) return;
      const error = new AtlasPersistenceError({
        code: 'ATLAS_WORKER_UNAVAILABLE',
        message: 'Atlas database worker did not become ready before the startup deadline.',
        retryable: true,
      });
      this.settleReady(undefined, error);
      void this.worker.terminate();
    }, Math.max(1, startupTimeoutMs));
  }

  send(request: AtlasWorkerRequest): void {
    this.worker.postMessage({ type: 'request', request });
  }

  cancel(requestId: string): void {
    this.worker.postMessage({ type: 'cancel', requestId });
  }

  onResponse(listener: (response: AtlasWorkerResponse) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exitPromise;
      return;
    }
    this.closing = true;
    clearTimeout(this.startupTimer);
    try {
      this.worker.postMessage({ type: 'close' });
    } catch {
      return;
    }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exited) await this.worker.terminate();
  }

  private handleMessage(message: AtlasWorkerOutboundMessage): void {
    if (message.type === 'ready') {
      this.ownsLock = true;
      this.settleReady(message.status);
      return;
    }
    if (message.type === 'startup-error') {
      this.settleReady(undefined, new AtlasPersistenceError(message.error));
      return;
    }
    for (const listener of this.responseListeners) listener(message.response);
  }

  private handleFailure(error: Error): void {
    if (!this.readySettled) this.settleReady(undefined, error);
    for (const listener of this.failureListeners) listener(error);
  }

  private settleReady(status?: AtlasStoreStatus, error?: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    clearTimeout(this.startupTimer);
    if (error) this.rejectReady(error);
    else this.resolveReady(status as AtlasStoreStatus);
  }

  private async cleanupOwnedLock(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: string };
      if (stored.token === this.lockToken) await rm(this.lockPath, { force: true });
    } catch {
      // The worker normally removes its own lock; this only covers abrupt exits.
    }
    this.ownsLock = false;
  }
}

export class SqliteAtlasStore implements AtlasStore {
  readonly status: AtlasStoreStatus;

  private constructor(
    status: AtlasStoreStatus,
    private readonly supervisor: AtlasWorkerSupervisor,
  ) {
    this.status = status;
  }

  static async open(options: SqliteAtlasStoreOptions): Promise<SqliteAtlasStore> {
    const dbPath = path.resolve(options.dbPath);
    const endpoint = new WorkerThreadEndpoint({
      dbPath,
      migrationDir: path.resolve(options.migrationDir),
      backupDir: path.resolve(options.backupDir ?? path.join(path.dirname(dbPath), 'backups')),
      lockPath: path.resolve(options.lockPath ?? `${dbPath}.lock`),
      lockToken: options.operationIdFactory?.() ?? randomUUID(),
      ...(options.embeddingDimensions == null ? {} : { embeddingDimensions: options.embeddingDimensions }),
      ...(options.sqliteVecExtension == null ? {} : { sqliteVecExtension: options.sqliteVecExtension }),
    }, options.startupTimeoutMs ?? 10_000);
    try {
      const status = await endpoint.ready;
      return new SqliteAtlasStore(status, new AtlasWorkerSupervisor(endpoint, options));
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }

  execute<Operation extends AtlasDbOperation>(
    operation: Operation,
    payload: AtlasDbOperationPayloads[Operation],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults[Operation]> {
    return this.supervisor.execute(operation, payload, options);
  }

  health(options?: AtlasStoreOperationOptions): Promise<AtlasHealthResult> {
    return this.execute('health', {}, options);
  }

  getFile(
    payload: AtlasDbOperationPayloads['get-file'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['get-file']> {
    return this.execute('get-file', payload, options);
  }

  listFiles(
    payload: AtlasDbOperationPayloads['list-files'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['list-files']> {
    return this.execute('list-files', payload, options);
  }

  listWorkspaces(
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['list-workspaces']> {
    return this.execute('list-workspaces', {}, options);
  }

  searchLexical(
    payload: AtlasDbOperationPayloads['search-fts'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['search-fts']> {
    return this.execute('search-fts', payload, options);
  }

  upsertFile(
    payload: AtlasDbOperationPayloads['upsert-file'],
    options?: AtlasStoreOperationOptions,
  ): Promise<null> {
    return this.execute('upsert-file', payload, options);
  }

  deleteFile(
    payload: AtlasDbOperationPayloads['delete-file'],
    options?: AtlasStoreOperationOptions,
  ): Promise<boolean> {
    return this.execute('delete-file', payload, options);
  }

  insertChangelog(
    payload: AtlasDbOperationPayloads['insert-changelog'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['insert-changelog']> {
    return this.execute('insert-changelog', payload, options);
  }

  insertSnapshot(
    payload: AtlasDbOperationPayloads['insert-snapshot'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['insert-snapshot']> {
    return this.execute('insert-snapshot', payload, options);
  }

  indexRepository(
    payload: AtlasDbOperationPayloads['index-repository'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['index-repository']> {
    return this.execute('index-repository', payload, options);
  }

  retrieve(
    payload: AtlasDbOperationPayloads['retrieve'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['retrieve']> {
    return this.execute('retrieve', payload, options);
  }

  commit(
    payload: AtlasDbOperationPayloads['commit-file'],
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasDbOperationResults['commit-file']> {
    const requestKey = payload.request.idempotencyKey;
    if (requestKey && options?.idempotencyKey && requestKey !== options.idempotencyKey) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_INVALID_REQUEST',
        message: 'Commit request and operation idempotency keys do not match.',
        retryable: false,
      }));
    }
    return this.execute('commit-file', payload, {
      ...options,
      ...(requestKey ? { idempotencyKey: requestKey } : {}),
    });
  }

  backup(
    payload: AtlasDbOperationPayloads['backup'] = {},
    options?: AtlasStoreOperationOptions,
  ): Promise<AtlasBackupRecord> {
    return this.execute('backup', payload, options);
  }

  close(): Promise<void> {
    return this.supervisor.close();
  }
}

export async function openSqliteAtlasStore(
  options: SqliteAtlasStoreOptions,
): Promise<SqliteAtlasStore> {
  return SqliteAtlasStore.open(options);
}

/** Public factory name retained by the 1.x persistence contract. */
export const createSqliteAtlasStore = openSqliteAtlasStore;
