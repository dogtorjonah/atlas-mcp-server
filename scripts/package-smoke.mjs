import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tarballArgument = process.argv.indexOf('--tarball');
const suppliedTarball = tarballArgument >= 0 ? process.argv[tarballArgument + 1] : undefined;
if (tarballArgument >= 0 && !suppliedTarball) {
  throw new Error('--tarball requires a path.');
}
const consumerArgument = process.argv.indexOf('--consumer-dir');
const suppliedConsumer = consumerArgument >= 0 ? process.argv[consumerArgument + 1] : undefined;
if (consumerArgument >= 0 && !suppliedConsumer) {
  throw new Error('--consumer-dir requires a path.');
}
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function run(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32' && command === npmCommand,
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
const consumerDir = suppliedConsumer ? path.resolve(suppliedConsumer) : path.join(tempRoot, 'consumer');

try {
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });
  let tarballPath;
  if (suppliedTarball) {
    tarballPath = path.resolve(suppliedTarball);
    await access(tarballPath);
  } else {
    await runChecked(npmCommand, ['run', 'build'], projectRoot);
    const pack = await runChecked(
      npmCommand,
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
      projectRoot,
    );
    const packResult = JSON.parse(pack.stdout);
    assert.equal(packResult.length, 1, 'npm pack must produce exactly one tarball');
    const packageInfo = packResult[0];
    assert.equal(typeof packageInfo.filename, 'string');
    tarballPath = path.join(packDir, packageInfo.filename);
  }

  await writeFile(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'atlas-package-smoke-consumer', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  await runChecked(
    npmCommand,
    [
      'install',
      '--foreground-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
    ],
    consumerDir,
  );

  const typeSmokePath = path.join(consumerDir, 'type-smoke.ts');
  await writeFile(typeSmokePath, `
import {
  createAtlasService,
  openAtlasNodeHost,
  type AtlasCommitRequest,
  type AtlasOperationOptions,
  type AtlasQueryData,
  type AtlasQueryRequest,
  type AtlasResult,
} from '@voxxo/atlas';
import type { AtlasGraphRequest } from '@voxxo/atlas/service';

const query: AtlasQueryRequest = { action: 'search', query: 'type smoke' };
const graph: AtlasGraphRequest = { action: 'impact', filePath: 'src/index.ts' };
const commit: AtlasCommitRequest = {
  filePath: 'src/index.ts',
  changelogEntry: 'Type consumer smoke',
};
const options: AtlasOperationOptions = { timeoutMs: 1_000 };
declare const result: AtlasResult<AtlasQueryData>;
void [createAtlasService, openAtlasNodeHost, query, graph, commit, options, result];
`, 'utf8');
  await runChecked(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck', 'false',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--typeRoots', path.join(projectRoot, 'node_modules', '@types'),
    typeSmokePath,
  ], consumerDir);

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
const serviceApi = await import('@voxxo/atlas/service');
const writebackApi = await import('@voxxo/atlas/writeback');
const adminApi = await import('@voxxo/atlas/admin');
const embeddingApi = await import('@voxxo/atlas/embedding');
const mcpApi = await import('@voxxo/atlas/mcp');
const nodeApi = await import('@voxxo/atlas/node');

