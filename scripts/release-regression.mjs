import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeName(value) {
  return value.replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase();
}

async function hashFile(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

const artifactDir = path.resolve(argument('--artifact-dir') ?? path.join(projectRoot, 'artifacts', 'release-regression'));
const candidateDir = path.join(artifactDir, 'candidate');
const logDir = path.join(artifactDir, 'logs');
const consumerDir = path.join(artifactDir, 'consumer');
await rm(artifactDir, { recursive: true, force: true });
await mkdir(candidateDir, { recursive: true });
await mkdir(logDir, { recursive: true });

const stages = [];

async function runStage(name, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      shell: process.platform === 'win32' && command === npmCommand,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.stack ?? error.message}\n` });
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  const logPath = path.join(logDir, `${safeName(name)}.log`);
  await writeFile(
    logPath,
    [`$ ${command} ${args.join(' ')}`, result.stdout, result.stderr].filter(Boolean).join('\n'),
    'utf8',
  );
  const stage = {
    name,
    status: result.code === 0 ? 'passed' : 'failed',
    exit_code: result.code,
    signal: result.signal,
    started_at: startedAt,
    duration_ms: durationMs,
    log: path.relative(artifactDir, logPath).replaceAll(path.sep, '/'),
  };
  stages.push(stage);
  process.stdout.write(`${stage.status === 'passed' ? 'PASS' : 'FAIL'} ${name} (${durationMs} ms)\n`);
  return { ...result, stage };
}

function skipStage(name, reason) {
  const stage = { name, status: 'skipped', reason };
  stages.push(stage);
  process.stdout.write(`SKIP ${name}: ${reason}\n`);
  return stage;
}

const sbom = await runStage('sbom-check', npmCommand, ['run', 'sbom:check']);
const securityAudit = await runStage('security-audit', npmCommand, [
  'audit',
  '--omit=dev',
  '--audit-level=high',
  '--json',
]);
const check = await runStage('typecheck', npmCommand, ['run', 'check']);
const tests = await runStage('tests', npmCommand, ['test']);
const adapterTests = await runStage('adapter-tests', npmCommand, ['run', 'test:adapter']);
const adapterPackage = await runStage('adapter-package', npmCommand, ['run', 'test:adapter:package']);
const build = await runStage('build', npmCommand, ['run', 'build']);

let candidate;
let pack;
if (build.stage.status === 'passed') {
  pack = await runStage('pack', npmCommand, [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    candidateDir,
  ]);
  if (pack.stage.status === 'passed') {
    try {
      const result = JSON.parse(pack.stdout);
      if (!Array.isArray(result) || result.length !== 1 || typeof result[0].filename !== 'string') {
        throw new Error('npm pack JSON did not describe exactly one candidate artifact.');
      }
      const packageInfo = result[0];
      const tarballPath = path.join(candidateDir, packageInfo.filename);
      candidate = {
        path: tarballPath,
        filename: packageInfo.filename,
        sha256: await hashFile(tarballPath),
        size: packageInfo.size,
        unpacked_size: packageInfo.unpackedSize,
        file_count: Array.isArray(packageInfo.files) ? packageInfo.files.length : null,
      };
      await writeFile(path.join(artifactDir, 'package-info.json'), `${JSON.stringify(packageInfo, null, 2)}\n`, 'utf8');
    } catch (error) {
      pack.stage.status = 'failed';
      pack.stage.reason = error instanceof Error ? error.message : String(error);
    }
  }
} else {
  skipStage('pack', 'build failed');
}

if (candidate) {
  const smoke = await runStage('package-smoke', process.execPath, [
    path.join(projectRoot, 'scripts', 'package-smoke.mjs'),
    '--tarball',
    candidate.path,
    '--consumer-dir',
    consumerDir,
  ]);
  if (smoke.stage.status === 'passed') {
    await runStage('performance', process.execPath, [
      path.join(projectRoot, 'scripts', 'performance-gates.mjs'),
      '--tarball',
      candidate.path,
      '--package-info',
      path.join(artifactDir, 'package-info.json'),
      '--consumer-dir',
      consumerDir,
      '--report',
      path.join(artifactDir, 'performance.json'),
    ]);
  } else {
    skipStage('performance', 'candidate clean-install smoke failed');
  }
  await rm(consumerDir, { recursive: true, force: true });
} else {
  skipStage('package-smoke', 'candidate artifact unavailable');
  skipStage('performance', 'candidate artifact unavailable');
}

const failed = stages.filter((stage) => stage.status !== 'passed');
const summary = {
  schema_version: 1,
  status: failed.length === 0 ? 'passed' : 'failed',
  created_at: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch, node: process.version },
  candidate: candidate ? {
    filename: candidate.filename,
    sha256: candidate.sha256,
    size: candidate.size,
    unpacked_size: candidate.unpacked_size,
    file_count: candidate.file_count,
  } : null,
  stages,
};
await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (summary.status !== 'passed') process.exitCode = 1;
