import type {
  AtlasAuditData,
  AtlasAuditRequest,
  AtlasAdminData,
  AtlasAdminRequest,
  AtlasCommitData,
  AtlasCommitRequest,
  AtlasError,
  AtlasGraphData,
  AtlasGraphRequest,
  AtlasQueryData,
  AtlasQueryRequest,
  AtlasResult,
  AtlasResultMeta,
  AtlasOperationOptions,
} from '../core/types.js';
import { AtlasPersistenceError } from '../persistence/types.js';
import type { AtlasReadExecutor, AtlasReadRequest } from '../retrieval/types.js';
import type { AtlasWriteExecutor } from '../writeback/types.js';
import type { AtlasAdminExecutor } from '../admin/types.js';

export interface AtlasServiceOptions {
  workspace: string;
  sourceRoot?: string;
  indexConcurrency?: number;
  requestIdFactory?: () => string;
  closeExecutor?: boolean;
}

function platformRequestIdFactory(): (() => string) | null {
  const platformCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof platformCrypto?.randomUUID === 'function'
    ? platformCrypto.randomUUID.bind(platformCrypto)
    : null;
}

function unavailableMeta(workspace: string): AtlasResultMeta {
  return {
    workspace,
    capabilities: {
      lexical_search: 'unavailable',
      vector_search: 'unavailable',
      source_authority: 'unavailable',
      graph: 'unavailable',
      history: 'unavailable',
    },
    warnings: [],
    evidence: {
      authority: 'unknown',
      freshness: 'unknown',
      confidence: 'unknown',
      completeness: 'unknown',
    },
    extensions: [],
  };
}