assert.equal(typeof rootApi.openAtlasDatabase, 'function');
assert.equal(typeof dbApi.openAtlasDatabase, 'function');
assert.equal(typeof typesApi, 'object');
assert.equal(typeof pathsApi.getAtlasCoreMigrationsDir, 'function');
assert.equal(typeof pipelineApi.runFullPipeline, 'function');
assert.equal(typeof rootApi.openSqliteAtlasStore, 'function');
assert.equal(typeof persistenceApi.openSqliteAtlasStore, 'function');
assert.equal(typeof rootApi.AtlasWatchBatcher, 'function');
assert.equal(typeof indexingApi.watchAtlasRepository, 'function');
assert.equal(typeof rootApi.createAtlasService, 'function');
assert.equal(typeof serviceApi.createAtlasService, 'function');
assert.equal(typeof writebackApi.executeAtlasCommit, 'function');
assert.equal(typeof adminApi, 'object');
assert.equal(typeof embeddingApi.AtlasEmbeddingController, 'function');
assert.equal(typeof mcpApi.createAtlasMcpServer, 'function');
assert.equal(typeof nodeApi.openAtlasNodeHost, 'function');
assert.equal(rootApi.createSqliteAtlasStore, persistenceApi.createSqliteAtlasStore);

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
  '0019_commit_evidence.sql',
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
assert.equal((await store.health()).migrationHead, '0019_commit_evidence.sql');
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
await access(path.join(packageRoot, 'CHANGELOG.md'));
await access(path.join(packageRoot, 'CONTRIBUTING.md'));
await access(path.join(packageRoot, 'SECURITY.md'));
await access(path.join(packageRoot, 'UPGRADING.md'));
await access(path.join(packageRoot, 'LICENSE'));
await access(path.join(packageRoot, 'RELICENSE_AUDIT.md'));
await access(path.join(packageRoot, 'THIRD_PARTY_NOTICES.md'));
await access(path.join(packageRoot, 'docs', 'TOOLS.md'));
await access(path.join(packageRoot, 'docs', 'DATA_HANDLING.md'));
await access(path.join(packageRoot, 'examples', 'quickstart.mjs'));
await access(path.join(packageRoot, 'examples', 'mcp-config.json'));
await access(path.join(packageRoot, 'sbom.cdx.json'));
assert.deepEqual(
  JSON.parse(await readFile(path.join(packageRoot, 'examples', 'mcp-config.json'), 'utf8')),
  {
    mcpServers: {
      atlas: {
        command: 'npx',
        args: [
          '--yes',
          '--package',
          '@voxxo/atlas@1',
          'atlas',
          'mcp',
          '--source-root',
          '/absolute/path/to/repository',
        ],
      },
    },
  },
  );

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
  'RELICENSE_AUDIT.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'UPGRADING.md',
  'THIRD_PARTY_NOTICES.md',
  'docs',
  'dist',
  'examples',
  'migrations',
  'package.json',
  'sbom.cdx.json',
]);
for (const file of installedFiles) {
  assert.ok(allowedRoots.has(file.split('/')[0]), 'unexpected package file: ' + file);
  assert.ok(!file.includes('__tests__'), 'test file escaped package allowlist: ' + file);
  assert.ok(!file.endsWith('.map'), 'source map escaped release build: ' + file);
  assert.ok(!file.endsWith('.tsbuildinfo'), 'compiler cache escaped package allowlist: ' + file);
  assert.ok(!file.startsWith('migrations/migrations/'), 'nested migration escaped allowlist: ' + file);
}

const installedManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(installedManifest.version, '1.0.0');
assert.equal(installedManifest.license, 'MIT');
assert.equal(installedManifest.repository.url, 'git+https://github.com/dogtorjonah/atlas-mcp-server.git');
assert.deepEqual(installedManifest.files, [
  'dist',
  'migrations/*.sql',
  'README.md',
  'ARCHITECTURE.md',
  'PUBLIC_API.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'UPGRADING.md',
  'LICENSE',
  'RELICENSE_AUDIT.md',
  'THIRD_PARTY_NOTICES.md',
  'docs',
  'examples',
  'sbom.cdx.json',
]);
const licenseText = await readFile(path.join(packageRoot, 'LICENSE'), 'utf8');
assert.match(licenseText, /^MIT License\\n/u);
assert.ok(!licenseText.includes('GNU AFFERO'));
const sbom = JSON.parse(await readFile(path.join(packageRoot, 'sbom.cdx.json'), 'utf8'));
assert.equal(sbom.bomFormat, 'CycloneDX');
assert.equal(sbom.metadata.component.name, 'atlas');
assert.equal(sbom.metadata.component.version, installedManifest.version);
assert.equal(sbom.metadata.component.licenses[0].license.name, installedManifest.license);
assert.ok(sbom.components.length > 50);

console.log(JSON.stringify({
  package: installedManifest.name + '@' + installedManifest.version,
  entrypoints: ['.', './db', './types', './paths', './pipeline', './persistence', './indexing', './service', './writeback', './admin', './embedding', './mcp', './node'],
  bins: ['atlas', 'atlas-mcp'],
  migrations: applied.length,
  files: installedFiles.length,
}));
`, 'utf8');

  const smoke = await runChecked(process.execPath, [runnerPath], consumerDir);
  process.stdout.write(smoke.stdout);

  const exampleRepository = path.join(tempRoot, 'example-repository');
  await mkdir(path.join(exampleRepository, 'src'), { recursive: true });
  await writeFile(
    path.join(exampleRepository, 'package.json'),
    JSON.stringify({ name: 'atlas-example-repository', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(exampleRepository, 'src', 'index.ts'),
    'export function greet(name: string): string { return `Hello, ${name}`; }\n',
    'utf8',
  );
  const installedPackageRoot = path.join(consumerDir, 'node_modules', '@voxxo', 'atlas');
  const example = await runChecked(
    process.execPath,
    [path.join(installedPackageRoot, 'examples', 'quickstart.mjs'), exampleRepository],
    consumerDir,
  );
  assert.equal(JSON.parse(example.stdout).sourceRoot, exampleRepository);
  const cli = await runChecked(
    process.execPath,
    [
      path.join(installedPackageRoot, 'dist', 'server.js'),
      'doctor', '--source-root', exampleRepository, '--format', 'json',
    ],
    consumerDir,
  );
  assert.equal(JSON.parse(cli.stdout).ok, true);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
