import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { computeWorktreeStatus } from '../tools/worktree.js';
import type { AtlasDatabase } from '../db.js';
import type { AtlasRuntime } from '../types.js';

function createRuntime(sourceRoot: string, dbPath: string): AtlasRuntime {
  const fakeDb = {
    prepare: () => {
      throw new Error('runtime db handle should not be used for dbPath smoke');
    },
    pragma: () => undefined,
    exec: () => undefined,
    loadExtension: () => undefined,
    transaction: <F extends (...args: never[]) => unknown>(fn: F) => fn,
    close: () => undefined,
  } satisfies AtlasDatabase;

  return {
    config: {
      workspace: 'demo',
      sourceRoot,
      dbPath,
      concurrency: 1,
      sqliteVecExtension: '',
      embeddingModel: 'test-model',
      embeddingDimensions: 384,
    },
    db: fakeDb,
  };
}

test('computeWorktreeStatus opens dbPath options and reports untracked files', async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'atlas-worktree-source-'));
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'src', 'new.ts'), 'export const value = 1;\n', 'utf8');

  const dbPath = path.join(sourceRoot, '.atlas', 'atlas.sqlite');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.exec('CREATE TABLE atlas_files (workspace TEXT NOT NULL, file_path TEXT NOT NULL)');
  sqlite.close();

  const result = await computeWorktreeStatus(createRuntime(sourceRoot, dbPath), {
    includeUntracked: true,
    maxUntracked: 10,
    maxResults: 10,
    scanLimit: 100,
  });

  assert.ok(!('error' in result), 'worktree status should open the dbPath-backed database');
  if ('error' in result) return;
  assert.equal(result.checked_atlas_files, 0);
  assert.deepEqual(
    result.untracked_entries.map((entry) => entry.file_path),
    ['src/new.ts'],
  );
});
