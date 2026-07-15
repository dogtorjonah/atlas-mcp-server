import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore } from '../persistence/sqliteStore.js';
import { createAtlasService } from '../service/AtlasReadService.js';

const fixtureRoot = path.resolve('test/fixtures/repositories/small');
const migrationDir = getAtlasCoreMigrationsDir();

async function tempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-admin-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('typed admin service indexes bounded paths and reports doctor, workspaces, migration, and backup', async (t) => {
  const directory = await tempDirectory(t);
  const sourceRoot = path.join(directory, 'repository');
  const backupDir = path.join(directory, 'backups');
  await cp(fixtureRoot, sourceRoot, { recursive: true });
  const store = await openSqliteAtlasStore({
    dbPath: path.join(directory, 'atlas.sqlite'),
    migrationDir,
    backupDir,
  });
  const service = createAtlasService(store, {
    workspace: 'fixture',
    sourceRoot,
    indexConcurrency: 2,
    requestIdFactory: () => 'admin-test',
  });

  const indexed = await service.admin({
    action: 'index',
    paths: ['src/index.ts'],
    full: true,
  });
  assert.ok(indexed.ok);
  assert.equal(indexed.data.action, 'index');
  if (indexed.data.action === 'index') {
    assert.equal(indexed.data.mode, 'full');
    assert.equal(indexed.data.filesProcessed, 1);
    assert.equal(indexed.data.filesFailed, 0);
  }

  const workspaces = await service.admin({ action: 'workspace_list' });
  assert.ok(workspaces.ok);
  assert.deepEqual(workspaces.data, { action: 'workspace_list', workspaces: ['fixture'] });

  const doctor = await service.admin({ action: 'doctor', includeOptional: true });
  assert.ok(doctor.ok);
  assert.equal(doctor.data.action, 'doctor');
  if (doctor.data.action === 'doctor') {
    assert.equal(doctor.data.healthy, true);
    assert.ok(doctor.data.checks.some((check) => check.name === 'vector' && check.status === 'warn'));
  }

  const migration = await service.admin({ action: 'migrate', dryRun: true });
  assert.ok(migration.ok);
  assert.equal(migration.data.action, 'migrate');
  if (migration.data.action === 'migrate') {
    assert.equal(migration.data.migrationHead, '0019_commit_evidence.sql');
    assert.deepEqual(migration.data.applied, []);
  }

  const backup = await service.admin({ action: 'backup', label: 'release-gate', protected: true });
  assert.ok(backup.ok);
  assert.equal(backup.data.action, 'backup');
  if (backup.data.action === 'backup') {
    assert.equal(backup.data.label, 'release-gate');
    assert.equal(backup.data.protected, true);
    assert.ok((await readdir(backupDir)).includes(backup.data.backupId));
  }
  await service.close();
});

test('admin rejects unavailable, hostile, and incompatible requests with stable errors', async (t) => {
  const directory = await tempDirectory(t);
  const sourceRoot = path.join(directory, 'repository');
  await cp(fixtureRoot, sourceRoot, { recursive: true });
  const store = await openSqliteAtlasStore({ dbPath: path.join(directory, 'atlas.sqlite'), migrationDir });
  const service = createAtlasService(store, {
    workspace: 'fixture',
    sourceRoot,
    requestIdFactory: () => 'admin-invalid',
  });
  const hostile = await service.admin({ action: 'index', paths: ['../escape.ts'] });
  assert.equal(hostile.ok, false);
  if (!hostile.ok) assert.equal(hostile.error.code, 'ATLAS_INVALID_REQUEST');
  const embeddings = await service.admin({ action: 'index', phase: 'embeddings' });
  assert.equal(embeddings.ok, false);
  if (!embeddings.ok) assert.equal(embeddings.error.code, 'ATLAS_CAPABILITY_UNAVAILABLE');
  const target = await service.admin({ action: 'migrate', targetGeneration: 'future-generation' });
  assert.equal(target.ok, false);
  if (!target.ok) assert.equal(target.error.code, 'ATLAS_SCHEMA_HISTORY_DIVERGED');
  const check = await service.admin({ action: 'doctor', checks: ['not-a-check'] });
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.error.code, 'ATLAS_INVALID_REQUEST');
  await service.close();

  const noRootStore = await openSqliteAtlasStore({ dbPath: path.join(directory, 'no-root.sqlite'), migrationDir });
  const noRoot = createAtlasService(noRootStore, {
    workspace: 'fixture',
    requestIdFactory: () => 'admin-no-root',
  });
  const unavailable = await noRoot.admin({ action: 'index' });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, 'ATLAS_CAPABILITY_UNAVAILABLE');
  await noRoot.close();
});
