import type {
  AtlasChangelogInsertInput,
  AtlasChangelogRecord,
  AtlasFileSnapshot,
  AtlasFileUpsertInput,
  AtlasSearchHit,
} from '../db.js';
import type { AtlasFileRecord } from '../types.js';
import type {
  AtlasIndexRepositoryRequest,
  AtlasIndexRepositoryResult,
} from '../indexing/types.js';

export const ATLAS_WORKER_PROTOCOL_VERSION = 1 as const;

export type AtlasWorkClass = 'db-read' | 'db-write' | 'maintenance';

export type AtlasPersistenceErrorCode =
  | 'ATLAS_BACKPRESSURE'
  | 'ATLAS_CANCELLED'
  | 'ATLAS_CLOSED'
  | 'ATLAS_CONFLICT'
  | 'ATLAS_INDETERMINATE_WRITE'
  | 'ATLAS_INVALID_REQUEST'
  | 'ATLAS_PAYLOAD_TOO_LARGE'
  | 'ATLAS_RESULT_TOO_LARGE'
  | 'ATLAS_SCHEMA_CHECKSUM_MISMATCH'
  | 'ATLAS_SCHEMA_HISTORY_DIVERGED'
  | 'ATLAS_SCHEMA_NEWER'
  | 'ATLAS_SCHEMA_WRONG_DOMAIN'
  | 'ATLAS_STORE_CORRUPT'
  | 'ATLAS_STORE_LOCKED'
  | 'ATLAS_TIMEOUT'
  | 'ATLAS_WORKER_UNAVAILABLE';

export interface SerializedAtlasPersistenceError {
  code: AtlasPersistenceErrorCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export class AtlasPersistenceError extends Error {
  readonly code: AtlasPersistenceErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(input: SerializedAtlasPersistenceError) {
    super(input.message);
    this.name = 'AtlasPersistenceError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.details = input.details;
  }

  toJSON(): SerializedAtlasPersistenceError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function serializeAtlasPersistenceError(error: unknown): SerializedAtlasPersistenceError {
  if (error instanceof AtlasPersistenceError) return error.toJSON();
  return {
    code: 'ATLAS_WORKER_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export interface AtlasWorkerRequest<Payload = unknown> {
  protocolVersion: typeof ATLAS_WORKER_PROTOCOL_VERSION;
  requestId: string;
  workClass: AtlasWorkClass;
  operation: AtlasDbOperation;
  payload: Payload;
  remainingTimeMs: number | null;
  idempotencyKey?: string;
}

export type AtlasWorkerResponse<Result = unknown> =
  | { requestId: string; ok: true; result: Result }
  | { requestId: string; ok: false; error: SerializedAtlasPersistenceError };

export interface AtlasWorkerReadyMessage {
  type: 'ready';
  status: AtlasStoreStatus;
}

export interface AtlasWorkerStartupErrorMessage {
  type: 'startup-error';
  error: SerializedAtlasPersistenceError;
}

export interface AtlasWorkerResultMessage {
  type: 'response';
  response: AtlasWorkerResponse;
}

export type AtlasWorkerOutboundMessage =
  | AtlasWorkerReadyMessage
  | AtlasWorkerStartupErrorMessage
  | AtlasWorkerResultMessage;

export type AtlasWorkerInboundMessage =
  | { type: 'request'; request: AtlasWorkerRequest }
  | { type: 'cancel'; requestId: string }
  | { type: 'close' };

export interface AtlasOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface AtlasBackupRecord {
  backupId: string;
  createdAt: string;
  path: string;
  integrity: 'ok';
  migrationHead: string | null;
}

export interface AtlasStoreStatus {
  state: 'ready' | 'recovered';
  databasePath: string;
  schemaGeneration: string;
  migrationHead: string | null;
  migrationCount: number;
  lexicalSearch: 'available';
  vectorSearch: 'available' | 'unavailable';
  backup?: AtlasBackupRecord;
}

export interface AtlasHealthResult {
  integrity: 'ok';
  migrationHead: string | null;
  migrationCount: number;
  schemaGeneration: string;
}

export interface AtlasDbOperationPayloads {
  health: Record<string, never>;
  'get-file': { workspace: string; filePath: string };
  'list-files': { workspace: string };
  'search-fts': { workspace: string; query: string; limit?: number };
  'upsert-file': { workspace: string; file: AtlasFileUpsertInput };
  'delete-file': { workspace: string; filePath: string };
  'insert-changelog': { workspace: string; changelog: AtlasChangelogInsertInput };
  'insert-snapshot': {
    workspace: string;
    filePath: string;
    content: string;
    changelogId: number | null;
  };
  'index-repository': AtlasIndexRepositoryRequest;
  backup: Record<string, never>;
}

export interface AtlasDbOperationResults {
  health: AtlasHealthResult;
  'get-file': AtlasFileRecord | null;
  'list-files': AtlasFileRecord[];
  'search-fts': AtlasSearchHit[];
  'upsert-file': null;
  'delete-file': boolean;
  'insert-changelog': AtlasChangelogRecord;
  'insert-snapshot': AtlasFileSnapshot | null;
  'index-repository': AtlasIndexRepositoryResult;
  backup: AtlasBackupRecord;
}

export type AtlasDbOperation = keyof AtlasDbOperationPayloads;

export type AtlasDbReadOperation = 'health' | 'get-file' | 'list-files' | 'search-fts';
export type AtlasDbWriteOperation =
  | 'upsert-file'
  | 'delete-file'
  | 'insert-changelog'
  | 'insert-snapshot'
  | 'index-repository';

export interface AtlasStore {
  readonly status: AtlasStoreStatus;
  execute<Operation extends AtlasDbOperation>(
    operation: Operation,
    payload: AtlasDbOperationPayloads[Operation],
    options?: AtlasOperationOptions,
  ): Promise<AtlasDbOperationResults[Operation]>;
  close(): Promise<void>;
}

export interface AtlasWorkerEndpoint {
  send(request: AtlasWorkerRequest): void;
  cancel(requestId: string): void;
  onResponse(listener: (response: AtlasWorkerResponse) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface AtlasScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface AtlasWorkerSupervisorOptions {
  maxQueued?: number;
  maxInFlightReads?: number;
  maxPayloadBytes?: number;
  maxResultBytes?: number;
  requestIdFactory?: () => string;
  scheduler?: AtlasScheduler;
  shutdownGraceMs?: number;
}

export interface SqliteAtlasStoreOptions extends AtlasWorkerSupervisorOptions {
  dbPath: string;
  migrationDir: string;
  backupDir?: string;
  lockPath?: string;
  startupTimeoutMs?: number;
  now?: () => number;
  operationIdFactory?: () => string;
  embeddingDimensions?: number;
  sqliteVecExtension?: string;
}

export const ATLAS_RECOVERY_CONFIRMATION = 'RESTORE VERIFIED ATLAS BACKUP';
