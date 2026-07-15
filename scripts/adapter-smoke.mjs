import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(projectRoot, 'packages', 'context-warp-adapter');
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
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function checked(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.code !== 0) {
    throw new Error([`${command} ${args.join(' ')} failed (${result.signal ?? `exit ${result.code}`})`, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
  return result;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'atlas-context-warp-adapter-'));
try {
  const packDir = path.join(tempRoot, 'pack');
  const consumerDir = path.join(tempRoot, 'consumer');
  await mkdir(packDir, { recursive: true });
  await mkdir(consumerDir, { recursive: true });
  await rm(path.join(packageRoot, 'dist'), { recursive: true, force: true });
  await checked(npmCommand, ['run', 'build'], packageRoot);
  const packed = await checked(npmCommand, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', packDir,
  ], packageRoot);
  const packInfo = JSON.parse(packed.stdout);
  assert.equal(packInfo.length, 1);
  assert.equal(packInfo[0].name, '@voxxo/atlas-context-warp');
  assert.equal(packInfo[0].version, '1.0.0');
  const packedFiles = packInfo[0].files.map((file) => file.path).sort();
  assert.deepEqual(packedFiles, [
    'LICENSE',
    'README.md',
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]);

  await writeFile(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'atlas-adapter-consumer', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  const tarball = path.join(packDir, packInfo[0].filename);
  await checked(npmCommand, [
    'install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], consumerDir);

  const runner = path.join(consumerDir, 'smoke.mjs');
  await writeFile(runner, `
import assert from 'node:assert/strict';
import { foldReceiptToAtlasEvidence } from '@voxxo/atlas-context-warp';

const digest = (value) => 'sha256:' + value.repeat(64);
const evidence = foldReceiptToAtlasEvidence({
  version: 1,
  kind: 'fold-prepare-receipt',
  subject: { turnCount: 1, messageCount: 2 },
  input: { rawHistoryDigest: digest('1'), messageCount: 2 },
  fold: {
    strategy: 'rolling-fold', foldedViewDigest: digest('2'), preparedMessageCount: 1,
    frozenPrefixDigest: null, sealedBoundary: null, cacheHot: false, epochs: 1, hotReuses: 0,
  },
  privacy: { receiptEmbedsRawContent: false, digestsOnly: true, foldedViewDerivedFromRawHistory: true },
  staleIf: ['raw_history_digest_changed'],
}, {
  workspace: 'demo', subjectKey: 'prepare:1', contextWarpVersion: '0.1.0',
  observedAt: '2026-07-14T00:00:00.000Z',
});
assert.equal(evidence.namespace, 'context-warp-drive/fold-prepare-receipt');
assert.match(evidence.payloadHash, /^sha256:[a-f0-9]{64}$/u);
console.log(JSON.stringify({ evidence_id: evidence.evidenceId, payload_hash: evidence.payloadHash }));
`, 'utf8');
  const smoke = await checked(process.execPath, [runner], consumerDir);
  const installedRoot = path.join(consumerDir, 'node_modules', '@voxxo', 'atlas-context-warp');
  const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.peerDependencies, {
    '@voxxo/atlas': '^1.0.0',
    'context-warp-drive': '^0.1.0',
  });
  assert.deepEqual((await readdir(installedRoot)).sort(), ['LICENSE', 'README.md', 'dist', 'package.json']);
  process.stdout.write(smoke.stdout);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
