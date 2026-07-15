import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  foldReceiptToAtlasEvidence,
  type ContextWarpPrepareReceipt,
} from '../src/index.ts';

const receipt: ContextWarpPrepareReceipt = {
  version: 1,
  kind: 'fold-prepare-receipt',
  subject: { sessionId: 'session-1', turnCount: 4, messageCount: 8 },
  input: {
    rawHistoryDigest: `sha256:${'1'.repeat(64)}`,
    messageCount: 8,
    rawHistoryStoreRef: 'local-only:private-session',
    tokenizer: 'provider-measured',
    measuredInputTokens: 1_234,
  },
  fold: {
    strategy: 'rolling-fold+freeze+coordinate-closet',
    configDigest: `sha256:${'2'.repeat(64)}`,
    foldedViewDigest: `sha256:${'3'.repeat(64)}`,
    preparedMessageCount: 4,
    frozenPrefixDigest: `sha256:${'4'.repeat(64)}`,
    sealedBoundary: 2,
    cacheHot: true,
    epochs: 1,
    hotReuses: 3,
  },
  privacy: {
    receiptEmbedsRawContent: false,
    digestsOnly: true,
    foldedViewDerivedFromRawHistory: true,
  },
  staleIf: ['raw_history_digest_changed', 'provider_cache_semantics_changed'],
  generatedAt: '2026-07-14T00:00:00.000Z',
};

const options = {
  workspace: 'demo',
  subjectKey: 'prepare:session-1',
  contextWarpVersion: '0.1.0',
  observedAt: '2026-07-14T00:00:01.000Z',
} as const;

test('fold receipts map to deterministic digest-only Atlas evidence', () => {
  const first = foldReceiptToAtlasEvidence(receipt, options);
  const second = foldReceiptToAtlasEvidence(receipt, options);
  assert.deepEqual(first, second);
  assert.match(first.payloadHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.sourceRef, undefined);
  assert.equal((first.payload as { measured_input_tokens?: number }).measured_input_tokens, 1_234);
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes('private-session'));
  assert.ok(!serialized.includes('raw message content'));
});

test('opaque source references require an explicit opt-in', () => {
  const evidence = foldReceiptToAtlasEvidence(receipt, { ...options, includeSourceRef: true });
  assert.equal(evidence.sourceRef, 'local-only:private-session');
});

test('invalid or content-bearing receipts fail closed', () => {
  assert.throws(
    () => foldReceiptToAtlasEvidence({
      ...receipt,
      privacy: { ...receipt.privacy, receiptEmbedsRawContent: true },
    }, options),
    /digest-only boundary/u,
  );
  assert.throws(
    () => foldReceiptToAtlasEvidence({
      ...receipt,
      input: { ...receipt.input, rawHistoryDigest: 'not-a-digest' },
    }, options),
    /sha256 digest/u,
  );
});

test('the adapter is the only package in this repository that names Context Warp', async () => {
  const rootManifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  assert.equal(rootManifest.dependencies?.['context-warp-drive'], undefined);
  assert.equal(rootManifest.peerDependencies?.['context-warp-drive'], undefined);
});
