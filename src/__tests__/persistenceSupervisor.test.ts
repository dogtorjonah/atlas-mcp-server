import assert from 'node:assert/strict';
import test from 'node:test';

import { AtlasWorkerSupervisor } from '../persistence/supervisor.js';
import {
  AtlasPersistenceError,
  type AtlasScheduler,
  type AtlasWorkerEndpoint,
  type AtlasWorkerRequest,
  type AtlasWorkerResponse,
} from '../persistence/types.js';

class FakeEndpoint implements AtlasWorkerEndpoint {
  readonly sent: AtlasWorkerRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly responseListeners = new Set<(response: AtlasWorkerResponse) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();

  send(request: AtlasWorkerRequest): void {
    this.sent.push(request);
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
  }

  onResponse(listener: (response: AtlasWorkerResponse) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {}

  resolve(request: AtlasWorkerRequest, result: unknown): void {
    for (const listener of this.responseListeners) {
      listener({ requestId: request.requestId, ok: true, result });
    }
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) listener(error);
  }
}

class ManualScheduler implements AtlasScheduler {
  private time = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  set(delayMs: number, callback: () => void): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(delayMs: number): void {
    this.time += delayMs;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.time)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function errorCode(code: AtlasPersistenceError['code']): (error: unknown) => boolean {
  return (error) => error instanceof AtlasPersistenceError && error.code === code;
}

test('supervisor keeps writes exclusive while allowing bounded concurrent reads', async () => {
  const endpoint = new FakeEndpoint();
  let id = 0;
  const supervisor = new AtlasWorkerSupervisor(endpoint, {
    maxInFlightReads: 2,
    requestIdFactory: () => `request-${++id}`,
  });

  const first = supervisor.execute('get-file', { workspace: 'repo', filePath: 'a.ts' });
  const second = supervisor.execute('get-file', { workspace: 'repo', filePath: 'b.ts' });
  const third = supervisor.execute('get-file', { workspace: 'repo', filePath: 'c.ts' });
  const write = supervisor.execute('delete-file', { workspace: 'repo', filePath: 'd.ts' });

  assert.deepEqual(endpoint.sent.map((request) => request.requestId), ['request-1', 'request-2']);
  endpoint.resolve(endpoint.sent[0]!, null);
  assert.deepEqual(endpoint.sent.map((request) => request.requestId), ['request-1', 'request-2', 'request-3']);
  endpoint.resolve(endpoint.sent[1]!, null);
  assert.equal(endpoint.sent.length, 3, 'write must wait for every read to finish');
  endpoint.resolve(endpoint.sent[2]!, null);
  assert.equal(endpoint.sent[3]?.operation, 'delete-file');
  endpoint.resolve(endpoint.sent[3]!, true);

  assert.deepEqual(await Promise.all([first, second, third, write]), [null, null, null, true]);
  await supervisor.close();
});

test('supervisor applies bounded backpressure before accepting more queued work', async () => {
  const endpoint = new FakeEndpoint();
  const supervisor = new AtlasWorkerSupervisor(endpoint, { maxInFlightReads: 1, maxQueued: 1 });
  const first = supervisor.execute('get-file', { workspace: 'repo', filePath: 'a.ts' });
  const second = supervisor.execute('get-file', { workspace: 'repo', filePath: 'b.ts' });
  await assert.rejects(
    supervisor.execute('get-file', { workspace: 'repo', filePath: 'c.ts' }),
    errorCode('ATLAS_BACKPRESSURE'),
  );
  endpoint.resolve(endpoint.sent[0]!, null);
  endpoint.resolve(endpoint.sent[1]!, null);
  await Promise.all([first, second]);
  await supervisor.close();
});

test('queued cancellation is definite and does not send a worker cancellation', async () => {
  const endpoint = new FakeEndpoint();
  const supervisor = new AtlasWorkerSupervisor(endpoint, { maxInFlightReads: 1 });
  const first = supervisor.execute('get-file', { workspace: 'repo', filePath: 'a.ts' });
  const controller = new AbortController();
  const second = supervisor.execute(
    'get-file',
    { workspace: 'repo', filePath: 'b.ts' },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(second, errorCode('ATLAS_CANCELLED'));
  assert.deepEqual(endpoint.cancelled, []);
  endpoint.resolve(endpoint.sent[0]!, null);
  await first;
  await supervisor.close();
});

test('a dispatched write timeout reports an indeterminate outcome', async () => {
  const endpoint = new FakeEndpoint();
  const scheduler = new ManualScheduler();
  const supervisor = new AtlasWorkerSupervisor(endpoint, { scheduler });
  const result = supervisor.execute(
    'delete-file',
    { workspace: 'repo', filePath: 'a.ts' },
    { timeoutMs: 5 },
  );
  scheduler.advance(5);
  await assert.rejects(result, errorCode('ATLAS_INDETERMINATE_WRITE'));
  assert.deepEqual(endpoint.cancelled, [endpoint.sent[0]?.requestId]);
  endpoint.resolve(endpoint.sent[0]!, true);
  await supervisor.close();
});

test('worker failure distinguishes acknowledged reads from indeterminate writes', async () => {
  const endpoint = new FakeEndpoint();
  const supervisor = new AtlasWorkerSupervisor(endpoint);
  const write = supervisor.execute('delete-file', { workspace: 'repo', filePath: 'a.ts' });
  const read = supervisor.execute('get-file', { workspace: 'repo', filePath: 'a.ts' });
  endpoint.fail(new Error('worker crashed'));
  await assert.rejects(write, errorCode('ATLAS_INDETERMINATE_WRITE'));
  await assert.rejects(read, errorCode('ATLAS_WORKER_UNAVAILABLE'));
  await assert.rejects(
    supervisor.execute('health', {}),
    errorCode('ATLAS_WORKER_UNAVAILABLE'),
  );
  await supervisor.close();
});

test('non-serializable payloads fail before worker admission', async () => {
  const endpoint = new FakeEndpoint();
  const supervisor = new AtlasWorkerSupervisor(endpoint);
  await assert.rejects(
    supervisor.execute('health', { value: 1n } as never),
    errorCode('ATLAS_INVALID_REQUEST'),
  );
  assert.equal(endpoint.sent.length, 0);
  await supervisor.close();
});
