import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

interface CommandResult { code: number | null; stdout: string; stderr: string }

async function atlas(args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', ...args], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI init, config, doctor, and invalid commands use clean stdout and stable exit codes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-cli-'));
  try {
    const init = await atlas(['init', root, '--no-index', '--format', 'json']);
    assert.equal(init.code, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).layout.sourceRoot, root);

    const config = await atlas(['config', 'show', '--source-root', root, '--format', 'json']);
    assert.equal(config.code, 0, config.stderr);
    assert.equal(JSON.parse(config.stdout).workspace, path.basename(root).toLowerCase());

    const doctor = await atlas(['doctor', '--source-root', root, '--format', 'json']);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).data.action, 'doctor');

    const invalid = await atlas(['unknown', '--source-root', root]);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /Unknown Atlas command/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
