import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeAtlasDatabase,
  insertAtlasChangelog,
  insertAtlasOperatorMemory,
  openAtlasDatabase,
} from '../db.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(testDir, '../../migrations');
const operatorMigration = '0017_operator_memory.sql';
const persistenceMigration = '0018_persistence_runtime.sql';
const writebackMigration = '0019_commit_evidence.sql';
const standalone010Migrations = [
  '0001_init.sql',
  '0002_changelog.sql',
  '0002_symbols_references.sql',
  '0003_atlas_metrics.sql',
  '0004_source_highlights.sql',
  '0005_source_chunks.sql',
  '0006_changelog_author_indexes.sql',
  '0007_changelog_recovery_key.sql',
  '0008_file_witnesses.sql',
  '0009_file_tags.sql',
  '0010_file_snapshots.sql',
  '0011_hazards_with_ranges.sql',
  '0012_jonah_memory.sql',
  '0013_symbol_identity.sql',
  '0014_changelog_model_attribution.sql',
  '0015_changelog_engine_type_attribution.sql',
  '0016_changelog_idempotency.sql',
] as const;

interface SchemaObject {
  type: string;
  name: string;
}

interface OperatorMemoryRow {
  id: number;
  workspace: string;
  changelog_id: number | null;
  file_path: string;
  note: string;
  category: string;
  confidence: string;
  evidence: string | null;
  author_instance_id: string | null;
  author_engine: string | null;
  author_name: string | null;
  source: string;
  review_status: string;
  dedupe_key: string;
  created_at: string;
}

