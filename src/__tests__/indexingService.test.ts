import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeAtlasDatabase, openAtlasDatabase } from '../db.js';
import { AtlasWatchBatcher } from '../indexing/watcher.js';
import type { AtlasWatchChange, AtlasWatchScheduler } from '../indexing/types.js';
import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore } from '../persistence/sqliteStore.js';

const migrationDir = getAtlasCoreMigrationsDir();
const fixtureRoot = path.resolve('test/fixtures/repositories/small');
const fixedNow = '2026-07-14T12:00:00.000Z';

async function tempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-index-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('worker-owned full and incremental indexing converge after modify, delete, and rename', async (t) => {
  const directory = await tempDirectory(t);
  const sourceRoot = path.join(directory, 'repository');
  const dbPath = path.join(directory, 'atlas.sqlite');
  await cp(fixtureRoot, sourceRoot, { recursive: true });
  await symlink('math/add.ts', path.join(sourceRoot, 'src/add-alias.ts'));
  await writeFile(
    path.join(sourceRoot, 'src/alias-consumer.ts'),
    "import { add } from './add-alias.js';\nexport const aliasedTotal = add(1, 2);\n",
  );
  await writeFile(path.join(directory, 'outside.ts'), 'export const outside = true;\n');
  await symlink('../../outside.ts', path.join(sourceRoot, 'src/outside-alias.ts'));
  await writeFile(
    path.join(sourceRoot, 'src/outside-consumer.ts'),
    "import { outside } from './outside-alias.js';\nexport { outside };\n",
  );

  const store = await openSqliteAtlasStore({ dbPath, migrationDir });
  t.after(() => store.close());

  const full = await store.indexRepository({
    workspace: 'fixture',
    sourceRoot,
    mode: 'full',
    concurrency: 2,
    now: fixedNow,
  });
  assert.equal(full.mode, 'full');
  assert.ok(full.filesProcessed >= 8);
  assert.equal(full.freshness.staleRecords, 0);
  assert.ok(full.freshness.scanFingerprint.match(/^[0-9a-f]{64}$/));
  assert.ok(full.failures.some((failure) =>
    failure.filePath === 'src/malformed.ts' && failure.stage === 'parse'));
  assert.equal(full.filesFailed, full.failures.length);

  const initialFiles = await store.listFiles({ workspace: 'fixture' });
  assert.ok(initialFiles.some((file) => file.file_path === 'src/math/add.ts'));
  assert.ok(!initialFiles.some((file) => file.file_path === 'src/add-alias.ts'));
  assert.ok(initialFiles
    .filter((file) => file.file_path !== 'src/malformed.ts')
    .every((file) => JSON.stringify(file.cross_refs).includes(fixedNow)));

  const stable = await store.indexRepository({
    workspace: 'fixture',
    sourceRoot,
    mode: 'incremental',
    concurrency: 2,
    now: fixedNow,
  });
  assert.deepEqual(stable.freshness.changedFiles, []);
  assert.deepEqual(stable.freshness.deletedFiles, []);
  assert.deepEqual(stable.freshness.invalidatedFiles, []);
  assert.equal(stable.freshness.scanFingerprint, full.freshness.scanFingerprint);

  const indexPath = path.join(sourceRoot, 'src/index.ts');
  await writeFile(
    indexPath,
    (await readFile(indexPath, 'utf8')).replace('rename/new-name.js', 'rename/current-name.js'),
  );
  await rename(
    path.join(sourceRoot, 'src/rename/new-name.ts'),
    path.join(sourceRoot, 'src/rename/current-name.ts'),
  );
  await unlink(path.join(sourceRoot, 'src/dead.ts'));
  await writeFile(
    path.join(sourceRoot, 'src/math/add.ts'),
    `${await readFile(path.join(sourceRoot, 'src/math/add.ts'), 'utf8')}\nexport const zero = 0;\n`,
  );
  await writeFile(path.join(sourceRoot, 'src/new.ts'), 'export const newValue = 1;\n');

  const updated = await store.indexRepository({
    workspace: 'fixture',
    sourceRoot,
    mode: 'incremental',
    concurrency: 2,
    now: fixedNow,
  });
  assert.deepEqual(updated.freshness.deletedFiles, [
    'src/dead.ts',
    'src/rename/new-name.ts',
  ]);
  assert.ok(updated.freshness.changedFiles.includes('src/index.ts'));
  assert.ok(updated.freshness.changedFiles.includes('src/math/add.ts'));
  assert.ok(updated.freshness.changedFiles.includes('src/new.ts'));
  assert.ok(updated.freshness.invalidatedFiles.includes('src/alias-consumer.ts'));
  assert.ok(updated.freshness.invalidatedFiles.includes('src/math/index.ts'));
  assert.equal(updated.freshness.staleRecords, 0);

  const currentFiles = await store.listFiles({ workspace: 'fixture' });
  assert.ok(currentFiles.some((file) => file.file_path === 'src/rename/current-name.ts'));
  assert.ok(!currentFiles.some((file) => file.file_path === 'src/rename/new-name.ts'));
  assert.ok(!currentFiles.some((file) => file.file_path === 'src/dead.ts'));

  await store.close();
  const db = openAtlasDatabase({ dbPath, migrationDir });
  const staleReferences = db.prepare(
    `SELECT COUNT(*) AS count FROM "references"
     WHERE workspace = ?
       AND (source_file IN (?, ?) OR target_file IN (?, ?))`,
  ).get(
    'fixture',
    'src/dead.ts',
    'src/rename/new-name.ts',
    'src/dead.ts',
    'src/rename/new-name.ts',
  ) as { count: number };
  assert.equal(staleReferences.count, 0);
  assert.deepEqual(db.prepare(
    `SELECT source_file, target_file FROM import_edges
     WHERE workspace = ? AND source_file = ?`,
  ).all('fixture', 'src/alias-consumer.ts'), [{
    source_file: 'src/alias-consumer.ts',
    target_file: 'src/math/add.ts',
  }]);
  assert.deepEqual(db.prepare(
    `SELECT source_file, target_file FROM import_edges
     WHERE workspace = ? AND source_file = ?`,
  ).all('fixture', 'src/outside-consumer.ts'), []);
  closeAtlasDatabase(dbPath);
});

