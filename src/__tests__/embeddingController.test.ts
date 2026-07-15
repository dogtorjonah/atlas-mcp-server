import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AtlasEmbeddingController,
  AtlasEmbeddingValidationError,
  embeddingInputHash,
  embeddingSpaceKey,
  rerankWithEmbeddings,
} from '../embedding/controller.js';
import type {
  EmbeddingBatchRequest,
  EmbeddingBatchResult,
  EmbeddingModelIdentity,
  EmbeddingProvider,
} from '../embedding/types.js';

const identity: EmbeddingModelIdentity = {
  providerId: 'fixture',
  modelId: 'tiny-vector',
  modelRevision: 'sha256:immutable-weights',
  dimensions: 2,
  distanceMetric: 'cosine',
  normalization: 'unit',
  inputFormatVersion: 'atlas-file-v1',
};

class FixtureProvider implements EmbeddingProvider {
  readonly identity = { ...identity };
  readonly limits = {
    maxBatchItems: 2,
    maxItemBytes: 64,
    maxBatchBytes: 100,
    maxConcurrentBatches: 2,
  };
  active = 0;
  maxActive = 0;
  calls: string[][] = [];
  mode: 'valid' | 'missing' | 'nan' | 'wrong-identity' | 'throw' = 'valid';

  async embed(request: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
    this.calls.push(request.items.map((item) => item.id));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    if (this.mode === 'throw') throw new Error('provider unavailable');
    const resultIdentity = this.mode === 'wrong-identity'
      ? { ...this.identity, modelRevision: 'changed' }
      : this.identity;
    const items = request.items.map((item, index) => ({
      id: item.id,
      ok: true as const,
      vector: this.mode === 'nan' ? [Number.NaN, 0] : index % 2 === 0 ? [1, 0] : [0, 1],
    })).reverse();
    return {
      identity: resultIdentity,
      items: this.mode === 'missing' ? items.slice(1) : items,
    };
  }
}

function item(id: string, text: string) {
  return { id, text, inputHash: embeddingInputHash(text) };
}

test('embedding controller derives immutable space identity and preserves IDs across bounded parallel batches', async () => {
  const provider = new FixtureProvider();
  const controller = new AtlasEmbeddingController(provider);
  assert.equal(controller.spaceKey, embeddingSpaceKey(identity));
  assert.match(controller.spaceKey, /^sha256:[0-9a-f]{64}$/u);
  const result = await controller.embed([
    item('a', 'alpha'),
    item('b', 'bravo'),
    item('c', 'charlie'),
    item('d', 'delta'),
    item('e', 'echo'),
  ]);
  assert.deepEqual(result.map((entry) => entry.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(provider.calls, [['a', 'b'], ['c', 'd'], ['e']]);
  assert.ok(provider.maxActive <= provider.limits.maxConcurrentBatches);
});

test('embedding controller rejects missing, incompatible, malformed, and mutated provider output', async () => {
  for (const mode of ['missing', 'nan', 'wrong-identity'] as const) {
    const provider = new FixtureProvider();
    provider.mode = mode;
    const controller = new AtlasEmbeddingController(provider);
    await assert.rejects(controller.embed([item('a', 'alpha')]), AtlasEmbeddingValidationError);
  }

  const provider = new FixtureProvider();
  const controller = new AtlasEmbeddingController(provider);
  provider.identity.modelRevision = 'mutated-after-open';
  await assert.rejects(controller.embed([item('a', 'alpha')]), /identity changed/u);
  const stable = new AtlasEmbeddingController(new FixtureProvider());
  await assert.rejects(stable.embed([{ id: 'a', text: 'alpha', inputHash: 'wrong' }]), /inputHash/u);
  await assert.rejects(stable.embed([item('same', 'one'), item('same', 'two')]), /duplicated/u);
});

test('provider and dense-search failures preserve the exact lexical array, values, scores, and order', async () => {
  const lexical = [
    { id: 'a', score: 0.1, evidence: 'lexical-a' },
    { id: 'b', score: 0.2, evidence: 'lexical-b' },
  ] as const;
  const provider = new FixtureProvider();
  provider.mode = 'throw';
  const failedProvider = await rerankWithEmbeddings(
    lexical,
    'query',
    new AtlasEmbeddingController(provider),
    async () => [],
  );
  assert.equal(failedProvider.items, lexical);
  assert.deepEqual(failedProvider.items, lexical);
  assert.equal(failedProvider.meta.status, 'provider-failed');

  const valid = new AtlasEmbeddingController(new FixtureProvider());
  const failedSearch = await rerankWithEmbeddings(
    lexical,
    'query',
    valid,
    async () => { throw new Error('vector store unavailable'); },
  );
  assert.equal(failedSearch.items, lexical);
  assert.deepEqual(failedSearch.items, lexical);
  assert.equal(failedSearch.meta.status, 'search-failed');
});

test('successful hybrid fusion is deterministic and uses lexical position as the stable tie-break', async () => {
  const lexical = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const controller = new AtlasEmbeddingController(new FixtureProvider());
  const first = await rerankWithEmbeddings(
    lexical,
    'query',
    controller,
    async () => [{ id: 'c', score: 0.01 }, { id: 'b', score: 0.02 }],
  );
  const second = await rerankWithEmbeddings(
    lexical,
    'query',
    controller,
    async () => [{ id: 'c', score: 999 }, { id: 'b', score: -999 }],
  );
  assert.deepEqual(first.items.map((entry) => entry.id), ['c', 'b', 'a']);
  assert.deepEqual(second.items, first.items);
  assert.equal(first.meta.status, 'current');
  assert.equal(first.meta.lexicalFallback, false);
});
