import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

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
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
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

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

const reportPath = path.resolve(argument('--report') ?? path.join(projectRoot, 'artifacts', 'performance.json'));
const budgetPath = path.resolve(argument('--budgets') ?? path.join(projectRoot, 'test', 'performance-budgets.json'));
const suppliedTarball = argument('--tarball');
const packageInfoPath = argument('--package-info');
const suppliedConsumer = argument('--consumer-dir');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'atlas-performance-'));
const candidateDir = path.join(tempRoot, 'candidate');
const consumerDir = suppliedConsumer ? path.resolve(suppliedConsumer) : path.join(tempRoot, 'consumer');
const repositoryDir = path.join(tempRoot, 'repository');
let host;
let queueStore;
let report;

try {
  await mkdir(candidateDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });
  let tarballPath;
  let packageInfo;
  if (suppliedTarball) {
    tarballPath = path.resolve(suppliedTarball);
    packageInfo = packageInfoPath
      ? JSON.parse(await readFile(path.resolve(packageInfoPath), 'utf8'))
      : { size: (await stat(tarballPath)).size, unpackedSize: null };
  } else {
    await runChecked(npmCommand, ['run', 'build'], projectRoot);
    const packed = await runChecked(
      npmCommand,
      ['pack', '--ignore-scripts', '--json', '--pack-destination', candidateDir],
      projectRoot,
    );
    const results = JSON.parse(packed.stdout);
    if (!Array.isArray(results) || results.length !== 1) throw new Error('npm pack did not produce one candidate.');
    packageInfo = results[0];
    tarballPath = path.join(candidateDir, packageInfo.filename);
  }

  if (!suppliedConsumer) {
    await writeFile(
      path.join(consumerDir, 'package.json'),
      `${JSON.stringify({ name: 'atlas-performance-consumer', private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );
    await runChecked(
      npmCommand,
      ['install', '--no-audit', '--no-fund', '--package-lock=false', tarballPath],
      consumerDir,
    );
  }
  await cp(path.join(projectRoot, 'test', 'fixtures', 'repositories', 'medium'), repositoryDir, {
    recursive: true,
    dereference: false,
  });

  const packageRoot = path.join(consumerDir, 'node_modules', '@voxxo', 'atlas');
  const nodeApi = await import(pathToFileURL(path.join(packageRoot, 'dist', 'node', 'index.js')).href);
  const persistenceApi = await import(pathToFileURL(path.join(packageRoot, 'dist', 'persistence', 'index.js')).href);
  const pathsApi = await import(pathToFileURL(path.join(packageRoot, 'dist', 'paths.js')).href);
  const rssBefore = process.memoryUsage().rss;

  host = await nodeApi.openAtlasNodeHost({
    sourceRoot: repositoryDir,
    workspace: 'performance-fixture',
    dataRoot: path.join(tempRoot, 'data'),
    concurrency: 2,
  });
  const indexStarted = performance.now();
  const indexResult = await host.service.admin({ action: 'index', full: true });
  const indexMs = performance.now() - indexStarted;
  if (!indexResult.ok) throw new Error(`Initial index failed: ${indexResult.error.code}`);
  const filesProcessed = indexResult.data.filesProcessed;
  if (filesProcessed < 1) throw new Error('Initial index did not process any files.');
  const dbBytes = (await stat(host.layout.dbPath)).size;
  await host.close();
  host = undefined;

  host = await nodeApi.openAtlasNodeHost({
    sourceRoot: repositoryDir,
    workspace: 'performance-fixture',
    dataRoot: path.join(tempRoot, 'data'),
    concurrency: 2,
  });
  const coldStarted = performance.now();
  const coldResult = await host.service.query({ action: 'search', query: 'user', limit: 10 });
  const coldQueryMs = performance.now() - coldStarted;
  if (!coldResult.ok) throw new Error(`Cold query failed: ${coldResult.error.code}`);

  const warmLatencies = [];
  for (let index = 0; index < 25; index += 1) {
    const started = performance.now();
    const result = await host.service.query({ action: 'search', query: index % 2 ? 'user' : 'service', limit: 10 });
    warmLatencies.push(performance.now() - started);
    if (!result.ok) throw new Error(`Warm query failed: ${result.error.code}`);
  }

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const mixedStarted = performance.now();
  const mixedOperations = [
    host.service.admin({ action: 'index' }),
    host.service.commit({
      filePath: 'src/index.ts',
      changelogEntry: 'Exercise atomic semantic writeback during the mixed-load release gate.',
      idempotencyKey: 'performance-mixed-write',
      purpose: 'Synthetic fixture entrypoint used for public release performance validation.',
      blurb: 'Synthetic performance fixture entrypoint.',
      tags: ['fixture', 'performance'],
      sourceHighlights: [{ id: 1, label: 'Entry', startLine: 1, endLine: 8 }],
    }),
    ...Array.from({ length: 30 }, (_, index) => host.service.query({
      action: 'search',
      query: index % 2 ? 'account' : 'repository',
      limit: 10,
    })),
  ];
  const mixedResults = await Promise.all(mixedOperations);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const mixedLoadMs = performance.now() - mixedStarted;
  delay.disable();
  for (const result of mixedResults) {
    if (!result.ok) throw new Error(`Mixed-load operation failed: ${result.error.code}`);
  }

  const queueDbPath = path.join(tempRoot, 'queue.sqlite');
  queueStore = await persistenceApi.openSqliteAtlasStore({
    dbPath: queueDbPath,
    migrationDir: pathsApi.getAtlasCoreMigrationsDir(),
    maxQueued: 1,
    maxInFlightReads: 1,
  });
  const indexing = queueStore.indexRepository({
    workspace: 'queue-fixture',
    sourceRoot: repositoryDir,
    mode: 'full',
    concurrency: 1,
  });
  const issuedAt = performance.now();
  const backpressure = [];
  const queuedReads = Array.from({ length: 12 }, () => queueStore.health().catch((error) => {
    backpressure.push({ code: error?.code, elapsedMs: performance.now() - issuedAt });
    return undefined;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await indexing;
  await Promise.all(queuedReads);
  if (!backpressure.some((entry) => entry.code === 'ATLAS_BACKPRESSURE')) {
    throw new Error('Bounded queue did not surface ATLAS_BACKPRESSURE under saturation.');
  }
  const queueBackpressureMs = Math.max(
    ...backpressure.filter((entry) => entry.code === 'ATLAS_BACKPRESSURE').map((entry) => entry.elapsedMs),
  );
  await queueStore.close();
  queueStore = undefined;

  const shutdownStarted = performance.now();
  await host.close();
  host = undefined;
  const shutdownMs = performance.now() - shutdownStarted;
  const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
  const budgets = JSON.parse(await readFile(budgetPath, 'utf8'));
  const metrics = {
    cold_query_ms: round(coldQueryMs),
    warm_query_p95_ms: round(percentile(warmLatencies, 0.95)),
    mixed_load_event_loop_p99_ms: round(delay.percentile(99) / 1_000_000),
    mixed_load_total_ms: round(mixedLoadMs),
    index_files_per_second: round(filesProcessed / Math.max(indexMs / 1000, 0.001)),
    database_bytes_per_file: round(dbBytes / filesProcessed),
    rss_growth_bytes: rssGrowthBytes,
    queue_backpressure_ms: round(queueBackpressureMs),
    shutdown_ms: round(shutdownMs),
    package_tarball_bytes: packageInfo.size ?? (await stat(tarballPath)).size,
    package_unpacked_bytes: packageInfo.unpackedSize,
  };
  const checks = [
    ['cold_query_ms', '<=', 'cold_query_ms_max'],
    ['warm_query_p95_ms', '<=', 'warm_query_p95_ms_max'],
    ['mixed_load_event_loop_p99_ms', '<=', 'mixed_load_event_loop_p99_ms_max'],
    ['mixed_load_total_ms', '<=', 'mixed_load_total_ms_max'],
    ['index_files_per_second', '>=', 'index_files_per_second_min'],
    ['database_bytes_per_file', '<=', 'database_bytes_per_file_max'],
    ['rss_growth_bytes', '<=', 'rss_growth_bytes_max'],
    ['queue_backpressure_ms', '<=', 'queue_backpressure_ms_max'],
    ['shutdown_ms', '<=', 'shutdown_ms_max'],
    ['package_tarball_bytes', '<=', 'package_tarball_bytes_max'],
    ['package_unpacked_bytes', '<=', 'package_unpacked_bytes_max'],
  ].map(([metric, operator, budget]) => ({
    metric,
    operator,
    actual: metrics[metric],
    budget: budgets[budget],
    pass: operator === '<=' ? metrics[metric] <= budgets[budget] : metrics[metric] >= budgets[budget],
  }));
  report = {
    schema_version: 1,
    status: checks.every((check) => check.pass) ? 'passed' : 'failed',
    platform: { os: process.platform, arch: process.arch, node: process.version },
    candidate: { path: path.basename(tarballPath), sha256: await sha256(tarballPath) },
    fixture: { files_processed: filesProcessed, database_bytes: dbBytes },
    budgets,
    metrics,
    checks,
  };
  if (report.status !== 'passed') {
    const failures = checks.filter((check) => !check.pass).map((check) => `${check.metric}=${check.actual} ${check.operator} ${check.budget}`);
    throw new Error(`Performance budgets failed: ${failures.join(', ')}`);
  }
} catch (error) {
  report ??= {
    schema_version: 1,
    status: 'failed',
    platform: { os: process.platform, arch: process.arch, node: process.version },
    error: error instanceof Error ? error.message : String(error),
  };
  process.exitCode = 1;
} finally {
  await queueStore?.close().catch(() => undefined);
  await host?.close().catch(() => undefined);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  await rm(tempRoot, { recursive: true, force: true });
}
