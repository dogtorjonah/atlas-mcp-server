import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AtlasCommitRequest, AtlasJsonValue, AtlasProvenanceEvidence } from '../core/types.js';
import { closeAtlasDatabase, openAtlasDatabase } from '../db.js';
import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore } from '../persistence/sqliteStore.js';
import { createAtlasService } from '../service/AtlasReadService.js';

const migrationDir = getAtlasCoreMigrationsDir();

function canonical(value: AtlasJsonValue): AtlasJsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function payloadHash(payload: AtlasJsonValue): string {
  return createHash('sha256').update(JSON.stringify(canonical(payload)), 'utf8').digest('hex');
}

async function tempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-writeback-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function evidence(evidenceId: string, payload: AtlasJsonValue): AtlasProvenanceEvidence {
  return {
    namespace: 'test.atlas.writeback',
    schemaVersion: '1',
    providerId: 'fixture-reviewer',
    providerVersion: '1.0.0',
    evidenceId,
    subject: { kind: 'file', workspace: 'fixture', key: 'src/index.ts' },
    kind: 'reviewed',
    occurredAt: '2026-07-14T20:00:00.000Z',
    observedAt: '2026-07-14T20:00:01.000Z',
    authority: 'verified-external',
    confidence: 'high',
    payload,
    payloadHash: payloadHash(payload),
  };
}

test('commit atomically writes metadata, changelog, attribution, evidence, and lexical state', async (t) => {
  const directory = await tempDirectory(t);
  const dbPath = path.join(directory, 'atlas.sqlite');
  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  await store.upsertFile({
    workspace: 'fixture',
    file: {
      workspace: 'fixture',
      file_path: 'src/index.ts',
      purpose: 'Old purpose',
      blurb: 'Old blurb',
      tags: ['fixture'],
      source_highlights: [{ id: 1, label: 'Entry', startLine: 1, endLine: 2, content: 'export {};' }],
      hazards: ['legacy hazard'],
    },
  });
  let requestNumber = 0;
  const service = createAtlasService(store, {
    workspace: 'fixture',
    requestIdFactory: () => `write-${++requestNumber}`,
  });
  const request: AtlasCommitRequest = {
    filePath: 'src/index.ts',
    changelogEntry: 'Promote the fixture metadata through the public write service.',
    idempotencyKey: 'commit-fixture-1',
    purpose: 'Public writeback fixture',
    blurb: 'Worker-owned semantic write',
    tags: ['fixture', 'writeback'],
    hazards: ['transaction rollback risk'],
    sourceHighlights: [{ id: 1, label: 'Entry', startLine: 1, endLine: 2 }],
    attribution: {
      principal: { id: 'reviewer-1', displayName: 'Fixture reviewer', kind: 'automation' },
      runtime: { name: 'test-runtime', version: '1.0.0' },
      toolId: 'writeback-test',
      source: 'test',
    },
    evidence: [evidence('evidence-1', { verdict: 'pass', checks: 4 })],
  };

  const first = await service.commit(request);
  assert.ok(first.ok);
  assert.equal(first.data.verificationStatus, 'verified');
  assert.equal(first.data.evidenceCount, 1);
  assert.equal(first.data.idempotencyStatus, 'recorded');
  assert.match(first.data.version, /^sha256:[0-9a-f]{64}$/u);
  assert.equal((await store.getFile({ workspace: 'fixture', filePath: 'src/index.ts' }))?.purpose,
    'Public writeback fixture');
  assert.equal((await store.searchLexical({ workspace: 'fixture', query: 'writeback' }))[0]?.file.file_path,
    'src/index.ts');

  const replay = await service.commit(request);
  assert.ok(replay.ok);
  assert.deepEqual(replay.data, first.data);
  const conflict = await service.commit({ ...request, changelogEntry: 'Conflicting reuse.' });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'ATLAS_WRITE_CONFLICT');

  await store.close();
  const db = openAtlasDatabase({ dbPath, migrationDir });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_changelog').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_provenance_evidence').get() as { count: number }).count, 1);
  const attribution = db.prepare('SELECT attribution_json FROM atlas_changelog LIMIT 1').get() as { attribution_json: string };
  assert.equal(JSON.parse(attribution.attribution_json).principal.id, 'reviewer-1');
  closeAtlasDatabase(dbPath);
});