function persistenceError(error: unknown): AtlasError {
  if (!(error instanceof AtlasPersistenceError)) {
    return {
      code: 'ATLAS_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
  const code = error.code === 'ATLAS_TIMEOUT' ? 'ATLAS_DEADLINE_EXCEEDED'
    : error.code === 'ATLAS_CANCELLED' ? 'ATLAS_CANCELLED'
      : error.code === 'ATLAS_BACKPRESSURE' ? 'ATLAS_BUSY'
        : error.code === 'ATLAS_STORE_LOCKED' ? 'ATLAS_STORE_LOCKED'
          : error.code === 'ATLAS_SCHEMA_NEWER' ? 'ATLAS_SCHEMA_NEWER'
            : error.code === 'ATLAS_SCHEMA_HISTORY_DIVERGED' ? 'ATLAS_SCHEMA_HISTORY_DIVERGED'
              : error.code === 'ATLAS_SCHEMA_CHECKSUM_MISMATCH' ? 'ATLAS_SCHEMA_CHECKSUM_MISMATCH'
                : error.code === 'ATLAS_SCHEMA_WRONG_DOMAIN' ? 'ATLAS_SCHEMA_WRONG_DOMAIN'
                  : error.code === 'ATLAS_STORE_CORRUPT' ? 'ATLAS_STORE_CORRUPT'
                    : error.code === 'ATLAS_INVALID_REQUEST' ? 'ATLAS_INVALID_REQUEST'
                      : error.code === 'ATLAS_CONFLICT' ? 'ATLAS_WRITE_CONFLICT'
                        : error.code === 'ATLAS_INDETERMINATE_WRITE' ? 'ATLAS_INDETERMINATE_WRITE'
                      : 'ATLAS_INTERNAL';
  return {
    code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details ? { details: JSON.parse(JSON.stringify(error.details)) } : {}),
    cause_code: error.code,
  };
}

export class AtlasService {
  private readonly workspace: string;
  private readonly requestIdFactory: () => string;
  private readonly closeExecutor: boolean;
  private readonly sourceRoot?: string;
  private readonly indexConcurrency: number;
  private closed = false;

  constructor(
    private readonly executor: AtlasReadExecutor & AtlasWriteExecutor & AtlasAdminExecutor,
    options: AtlasServiceOptions,
  ) {
    if (!options.workspace.trim()) throw new Error('AtlasService requires a workspace.');
    const requestIdFactory = options.requestIdFactory ?? platformRequestIdFactory();
    if (!requestIdFactory) throw new Error('AtlasService requires requestIdFactory when crypto.randomUUID is unavailable.');
    this.workspace = options.workspace;
    this.requestIdFactory = requestIdFactory;
    this.closeExecutor = options.closeExecutor ?? true;
    this.sourceRoot = options.sourceRoot;
    this.indexConcurrency = Math.max(1, Math.min(Math.trunc(options.indexConcurrency ?? 4), 32));
  }

  query(request: AtlasQueryRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasQueryData>> {
    return this.execute({ family: 'query', request: { ...request, workspace: request.workspace ?? this.workspace } }, options) as Promise<AtlasResult<AtlasQueryData>>;
  }

  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasGraphData>> {
    return this.execute({ family: 'graph', request: { ...request, workspace: request.workspace ?? this.workspace } }, options) as Promise<AtlasResult<AtlasGraphData>>;
  }

  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions): Promise<AtlasResult<AtlasAuditData>> {
    return this.execute({ family: 'audit', request: { ...request, workspace: request.workspace ?? this.workspace } }, options) as Promise<AtlasResult<AtlasAuditData>>;
  }

  async commit(
    request: AtlasCommitRequest,
    options?: AtlasOperationOptions,
  ): Promise<AtlasResult<AtlasCommitData>> {
    const suppliedRequestId = options?.requestId;
    const suppliedRequestIdValid = typeof suppliedRequestId === 'string'
      && suppliedRequestId.length > 0
      && suppliedRequestId.length <= 8_192;
    const requestId = suppliedRequestIdValid ? suppliedRequestId : this.requestIdFactory();
    const meta: AtlasResultMeta = {
      workspace: this.workspace,
      capabilities: {
        lexical_search: 'available',
        vector_search: 'unavailable',
        source_authority: 'available',
        graph: 'available',
        history: 'available',
        writeback: 'available',
      },
      warnings: [],
      evidence: {
        authority: 'atlas_store',
        freshness: 'current',
        confidence: 'high',
        completeness: 'complete',
      },
      extensions: [],
    };
    if (suppliedRequestId != null && !suppliedRequestIdValid) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: { code: 'ATLAS_INVALID_REQUEST', message: 'requestId must be a non-empty string of at most 8,192 characters.', retryable: false },
        meta,
      };
    }
    if (this.closed) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: { code: 'ATLAS_INTERNAL', message: 'Atlas service is closed.', retryable: false },
        meta,
      };
    }
    try {
      const data = await this.executor.commit(
        { workspace: this.workspace, request },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
          ...(options?.requestId == null ? {} : { requestId: options.requestId }),
          ...(request.idempotencyKey == null ? {} : { idempotencyKey: request.idempotencyKey }),
        },
      );
      return { protocol_version: '1', ok: true, request_id: requestId, data, meta };
    } catch (error) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: persistenceError(error),
        meta: {
          ...meta,
          evidence: {
            authority: 'atlas_store',
            freshness: 'unknown',
            confidence: 'unknown',
            completeness: 'unknown',
          },
        },
      };
    }
  }

  async admin(
    request: AtlasAdminRequest,
    options?: AtlasOperationOptions,
  ): Promise<AtlasResult<AtlasAdminData>> {
    const suppliedRequestId = options?.requestId;
    const suppliedRequestIdValid = typeof suppliedRequestId === 'string'
      && suppliedRequestId.length > 0
      && suppliedRequestId.length <= 8_192;
    const requestId = suppliedRequestIdValid ? suppliedRequestId : this.requestIdFactory();
    const meta: AtlasResultMeta = {
      workspace: this.workspace,
      capabilities: {
        lexical_search: 'available',
        vector_search: 'unavailable',
        source_authority: this.sourceRoot ? 'available' : 'unavailable',
        graph: 'available',
        history: 'available',
        writeback: 'available',
        administration: 'available',
      },
      warnings: [],
      evidence: { authority: 'atlas_store', freshness: 'current', confidence: 'high', completeness: 'complete' },
      extensions: [],
    };
    const failure = (error: AtlasError): AtlasResult<AtlasAdminData> => ({
      protocol_version: '1', ok: false, request_id: requestId, error, meta,
    });
    if (suppliedRequestId != null && !suppliedRequestIdValid) {
      return failure({ code: 'ATLAS_INVALID_REQUEST', message: 'requestId must be a non-empty string of at most 8,192 characters.', retryable: false });
    }
    if (this.closed) return failure({ code: 'ATLAS_INTERNAL', message: 'Atlas service is closed.', retryable: false });
    if (!request || typeof request !== 'object' || typeof request.action !== 'string') {
      return failure({ code: 'ATLAS_INVALID_REQUEST', message: 'Admin request must include an action.', retryable: false });
    }
    try {
      let data: AtlasAdminData;
      switch (request.action) {
        case 'index': {
          if (!this.sourceRoot) return failure({ code: 'ATLAS_CAPABILITY_UNAVAILABLE', message: 'Repository indexing requires a configured sourceRoot.', retryable: false });
          if (request.phase === 'embeddings') return failure({ code: 'ATLAS_CAPABILITY_UNAVAILABLE', message: 'Semantic embeddings are not configured.', retryable: false });
          const result = await this.executor.indexRepository({
            workspace: this.workspace,
            sourceRoot: this.sourceRoot,
            mode: request.force ? 'repair' : request.full ? 'full' : 'incremental',
            concurrency: this.indexConcurrency,
            ...(request.paths == null ? {} : { paths: [...request.paths] }),
            ...(request.phase === 'crossref' ? { phase: 'crossref' as const } : {}),
          }, options);
          data = {
            action: 'index',
            mode: result.mode,
            filesProcessed: result.filesProcessed,
            filesFailed: result.filesFailed,
            filesSkipped: result.filesSkipped,
            changedFiles: result.freshness.changedFileCount,
            deletedFiles: result.freshness.deletedFileCount,
            invalidatedFiles: result.freshness.invalidatedFileCount,
            complete: result.freshness.complete,
          };
          break;
        }
        case 'migrate': {
          const health = await this.executor.health(options);
          if (request.targetGeneration != null
            && request.targetGeneration !== health.schemaGeneration
            && request.targetGeneration !== health.migrationHead) {
            return failure({ code: 'ATLAS_SCHEMA_HISTORY_DIVERGED', message: 'Requested migration target does not match this store generation.', retryable: false });
          }
          const backup = request.backup && !request.dryRun
            ? await this.executor.backup({ label: 'pre-migrate', protected: true }, options)
            : undefined;
          data = {
            action: 'migrate',
            dryRun: request.dryRun ?? false,
            schemaGeneration: health.schemaGeneration,
            migrationHead: health.migrationHead,
            applied: [],
            ...(backup ? { backupId: backup.backupId } : {}),
          };
          break;
        }
        case 'backup': {
          const backup = await this.executor.backup({ label: request.label, protected: request.protected }, options);
          data = {
            action: 'backup',
            backupId: backup.backupId,
            createdAt: backup.createdAt,
            integrity: backup.integrity,
            migrationHead: backup.migrationHead,
            protected: backup.protected,
            ...(backup.label ? { label: backup.label } : {}),
          };
          break;
        }
        case 'doctor': {
          const supported = new Set(['integrity', 'schema', 'lexical', 'vector']);
          const requested = request.checks == null ? ['integrity', 'schema', 'lexical'] : [...request.checks];
          const unknown = requested.filter((check) => !supported.has(check));
          if (unknown.length > 0) return failure({ code: 'ATLAS_INVALID_REQUEST', message: `Unknown doctor checks: ${unknown.join(', ')}.`, retryable: false });
          if (request.includeOptional && !requested.includes('vector')) requested.push('vector');
          const health = await this.executor.health(options);
          const checks = requested.map((name): { name: string; status: 'pass' | 'warn'; message: string } => {
            if (name === 'vector') return { name, status: 'warn', message: 'Vector search is unavailable.' };
            if (name === 'integrity') return { name, status: 'pass', message: `SQLite integrity: ${health.integrity}.` };
            if (name === 'schema') return { name, status: 'pass', message: `Schema head: ${health.migrationHead ?? 'none'}.` };
            return { name, status: 'pass', message: 'Lexical search is available.' };
          });
          data = {
            action: 'doctor',
            healthy: checks.every((check) => check.status === 'pass' || check.name === 'vector'),
            schemaGeneration: health.schemaGeneration,
            migrationHead: health.migrationHead,
            checks,
          };
          break;
        }
        case 'workspace_list':
          data = { action: 'workspace_list', workspaces: await this.executor.listWorkspaces(options) };
          break;
        default:
          return failure({ code: 'ATLAS_UNSUPPORTED_ACTION', message: 'Admin action is not supported.', retryable: false });
      }
      return { protocol_version: '1', ok: true, request_id: requestId, data, meta };
    } catch (error) {
      return failure(persistenceError(error));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeExecutor) await this.executor.close?.();
  }

  private async execute(request: AtlasReadRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>> {
    const suppliedRequestId = options?.requestId;
    const suppliedRequestIdValid = typeof suppliedRequestId === 'string'
      && suppliedRequestId.length > 0
      && suppliedRequestId.length <= 8_192;
    const requestId = suppliedRequestIdValid
      ? suppliedRequestId
      : this.requestIdFactory();
    const workspace = request.request.workspace ?? this.workspace;
    if (suppliedRequestId != null && !suppliedRequestIdValid) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: { code: 'ATLAS_INVALID_REQUEST', message: 'requestId must be a non-empty string of at most 8,192 characters.', retryable: false },
        meta: unavailableMeta(workspace),
      };
    }
    if (this.closed) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: { code: 'ATLAS_INTERNAL', message: 'Atlas read service is closed.', retryable: false },
        meta: unavailableMeta(workspace),
      };
    }
    try {
      const outcome = await this.executor.retrieve(request, options);
      if (!outcome.ok) {
        return {
          protocol_version: '1',
          ok: false,
          request_id: requestId,
          error: outcome.error,
          meta: outcome.meta,
        };
      }
      return {
        protocol_version: '1',
        ok: true,
        request_id: requestId,
        data: outcome.data,
        meta: outcome.meta,
      };
    } catch (error) {
      return {
        protocol_version: '1',
        ok: false,
        request_id: requestId,
        error: persistenceError(error),
        meta: unavailableMeta(workspace),
      };
    }
  }
}

export function createAtlasService(
  executor: AtlasReadExecutor & AtlasWriteExecutor & AtlasAdminExecutor,
  options: AtlasServiceOptions,
): AtlasService {
  return new AtlasService(executor, options);
}
