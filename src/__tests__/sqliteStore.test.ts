import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeAtlasDatabase, openAtlasDatabase, upsertFileRecord } from '../db.js';
import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore } from '../persistence/sqliteStore.js';
import { AtlasPersistenceError } from '../persistence/types.js';

const migrationDir = getAtlasCoreMigrationsDir();

function errorCode(code: AtlasPersistenceError['code']): (error: unknown) => boolean {
  return (error) => error instanceof AtlasPersistenceError && error.code === code;
}

async function tempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-store-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('real worker owns SQLite and preserves read-your-writes plus idempotency', async (t) => {
  const directory = await tempDirectory(t);
  const store = await openSqliteAtlasStore({
    dbPath: path.join(directory, 'atlas.sqlite'),
    migrationDir,
  });
  t.after(() => store.close());

  const health = await store.health();
  assert.equal(health.integrity, 'ok');
  assert.equal(health.migrationHead, '0019_commit_evidence.sql');
  assert.equal(health.migrationCount, 20);

  const file = {
    workspace: 'repo',
    file_path: 'src/index.ts',
    blurb: 'portable atlas worker',
    purpose: 'exercise lexical persistence',
  };
  await store.upsertFile({ workspace: 'repo', file }, { idempotencyKey: 'file-1' });
  await store.upsertFile({ workspace: 'repo', file }, { idempotencyKey: 'file-1' });
  await assert.rejects(
    store.upsertFile({
      workspace: 'repo',
      file: { ...file, purpose: 'different payload' },
    }, { idempotencyKey: 'file-1' }),
    errorCode('ATLAS_CONFLICT'),
  );
  await store.upsertFile({
    workspace: 'other-repo',
    file: { ...file, workspace: 'other-repo' },
  }, { idempotencyKey: 'file-1' });

  assert.equal((await store.getFile({ workspace: 'repo', filePath: 'src/index.ts' }))?.purpose,
    'exercise lexical persistence');
  assert.deepEqual((await store.listFiles({ workspace: 'repo' })).map((entry) => entry.file_path),
    ['src/index.ts']);
  assert.equal((await store.searchLexical({ workspace: 'repo', query: 'portable' }))[0]?.file.file_path,
    'src/index.ts');
});

test('writer lock rejects a collision and is released on orderly close', async (t) => {
  const directory = await tempDirectory(t);
  const options = { dbPath: path.join(directory, 'atlas.sqlite'), migrationDir };
  const first = await openSqliteAtlasStore(options);
  await assert.rejects(openSqliteAtlasStore(options), errorCode('ATLAS_STORE_LOCKED'));
  await first.close();
  const reopened = await openSqliteAtlasStore(options);
  await reopened.close();
});

test('verified backup recovers a corrupt primary without losing committed data', async (t) => {
  const directory = await tempDirectory(t);
  const dbPath = path.join(directory, 'atlas.sqlite');
  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  await store.upsertFile({
    workspace: 'repo',
    file: { workspace: 'repo', file_path: 'src/survives.ts', purpose: 'recovery sentinel' },
  }, { idempotencyKey: 'sentinel-write' });
  const backup = await store.backup();
  assert.equal(backup.integrity, 'ok');
  await store.close();

  await writeFile(dbPath, Buffer.from('not a sqlite database'), { flag: 'w' });
  const recovered = await openSqliteAtlasStore({ dbPath, migrationDir });
  t.after(() => recovered.close());
  assert.equal(recovered.status.state, 'recovered');
  assert.equal(recovered.status.backup?.backupId, backup.backupId);
  assert.equal((await recovered.getFile({ workspace: 'repo', filePath: 'src/survives.ts' }))?.purpose,
    'recovery sentinel');
  assert.ok((await readdir(directory)).some((name) => name.startsWith('atlas.sqlite.corrupt-')));
});

test('a frozen 0.1.0 database upgrades in place and receives checksums', async (t) => {
  const directory = await tempDirectory(t);
  const oldMigrations = path.join(directory, 'old-migrations');
  await cp(migrationDir, oldMigrations, {
    recursive: true,
    filter: (source) => !/^001[89]_/u.test(path.basename(source)),
  });
  const dbPath = path.join(directory, 'atlas.sqlite');
  const legacy = openAtlasDatabase({ dbPath, migrationDir: oldMigrations });
  upsertFileRecord(legacy, {
    workspace: 'repo',
    file_path: 'legacy.ts',
    purpose: 'upgrade sentinel',
  });
  closeAtlasDatabase(dbPath);

  const upgraded = await openSqliteAtlasStore({ dbPath, migrationDir });
  assert.equal((await upgraded.getFile({ workspace: 'repo', filePath: 'legacy.ts' }))?.purpose,
    'upgrade sentinel');
  assert.equal((await upgraded.health()).migrationCount, 20);
  await upgraded.close();

  const verified = openAtlasDatabase({ dbPath, migrationDir });
  const missingChecksums = verified.prepare(
    'SELECT COUNT(*) AS count FROM atlas_schema_migrations WHERE checksum IS NULL',
  ).get() as { count: number };
  assert.equal(missingChecksums.count, 0);
  closeAtlasDatabase(dbPath);
});

test('migration history rejects an executable checksum change', async (t) => {
  const directory = await tempDirectory(t);
  const dbPath = path.join(directory, 'atlas.sqlite');
  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  await store.close();

  const changedMigrations = path.join(directory, 'changed-migrations');
  await cp(migrationDir, changedMigrations, { recursive: true });
  const changedPath = path.join(changedMigrations, '0017_operator_memory.sql');
  await writeFile(changedPath, `${await readFile(changedPath, 'utf8')}\n-- changed executable artifact\n`);
  await assert.rejects(
    openSqliteAtlasStore({ dbPath, migrationDir: changedMigrations }),
    errorCode('ATLAS_SCHEMA_CHECKSUM_MISMATCH'),
  );
});
