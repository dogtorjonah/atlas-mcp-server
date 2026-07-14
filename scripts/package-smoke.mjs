import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function run(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runChecked(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.code !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed (${result.signal ?? `exit ${result.code}`})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'atlas-package-smoke-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');

try {
  await runChecked('npm', ['run', 'build'], projectRoot);
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });

  const pack = await runChecked(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
    projectRoot,
  );
  const packResult = JSON.parse(pack.stdout);
  assert.equal(packResult.length, 1, 'npm pack must produce exactly one tarball');

  const packageInfo = packResult[0];
  assert.equal(typeof packageInfo.filename, 'string');
  const tarballPath = path.join(packDir, packageInfo.filename);

  await writeFile(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'atlas-package-smoke-consumer', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  await runChecked(
    'npm',
    ['install', '--no-audit', '--no-fund', '--package-lock=false', tarballPath],
    consumerDir,
  );

  const runnerPath = path.join(consumerDir, 'smoke.mjs');
  await writeFile(runnerPath, `
import assert from 'node:assert/strict';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const consumerRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(consumerRoot, 'node_modules', '@voxxo', 'atlas');
const rootApi = await import('@voxxo/atlas');
const dbApi = await import('@voxxo/atlas/db');
const typesApi = await import('@voxxo/atlas/types');
const pathsApi = await import('@voxxo/atlas/paths');
const pipelineApi = await import('@voxxo/atlas/pipeline');
const persistenceApi = await import('@voxxo/atlas/persistence');
const indexingApi = await import('@voxxo/atlas/indexing');

assert.equal(typeof rootApi.openAtlasDatabase, 'function');
assert.equal(typeof dbApi.openAtlasDatabase, 'function');
assert.equal(typeof typesApi, 'object');
assert.equal(typeof pathsApi.getAtlasCoreMigrationsDir, 'function');
assert.equal(typeof pipelineApi.runFullPipeline, 'function');
assert.equal(typeof rootApi.openSqliteAtlasStore, 'function');
assert.equal(typeof persistenceApi.openSqliteAtlasStore, 'function');
assert.equal(typeof rootApi.AtlasWatchBatcher, 'function');
assert.equal(typeof indexingApi.watchAtlasRepository, 'function');

const expectedMigrations = [
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
  '0017_operator_memory.sql',
  '0018_persistence_runtime.sql',
];
const migrationDir = pathsApi.getAtlasCoreMigrationsDir();
assert.equal(migrationDir, path.join(packageRoot, 'migrations'));
assert.deepEqual((await readdir(migrationDir)).sort(), expectedMigrations);

const dbPath = path.join(consumerRoot, 'fresh.sqlite');
const db = rootApi.openAtlasDatabase({ dbPath, migrationDir });
const applied = db.prepare(
  'SELECT filename FROM atlas_schema_migrations ORDER BY filename ASC',
).all().map((row) => row.filename);
assert.deepEqual(applied, expectedMigrations);
assert.deepEqual(db.prepare(
  "SELECT type, name FROM sqlite_master WHERE lower(name) LIKE '%jonah_memory%' ORDER BY type, name",
).all(), []);
assert.deepEqual(db.prepare(
  "SELECT type, name FROM sqlite_master WHERE lower(name) LIKE '%operator_memory%' ORDER BY type, name",
).all(), [
  { type: 'index', name: 'idx_operator_memory_category' },
  { type: 'index', name: 'idx_operator_memory_changelog' },
  { type: 'index', name: 'idx_operator_memory_dedupe' },
  { type: 'index', name: 'idx_operator_memory_workspace_created' },
  { type: 'table', name: 'atlas_operator_memory' },
]);
assert.deepEqual(db.prepare(
  "SELECT type, name FROM sqlite_master WHERE lower(name) LIKE '%therapy%' ORDER BY type, name",
).all(), []);
db.close();
await rm(dbPath, { force: true });

const workerDbPath = path.join(consumerRoot, 'worker.sqlite');
const store = await persistenceApi.openSqliteAtlasStore({
  dbPath: workerDbPath,
  migrationDir,
});
assert.equal((await store.health()).migrationHead, '0018_persistence_runtime.sql');
assert.equal(typeof store.indexRepository, 'function');
await store.close();
await rm(workerDbPath, { force: true });

assert.deepEqual(
  (await readdir(path.join(packageRoot, 'dist', 'pipeline', 'prompts'))).sort(),
  ['pass05.txt', 'pass1.txt', 'pass2.txt'],
);
await access(path.join(consumerRoot, 'node_modules', '.bin', 'atlas'));
await access(path.join(consumerRoot, 'node_modules', '.bin', 'atlas-mcp'));
await access(path.join(packageRoot, 'README.md'));
await access(path.join(packageRoot, 'ARCHITECTURE.md'));
await access(path.join(packageRoot, 'PUBLIC_API.md'));
await access(path.join(packageRoot, 'LICENSE'));
await access(path.join(packageRoot, 'THIRD_PARTY_NOTICES.md'));

async function walk(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await walk(path.join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

const installedFiles = await walk(packageRoot);
const allowedRoots = new Set([
  'LICENSE',
  'ARCHITECTURE.md',
  'PUBLIC_API.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'migrations',
  'package.json',
]);
for (const file of installedFiles) {
  assert.ok(allowedRoots.has(file.split('/')[0]), 'unexpected package file: ' + file);
  assert.ok(!file.includes('__tests__'), 'test file escaped package allowlist: ' + file);
  assert.ok(!file.endsWith('.map'), 'source map escaped release build: ' + file);
  assert.ok(!file.endsWith('.tsbuildinfo'), 'compiler cache escaped package allowlist: ' + file);
  assert.ok(!file.startsWith('migrations/migrations/'), 'nested migration escaped allowlist: ' + file);
}

const installedManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
assert.deepEqual(installedManifest.files, [
  'dist',
  'migrations/*.sql',
  'README.md',
  'ARCHITECTURE.md',
  'PUBLIC_API.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]);

console.log(JSON.stringify({
  package: installedManifest.name + '@' + installedManifest.version,
  entrypoints: ['.', './db', './types', './paths', './pipeline', './persistence', './indexing'],
  bins: ['atlas', 'atlas-mcp'],
  migrations: applied.length,
  files: installedFiles.length,
}));
`, 'utf8');

  const smoke = await runChecked(process.execPath, [runnerPath], consumerDir);
  process.stdout.write(smoke.stdout);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
