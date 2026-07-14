import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');

async function runTypeScriptBuild() {
  const tscPath = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath, '-p', 'tsconfig.build.json'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`TypeScript build failed (${signal ?? `exit ${code}`})`));
    });
  });
}

await rm(distDir, { recursive: true, force: true });
await runTypeScriptBuild();
await mkdir(path.join(distDir, 'pipeline'), { recursive: true });
await cp(
  path.join(projectRoot, 'src', 'pipeline', 'prompts'),
  path.join(distDir, 'pipeline', 'prompts'),
  { recursive: true },
);
