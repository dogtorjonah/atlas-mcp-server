import { randomUUID } from 'node:crypto';

import {
  ATLAS_WORKER_PROTOCOL_VERSION,
  AtlasPersistenceError,
  type AtlasDbOperation,
  type AtlasDbOperationPayloads,
  type AtlasDbOperationResults,
  type AtlasDbReadOperation,
  type AtlasOperationOptions,
  type AtlasScheduler,
  type AtlasWorkerEndpoint,
  type AtlasWorkerRequest,
  type AtlasWorkerResponse,
  type AtlasWorkerSupervisorOptions,
  type AtlasWorkClass,
} from './types.js';

interface PendingRequest<Operation extends AtlasDbOperation = AtlasDbOperation> {
  request: AtlasWorkerRequest<AtlasDbOperationPayloads[Operation]>;
  operation: Operation;
  deadline: number | null;
  resolve: (value: AtlasDbOperationResults[Operation]) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  timer?: unknown;
  state: 'queued' | 'dispatched' | 'settled';
}

const readOperations = new Set<AtlasDbOperation>([
  'health',
  'get-file',
  'list-files',
  'search-fts',
] satisfies AtlasDbReadOperation[]);

const maintenanceOperations = new Set<AtlasDbOperation>(['backup']);

function defaultScheduler(): AtlasScheduler {
  return {
    now: () => performance.now(),
    set: (delayMs, callback) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function serializedByteLength(value: unknown): number | null {
  try {
    return byteLength(value);
  } catch {
    return null;
  }
}

function workClassFor(operation: AtlasDbOperation): AtlasWorkClass {
  if (readOperations.has(operation)) return 'db-read';
  if (maintenanceOperations.has(operation)) return 'maintenance';
  return 'db-write';
}

export class AtlasWorkerSupervisor {
  private readonly maxQueued: number;
  private readonly maxInFlightReads: number;
  private readonly maxPayloadBytes: number;
  private readonly maxResultBytes: number;
  private readonly requestIdFactory: () => string;
  private readonly scheduler: AtlasScheduler;
  private readonly shutdownGraceMs: number;
  private readonly readQueue: PendingRequest[] = [];
  private readonly writeQueue: PendingRequest[] = [];
  private readonly maintenanceQueue: PendingRequest[] = [];
  private readonly inFlight = new Map<string, PendingRequest>();
  private readonly unsubscribeResponse: () => void;
  private readonly unsubscribeFailure: () => void;
  private closed = false;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private consecutiveReads = 0;

  constructor(
    private readonly endpoint: AtlasWorkerEndpoint,
    options: AtlasWorkerSupervisorOptions = {},
  ) {
    this.maxQueued = Math.max(0, options.maxQueued ?? 128);
    this.maxInFlightReads = Math.max(1, options.maxInFlightReads ?? 4);
    this.maxPayloadBytes = Math.max(1, options.maxPayloadBytes ?? 1_048_576);
    this.maxResultBytes = Math.max(1, options.maxResultBytes ?? 8_388_608);
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 2_000);
    this.unsubscribeResponse = endpoint.onResponse((response) => this.handleResponse(response));
    this.unsubscribeFailure = endpoint.onFailure((error) => this.handleFailure(error));
  }

  execute<Operation extends AtlasDbOperation>(
    operation: Operation,
    payload: AtlasDbOperationPayloads[Operation],
    options: AtlasOperationOptions = {},
  ): Promise<AtlasDbOperationResults[Operation]> {
    if (this.closed) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_CLOSED',
        message: 'Atlas persistence supervisor is closed.',
        retryable: false,
      }));
    }
    if (this.failure) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_WORKER_UNAVAILABLE',
        message: `The database worker is unavailable: ${this.failure.message}`,
        retryable: true,
      }));
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.cancelledError('Atlas operation was cancelled before admission.'));
    }
    if (!Number.isFinite(options.timeoutMs ?? 0) || (options.timeoutMs ?? 0) < 0) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_INVALID_REQUEST',
        message: 'timeoutMs must be a finite non-negative number.',
        retryable: false,
      }));
    }
    const payloadBytes = serializedByteLength(payload);
    if (payloadBytes == null) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_INVALID_REQUEST',
        message: 'Atlas worker payload must be JSON serializable.',
        retryable: false,
      }));
    }
    if (payloadBytes > this.maxPayloadBytes) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_PAYLOAD_TOO_LARGE',
        message: `Atlas worker payload exceeds ${this.maxPayloadBytes} bytes.`,
        retryable: false,
      }));
    }

    const workClass = workClassFor(operation);
    const canDispatchImmediately = this.canDispatch(workClass);
    if (!canDispatchImmediately && this.queuedCount() >= this.maxQueued) {
      return Promise.reject(new AtlasPersistenceError({
        code: 'ATLAS_BACKPRESSURE',
        message: `Atlas ${workClass} queue is full.`,
        retryable: true,
        details: { workClass, maxQueued: this.maxQueued },
      }));
    }

    const now = this.scheduler.now();
    const deadline = options.timeoutMs == null ? null : now + options.timeoutMs;
    const requestId = this.requestIdFactory();
    const request: AtlasWorkerRequest<AtlasDbOperationPayloads[Operation]> = {
      protocolVersion: ATLAS_WORKER_PROTOCOL_VERSION,
      requestId,
      workClass,
      operation,
      payload,
      remainingTimeMs: options.timeoutMs ?? null,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };

    return new Promise<AtlasDbOperationResults[Operation]>((resolve, reject) => {
      const pending: PendingRequest<Operation> = {
        request,
        operation,
        deadline,
        resolve,
        reject,
        ...(options.signal ? { abortSignal: options.signal } : {}),
        state: 'queued',
      };
      if (options.signal) {
        pending.abortListener = () => this.cancelRequest(requestId, false);
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      if (options.timeoutMs != null) {
        pending.timer = this.scheduler.set(options.timeoutMs, () => this.cancelRequest(requestId, true));
      }
      this.queueFor(workClass).push(pending as unknown as PendingRequest);
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closeInternal();
    return this.closing;
  }

  private async closeInternal(): Promise<void> {
    const closedError = new AtlasPersistenceError({
      code: 'ATLAS_CLOSED',
      message: 'Atlas persistence supervisor closed before the operation was dispatched.',
      retryable: false,
    });
    for (const pending of this.drainQueues()) this.settle(pending, undefined, closedError);

    if (this.inFlight.size > 0 && this.shutdownGraceMs > 0) {
      await new Promise<void>((resolve) => {
        const startedAt = this.scheduler.now();
        const poll = () => {
          if (this.inFlight.size === 0 || this.scheduler.now() - startedAt >= this.shutdownGraceMs) {
            resolve();
            return;
          }
          this.scheduler.set(Math.min(10, this.shutdownGraceMs), poll);
        };
        poll();
      });
    }
    for (const pending of [...this.inFlight.values()]) {
      this.endpoint.cancel(pending.request.requestId);
      this.settle(pending, undefined, new AtlasPersistenceError({
        code: pending.request.workClass === 'db-write'
          ? 'ATLAS_INDETERMINATE_WRITE'
          : 'ATLAS_CLOSED',
        message: pending.request.workClass === 'db-write'
          ? 'Atlas closed before the worker acknowledged the write outcome.'
          : 'Atlas closed before the worker returned the operation.',
        retryable: false,
      }));
    }
    this.unsubscribeResponse();
    this.unsubscribeFailure();
    await this.endpoint.close();
  }

  private pump(): void {
    if (this.closed) return;
    while (true) {
      const next = this.nextDispatchable();
      if (!next) return;
      next.state = 'dispatched';
      const remaining = next.deadline == null
        ? null
        : Math.max(0, next.deadline - this.scheduler.now());
      next.request = { ...next.request, remainingTimeMs: remaining };
      this.inFlight.set(next.request.requestId, next);
      try {
        this.endpoint.send(next.request);
      } catch (error) {
        this.inFlight.delete(next.request.requestId);
        this.settle(next, undefined, new AtlasPersistenceError({
          code: 'ATLAS_WORKER_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }));
      }
    }
  }

  private nextDispatchable(): PendingRequest | null {
    const readsInFlight = [...this.inFlight.values()]
      .filter((pending) => pending.request.workClass === 'db-read').length;
    const writeInFlight = [...this.inFlight.values()]
      .some((pending) => pending.request.workClass !== 'db-read');

    const exclusiveQueued = this.writeQueue.length > 0 || this.maintenanceQueue.length > 0;
    if (this.inFlight.size === 0 && this.consecutiveReads >= 4 && exclusiveQueued) {
      this.consecutiveReads = 0;
      return this.writeQueue.shift() ?? this.maintenanceQueue.shift() ?? null;
    }
    if (!writeInFlight && readsInFlight < this.maxInFlightReads && this.readQueue.length > 0) {
      this.consecutiveReads += 1;
      return this.readQueue.shift() ?? null;
    }
    if (this.inFlight.size === 0 && this.writeQueue.length > 0) {
      this.consecutiveReads = 0;
      return this.writeQueue.shift() ?? null;
    }
    if (this.inFlight.size === 0 && this.maintenanceQueue.length > 0) {
      this.consecutiveReads = 0;
      return this.maintenanceQueue.shift() ?? null;
    }
    return null;
  }

  private canDispatch(workClass: AtlasWorkClass): boolean {
    if (workClass === 'db-read') {
      const inFlight = [...this.inFlight.values()];
      return inFlight.every((pending) => pending.request.workClass === 'db-read')
        && inFlight.length < this.maxInFlightReads;
    }
    return this.inFlight.size === 0;
  }

  private handleResponse(response: AtlasWorkerResponse): void {
    const pending = this.inFlight.get(response.requestId);
    if (!pending || pending.state === 'settled') return;
    this.inFlight.delete(response.requestId);
    if (response.ok) {
      const resultBytes = serializedByteLength(response.result);
      if (resultBytes == null || resultBytes > this.maxResultBytes) {
        this.settle(pending, undefined, new AtlasPersistenceError({
          code: 'ATLAS_RESULT_TOO_LARGE',
          message: `Atlas worker result exceeds ${this.maxResultBytes} bytes.`,
          retryable: false,
        }));
      } else {
        this.settle(pending, response.result as AtlasDbOperationResults[typeof pending.operation]);
      }
    } else {
      this.settle(pending, undefined, new AtlasPersistenceError(response.error));
    }
    this.pump();
  }

  private handleFailure(error: Error): void {
    this.failure = error;
    for (const pending of [...this.inFlight.values()]) {
      this.inFlight.delete(pending.request.requestId);
      const isWrite = pending.request.workClass === 'db-write';
      this.settle(pending, undefined, new AtlasPersistenceError({
        code: isWrite ? 'ATLAS_INDETERMINATE_WRITE' : 'ATLAS_WORKER_UNAVAILABLE',
        message: isWrite
          ? 'The database worker exited before acknowledging the write outcome.'
          : `The database worker is unavailable: ${error.message}`,
        retryable: !isWrite,
      }));
    }
    for (const pending of this.drainQueues()) {
      this.settle(pending, undefined, new AtlasPersistenceError({
        code: 'ATLAS_WORKER_UNAVAILABLE',
        message: `The database worker is unavailable: ${error.message}`,
        retryable: true,
      }));
    }
  }

  private cancelRequest(requestId: string, timeout: boolean): void {
    const queued = this.removeQueued(requestId);
    const pending = queued ?? this.inFlight.get(requestId);
    if (!pending || pending.state === 'settled') return;
    if (!queued) {
      this.inFlight.delete(requestId);
      this.endpoint.cancel(requestId);
    }
    const dispatchedWrite = !queued && pending.request.workClass === 'db-write';
    this.settle(pending, undefined, dispatchedWrite
      ? new AtlasPersistenceError({
        code: 'ATLAS_INDETERMINATE_WRITE',
        message: timeout
          ? 'The write deadline expired after dispatch; its outcome is indeterminate.'
          : 'The write was cancelled after dispatch; its outcome is indeterminate.',
        retryable: false,
      })
      : timeout
        ? new AtlasPersistenceError({
          code: 'ATLAS_TIMEOUT',
          message: 'Atlas operation exceeded its deadline.',
          retryable: true,
        })
        : this.cancelledError('Atlas operation was cancelled.'));
    this.pump();
  }

  private cancelledError(message: string): AtlasPersistenceError {
    return new AtlasPersistenceError({ code: 'ATLAS_CANCELLED', message, retryable: false });
  }

  private settle(
    pending: PendingRequest,
    value?: AtlasDbOperationResults[typeof pending.operation],
    error?: Error,
  ): void {
    if (pending.state === 'settled') return;
    pending.state = 'settled';
    if (pending.timer != null) this.scheduler.clear(pending.timer);
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener('abort', pending.abortListener);
    }
    if (error) pending.reject(error);
    else pending.resolve(value as never);
  }

  private queueFor(workClass: AtlasWorkClass): PendingRequest[] {
    if (workClass === 'db-read') return this.readQueue;
    if (workClass === 'db-write') return this.writeQueue;
    return this.maintenanceQueue;
  }

  private queuedCount(): number {
    return this.readQueue.length + this.writeQueue.length + this.maintenanceQueue.length;
  }

  private removeQueued(requestId: string): PendingRequest | null {
    for (const queue of [this.readQueue, this.writeQueue, this.maintenanceQueue]) {
      const index = queue.findIndex((pending) => pending.request.requestId === requestId);
      if (index >= 0) return queue.splice(index, 1)[0] ?? null;
    }
    return null;
  }

  private drainQueues(): PendingRequest[] {
    return [
      ...this.readQueue.splice(0),
      ...this.writeQueue.splice(0),
      ...this.maintenanceQueue.splice(0),
    ];
  }
}
