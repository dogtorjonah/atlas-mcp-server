import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const preregistrationPath = path.resolve(
  argument('--preregistration')
    ?? path.join(projectRoot, 'docs', 'benchmarks', 'atlas-1.0-preregistration.json'),
);
const sourceRoot = path.resolve(argument('--source-root') ?? projectRoot);
const tarballPath = path.resolve(argument('--tarball') ?? '');
const runLabel = argument('--run-label') ?? 'unspecified';
const outputPath = path.resolve(
  argument('--output') ?? path.join(projectRoot, 'artifacts', 'navigation-benchmark', 'results.json'),
);
const runtimeRoot = path.join(path.dirname(outputPath), 'runtime');
const consumerRoot = path.join(runtimeRoot, 'consumer');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!argument('--tarball')) throw new Error('--tarball is required.');

async function run(command, args, cwd) {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32' && command === npmCommand,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => resolve({
      code: null,
      signal: null,
      stdout,
      stderr: `${stderr}${error.stack ?? error.message}\n`,
      duration_ms: performance.now() - started,
    }));
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout,
      stderr,
      duration_ms: performance.now() - started,
    }));
  });
}

async function checked(command, args, cwd) {
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

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function scoreTask(files, goldFiles) {
  const gold = new Set(goldFiles);
  const hits = files.filter((file) => gold.has(file));
  const firstRank = files.findIndex((file) => gold.has(file));
  return {
    recall_at_5: hits.length / goldFiles.length,
    reciprocal_rank: firstRank < 0 ? 0 : 1 / (firstRank + 1),
    success: hits.length > 0,
    matched_gold_files: hits,
  };
}

function summarize(tasks) {
  const count = tasks.length;
  return {
    task_count: count,
    macro_recall_at_5: round(tasks.reduce((sum, task) => sum + task.score.recall_at_5, 0) / count),
    mean_reciprocal_rank: round(tasks.reduce((sum, task) => sum + task.score.reciprocal_rank, 0) / count),
    tasks_with_any_gold: tasks.filter((task) => task.score.success).length,
    failures: tasks.filter((task) => task.failure !== null).length,
    mean_query_ms: round(tasks.reduce((sum, task) => sum + task.duration_ms, 0) / count),
    query_ms: tasks.map((task) => task.duration_ms),
  };
}

async function baselineTask(task) {
  const started = performance.now();
  const scores = new Map();
  const failures = [];
  for (const term of task.baseline_terms) {
    const result = await run('rg', [
      '--files-with-matches',
      '--fixed-strings',
      '--ignore-case',
      '--glob', '*.ts',
      '--glob', '*.mjs',
      '--glob', '*.sql',
      '--glob', '*.md',
      '--glob', '*.json',
      '--glob', '*.yml',
      '--glob', '*.yaml',
      '--glob', '!node_modules/**',
      '--glob', '!dist/**',
      '--glob', '!artifacts/**',
      '--glob', '!.atlas/**',
      '--glob', '!packages/context-warp-adapter/dist/**',
      '--',
      term,
      '.',
    ], sourceRoot);
    if (result.code !== 0 && result.code !== 1) {
      failures.push({ term, code: result.code, signal: result.signal, stderr: result.stderr });
      continue;
    }
    const files = result.stdout.split(/\r?\n/u)
      .map((file) => file.replace(/^\.\//u, '').replaceAll(path.sep, '/'))
      .filter(Boolean);
    for (const file of new Set(files)) scores.set(file, (scores.get(file) ?? 0) + 1);
  }
  const files = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([file]) => file);
  const duration = round(performance.now() - started);
  return {
    id: task.id,
    query: task.query,
    files,
    duration_ms: duration,
    failure: failures.length === 0 ? null : failures,
    warnings: [],
    evidence: null,
    score: scoreTask(files, task.gold_files),
  };
}

await mkdir(path.dirname(outputPath), { recursive: true });
const preregistration = JSON.parse(await readFile(preregistrationPath, 'utf8'));
assert.equal(preregistration.outcomes_observed, false, 'preregistration must predate outcomes');
assert.equal(preregistration.tasks.length, 12, 'benchmark task count is frozen at twelve');
const tarballHash = createHash('sha256').update(await readFile(tarballPath)).digest('hex');
assert.equal(tarballHash, preregistration.candidate.sha256, 'candidate tarball digest mismatch');

const rgVersion = (await checked('rg', ['--version'], sourceRoot)).stdout.split(/\r?\n/u)[0];
const baselineTasks = [];
for (const task of preregistration.tasks) baselineTasks.push(await baselineTask(task));

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(consumerRoot, { recursive: true });
await writeFile(
  path.join(consumerRoot, 'package.json'),
  `${JSON.stringify({ name: 'atlas-navigation-benchmark', private: true, type: 'module' }, null, 2)}\n`,
  'utf8',
);
const install = await checked(npmCommand, [
  'install',
  '--foreground-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  tarballPath,
], consumerRoot);

const atlasRoot = path.join(consumerRoot, 'node_modules', '@voxxo', 'atlas');
const atlas = await import(pathToFileURL(path.join(atlasRoot, 'dist', 'index.js')).href);
const databasePath = path.join(runtimeRoot, 'atlas.sqlite');
const host = await atlas.openAtlasNodeHost({
  sourceRoot,
  dbPath: databasePath,
  workspace: 'atlas-1.0-navigation-benchmark',
});

let indexResult;
const indexStarted = performance.now();
try {
  indexResult = await host.service.admin({ action: 'index', mode: 'full' }, { timeoutMs: 120_000 });
  const indexDurationMs = round(performance.now() - indexStarted);
  if (!indexResult.ok) throw new Error(`Atlas index failed: ${indexResult.error.code}: ${indexResult.error.message}`);

  const atlasTasks = [];
  for (const task of preregistration.tasks) {
    const started = performance.now();
    const result = await host.service.query({
      action: 'search',
      query: task.query,
      includeTestFiles: true,
      limit: 5,
    }, { timeoutMs: 30_000 });
    const duration = round(performance.now() - started);
    const files = result.ok
      ? result.data.items
        .map((item) => typeof item.file_path === 'string' ? item.file_path : null)
        .filter((file) => file !== null)
      : [];
    atlasTasks.push({
      id: task.id,
      query: task.query,
      files,
      duration_ms: duration,
      failure: result.ok ? null : result.error,
      warnings: result.meta.warnings,
      evidence: result.meta.evidence,
      score: scoreTask(files, task.gold_files),
    });
  }

  const baseline = { id: 'baseline-rg', tool: rgVersion, tasks: baselineTasks };
  baseline.summary = summarize(baseline.tasks);
  const treatment = {
    id: 'atlas-1-0',
    tool: preregistration.candidate.package,
    candidate_sha256: tarballHash,
    install_ms: round(install.duration_ms),
    index_ms: indexDurationMs,
    index_result: indexResult.data,
    tasks: atlasTasks,
  };
  treatment.summary = summarize(treatment.tasks);
  const delta = {
    macro_recall_at_5: round(treatment.summary.macro_recall_at_5 - baseline.summary.macro_recall_at_5),
    mean_reciprocal_rank: round(treatment.summary.mean_reciprocal_rank - baseline.summary.mean_reciprocal_rank),
    tasks_with_any_gold: treatment.summary.tasks_with_any_gold - baseline.summary.tasks_with_any_gold,
    mean_query_ms: round(treatment.summary.mean_query_ms - baseline.summary.mean_query_ms),
  };
  const verdict = treatment.summary.macro_recall_at_5 >= preregistration.metrics.acceptance.atlas_macro_recall_at_5_minimum
    && delta.macro_recall_at_5 > 0
    ? 'treatment_passed_preregistered_point_estimate_gate'
    : 'treatment_did_not_pass_preregistered_point_estimate_gate';
  const output = {
    schema_version: 1,
    benchmark_id: preregistration.benchmark_id,
    run_label: runLabel,
    observed_at: new Date().toISOString(),
    source_root: sourceRoot,
    preregistration: path.relative(projectRoot, preregistrationPath).replaceAll(path.sep, '/'),
    model: null,
    provider: null,
    token_telemetry: null,
    cost: { value: 0, unit: 'usd', basis: 'No model or paid provider was invoked.' },
    baseline,
    treatment,
    delta,
    verdict,
    limitations: [
      'The twelve tasks and gold files were authored from one repository and are not a population sample.',
      'The baseline is deterministic ripgrep file retrieval, not the frozen 0.1 Atlas implementation or an agent using arbitrary shell exploration.',
      'Wall latency includes different work: ripgrep performs per-query scans while Atlas pays a separate one-time install and index cost.',
      'The source tree is the promotion working tree rather than a clean public release commit.',
      'No LLM judge or provider was used; token and provider-cost comparisons are not applicable.',
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    verdict,
    baseline: baseline.summary,
    treatment: treatment.summary,
    delta,
    output: outputPath,
  })}\n`);
} finally {
  await host.close();
}