test('watch batcher coalesces changes and emits a stable path order', async () => {
  let scheduled: (() => void) | undefined;
  const scheduler: AtlasWatchScheduler = {
    set(_delayMs, callback) {
      scheduled = callback;
      return callback;
    },
    clear(handle) {
      if (scheduled === handle) scheduled = undefined;
    },
  };
  const batches: AtlasWatchChange[][] = [];
  const batcher = new AtlasWatchBatcher((changes) => {
    batches.push(changes);
  }, { debounceMs: 25, scheduler });

  batcher.push({ kind: 'upsert', filePath: './src/z.ts' });
  batcher.push({ kind: 'upsert', filePath: 'src/a.ts' });
  batcher.push({ kind: 'delete', filePath: 'src/a.ts' });
  batcher.push({
    kind: 'upsert',
    filePath: 'src/new-name.ts',
    previousPath: 'src/old-name.ts',
  });
  assert.ok(scheduled);
  await batcher.flush();

  assert.deepEqual(batches, [[
    { kind: 'delete', filePath: 'src/a.ts' },
    { kind: 'upsert', filePath: 'src/new-name.ts', previousPath: 'src/old-name.ts' },
    { kind: 'delete', filePath: 'src/old-name.ts' },
    { kind: 'upsert', filePath: 'src/z.ts' },
  ]]);
  await batcher.close();
});

test('watch batcher accepts later work after a failed callback', async () => {
  const delivered: string[][] = [];
  let attempts = 0;
  const batcher = new AtlasWatchBatcher((changes) => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient consumer failure');
    delivered.push(changes.map((change) => change.filePath));
  }, { debounceMs: 60_000 });

  batcher.push({ kind: 'upsert', filePath: 'src/first.ts' });
  await assert.rejects(batcher.flush(), /transient consumer failure/);
  batcher.push({ kind: 'upsert', filePath: 'src/second.ts' });
  await batcher.flush();
  assert.deepEqual(delivered, [['src/second.ts']]);
  await batcher.close();
});