test('commit rejects stale versions and rolls back metadata when required evidence conflicts', async (t) => {
  const directory = await tempDirectory(t);
  const dbPath = path.join(directory, 'atlas.sqlite');
  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  await store.upsertFile({
    workspace: 'fixture',
    file: {
      workspace: 'fixture',
      file_path: 'src/index.ts',
      purpose: 'Before',
      blurb: 'Before',
      tags: ['fixture'],
      source_highlights: [{ id: 1, label: 'Entry', startLine: 1, endLine: 1, content: 'before' }],
    },
  });
  const service = createAtlasService(store, { workspace: 'fixture', requestIdFactory: () => 'write-test' });
  const base: AtlasCommitRequest = {
    filePath: 'src/index.ts',
    changelogEntry: 'First atomic write.',
    idempotencyKey: 'atomic-1',
    purpose: 'Committed',
    evidence: [evidence('shared-evidence', { state: 'first' })],
  };
  const committed = await service.commit(base);
  assert.ok(committed.ok);

  const stale = await service.commit({
    ...base,
    changelogEntry: 'Stale optimistic write.',
    idempotencyKey: 'atomic-stale',
    expectedVersion: 'sha256:stale',
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'ATLAS_WRITE_CONFLICT');

  const evidenceConflict = await service.commit({
    ...base,
    changelogEntry: 'This entire command must roll back.',
    idempotencyKey: 'atomic-2',
    purpose: 'Must not persist',
  });
  assert.equal(evidenceConflict.ok, false);
  if (!evidenceConflict.ok) assert.equal(evidenceConflict.error.code, 'ATLAS_WRITE_CONFLICT');
  assert.equal((await store.getFile({ workspace: 'fixture', filePath: 'src/index.ts' }))?.purpose, 'Committed');

  const invalidEvidence = evidence('bad-hash', { state: 'invalid' });
  invalidEvidence.payloadHash = '0'.repeat(64);
  const invalid = await service.commit({
    ...base,
    changelogEntry: 'Invalid evidence must fail before write.',
    idempotencyKey: 'atomic-invalid',
    evidence: [invalidEvidence],
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'ATLAS_INVALID_REQUEST');

  await store.close();
  const db = openAtlasDatabase({ dbPath, migrationDir });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_changelog').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_operation_idempotency').get() as { count: number }).count, 1);
  closeAtlasDatabase(dbPath);
});

test('commit rejects noncanonical paths, incomplete identity, and unknown fields without creating rows', async (t) => {
  const directory = await tempDirectory(t);
  const dbPath = path.join(directory, 'atlas.sqlite');
  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  const service = createAtlasService(store, { workspace: 'fixture', requestIdFactory: () => 'invalid-write' });
  for (const request of [
    { filePath: '../escape.ts', changelogEntry: 'Escape.' },
    { filePath: 'src/new.ts', changelogEntry: 'Missing identity.' },
    { filePath: 'src/new.ts', changelogEntry: 'Unknown.', purpose: 'P', blurb: 'B', tags: ['t'], sourceHighlights: [{ label: 'x', startLine: 1, endLine: 1 }], surprise: true },
  ] as AtlasCommitRequest[]) {
    const result = await service.commit(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'ATLAS_INVALID_REQUEST');
  }
  await store.close();
  const db = openAtlasDatabase({ dbPath, migrationDir });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_changelog').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM atlas_files').get() as { count: number }).count, 0);
  closeAtlasDatabase(dbPath);
});