async function withTempDirectory(
  prefix: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createLegacyMigrationDirectory(directory: string): Promise<string> {
  const legacyDir = path.join(directory, 'atlas-0.1.0-migrations');
  await mkdir(legacyDir, { recursive: true });

  const migrationFiles = (await readdir(migrationDir))
    .filter((filename) => filename.endsWith('.sql')
      && filename !== operatorMigration
      && filename !== persistenceMigration
      && filename !== writebackMigration)
    .sort();
  assert.deepEqual(migrationFiles, standalone010Migrations);

  await Promise.all(migrationFiles.map(async (filename) => {
    await copyFile(path.join(migrationDir, filename), path.join(legacyDir, filename));
  }));
  return legacyDir;
}

function schemaObjectsContaining(db: ReturnType<typeof openAtlasDatabase>, term: string): SchemaObject[] {
  return db.prepare(
    `SELECT type, name
       FROM sqlite_master
      WHERE lower(name) LIKE ?
      ORDER BY type, name`,
  ).all(`%${term.toLowerCase()}%`) as SchemaObject[];
}

test('fresh migration head exposes only operator-memory storage and indexes', async () => {
  await withTempDirectory('atlas-operator-memory-fresh-', async (directory) => {
    const dbPath = path.join(directory, 'atlas.sqlite');
    const db = openAtlasDatabase({ dbPath, migrationDir });

    try {
      assert.deepEqual(schemaObjectsContaining(db, 'jonah_memory'), []);
      assert.deepEqual(schemaObjectsContaining(db, 'operator_memory'), [
        { type: 'index', name: 'idx_operator_memory_category' },
        { type: 'index', name: 'idx_operator_memory_changelog' },
        { type: 'index', name: 'idx_operator_memory_dedupe' },
        { type: 'index', name: 'idx_operator_memory_workspace_created' },
        { type: 'table', name: 'atlas_operator_memory' },
      ]);

      const applied = db.prepare(
        'SELECT filename FROM atlas_schema_migrations ORDER BY filename',
      ).all() as Array<{ filename: string }>;
      assert.equal(applied.at(-1)?.filename, writebackMigration);

      const changelog = insertAtlasChangelog(db, {
        workspace: 'fresh',
        file_path: 'src/demo.ts',
        summary: 'Seed operator-memory relationship',
      });
      insertAtlasOperatorMemory(db, {
        workspace: 'fresh',
        changelog_id: changelog.id,
        file_path: 'src/demo.ts',
        note: 'Prefer deterministic upgrade fixtures.',
        category: 'workflow',
        confidence: 'high',
        evidence: 'fresh-head test',
        dedupe_key: 'workflow:deterministic-upgrades',
      });

      const stored = db.prepare(
        'SELECT changelog_id, dedupe_key FROM atlas_operator_memory',
      ).get() as { changelog_id: number; dedupe_key: string };
      assert.deepEqual(stored, {
        changelog_id: changelog.id,
        dedupe_key: 'workflow:deterministic-upgrades',
      });
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      closeAtlasDatabase(dbPath);
    }
  });
});

test('standalone 0.1.0 candidates survive the 0017 rename with relationships and dedupe state', async () => {
  await withTempDirectory('atlas-operator-memory-upgrade-', async (directory) => {
    const dbPath = path.join(directory, 'atlas.sqlite');
    const legacyMigrationDir = await createLegacyMigrationDirectory(directory);
    const legacyDb = openAtlasDatabase({ dbPath, migrationDir: legacyMigrationDir });

    const changelog = insertAtlasChangelog(legacyDb, {
      workspace: 'upgrade',
      file_path: 'src/legacy.ts',
      summary: 'Frozen 0.1.0 changelog row',
      idempotency_key: 'upgrade-changelog',
      idempotency_fingerprint: 'fixture-v1',
      created_at: '2026-06-16 12:00:00',
    });
    const legacyRows: Array<Omit<OperatorMemoryRow, 'id'>> = [
      {
        workspace: 'upgrade',
        changelog_id: changelog.id,
        file_path: 'src/legacy.ts',
        note: 'Keep append-only migration history.',
        category: 'boundary',
        confidence: 'high',
        evidence: '0.1.0 fixture evidence A',
        author_instance_id: 'fixture-instance',
        author_engine: 'fixture-engine',
        author_name: 'Fixture Author',
        source: 'atlas_commit',
        review_status: 'accepted',
        dedupe_key: 'boundary:append-only-migrations',
        created_at: '2026-06-16 12:01:00',
      },
      {
        workspace: 'upgrade',
        changelog_id: changelog.id,
        file_path: 'src/legacy.ts',
        note: 'Repeated evidence keeps the same non-unique dedupe key.',
        category: 'boundary',
        confidence: 'medium',
        evidence: '0.1.0 fixture evidence B',
        author_instance_id: 'fixture-instance-2',
        author_engine: 'fixture-engine',
        author_name: 'Fixture Author',
        source: 'atlas_commit',
        review_status: 'candidate',
        dedupe_key: 'boundary:append-only-migrations',
        created_at: '2026-06-16 12:02:00',
      },
    ];

    const insertLegacy = legacyDb.prepare(
      `INSERT INTO atlas_jonah_memory (
        workspace, changelog_id, file_path, note, category, confidence, evidence,
        author_instance_id, author_engine, author_name, source, review_status,
        dedupe_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of legacyRows) {
      insertLegacy.run(
        row.workspace,
        row.changelog_id,
        row.file_path,
        row.note,
        row.category,
        row.confidence,
        row.evidence,
        row.author_instance_id,
        row.author_engine,
        row.author_name,
        row.source,
        row.review_status,
        row.dedupe_key,
        row.created_at,
      );
    }
    assert.deepEqual(legacyDb.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    closeAtlasDatabase(dbPath);

    const upgradedDb = openAtlasDatabase({ dbPath, migrationDir });
    try {
      assert.deepEqual(schemaObjectsContaining(upgradedDb, 'jonah_memory'), []);
      assert.deepEqual(upgradedDb.pragma('foreign_key_check'), []);

      const upgradedRows = upgradedDb.prepare(
        `SELECT id, workspace, changelog_id, file_path, note, category, confidence,
                evidence, author_instance_id, author_engine, author_name, source,
                review_status, dedupe_key, created_at
           FROM atlas_operator_memory
          ORDER BY id`,
      ).all() as OperatorMemoryRow[];
      assert.deepEqual(
        upgradedRows.map(({ id: _id, ...row }) => row),
        legacyRows,
      );
      assert.deepEqual(
        upgradedRows.map((row) => row.id),
        [1, 2],
        'table rename must preserve row identity',
      );

      const dedupeIndex = upgradedDb.prepare(
        "SELECT name, [unique] AS is_unique FROM pragma_index_list('atlas_operator_memory') WHERE name = ?",
      ).get('idx_operator_memory_dedupe') as { name: string; is_unique: number };
      assert.deepEqual(dedupeIndex, {
        name: 'idx_operator_memory_dedupe',
        is_unique: 0,
      });

      const related = upgradedDb.prepare(
        `SELECT memory.changelog_id, changelog.id AS related_id
           FROM atlas_operator_memory AS memory
           JOIN atlas_changelog AS changelog ON changelog.id = memory.changelog_id
          ORDER BY memory.id`,
      ).all() as Array<{ changelog_id: number; related_id: number }>;
      assert.deepEqual(related, [
        { changelog_id: changelog.id, related_id: changelog.id },
        { changelog_id: changelog.id, related_id: changelog.id },
      ]);

      insertAtlasOperatorMemory(upgradedDb, {
        workspace: 'upgrade',
        changelog_id: changelog.id,
        file_path: 'src/current.ts',
        note: 'Current API writes the renamed table.',
        category: 'workflow',
        confidence: 'high',
        dedupe_key: 'workflow:current-api',
      });
      assert.equal(
        (upgradedDb.prepare('SELECT COUNT(*) AS count FROM atlas_operator_memory').get() as { count: number }).count,
        3,
      );
      assert.equal(
        (upgradedDb.prepare('SELECT COUNT(*) AS count FROM atlas_schema_migrations WHERE filename = ?').get(
          operatorMigration,
        ) as { count: number }).count,
        1,
      );
    } finally {
      closeAtlasDatabase(dbPath);
    }

    const reopenedDb = openAtlasDatabase({ dbPath, migrationDir });
    try {
      assert.equal(
        (reopenedDb.prepare('SELECT COUNT(*) AS count FROM atlas_operator_memory').get() as { count: number }).count,
        3,
      );
      assert.equal(
        (reopenedDb.prepare('SELECT COUNT(*) AS count FROM atlas_schema_migrations WHERE filename = ?').get(
          operatorMigration,
        ) as { count: number }).count,
        1,
      );
    } finally {
      closeAtlasDatabase(dbPath);
    }
  });
});
