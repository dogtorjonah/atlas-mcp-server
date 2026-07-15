import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeWorkspaceName } from '../core/paths.js';

export type AtlasDataMode = 'project' | 'user';

export interface AtlasNodeLayoutOptions {
  sourceRoot: string;
  workspace?: string;
  dataMode?: AtlasDataMode;
  dataRoot?: string;
  dbPath?: string;
}

export interface AtlasRepositoryIdentity {
  version: 1;
  workspace: string;
  sourceRoot: string;
  repositoryKey: string;
  dataMode: AtlasDataMode;
}

export interface AtlasNodeLayout {
  sourceRoot: string;
  workspace: string;
  dataMode: AtlasDataMode;
  dataDir: string;
  dbPath: string;
  backupDir: string;
  lockPath: string;
  identityPath: string;
  repositoryKey: string;
}

function defaultUserStateRoot(): string {
  const configured = process.env.XDG_STATE_HOME?.trim();
  return configured ? path.resolve(configured, 'atlas') : path.join(homedir(), '.local', 'state', 'atlas');
}

function repositoryKey(sourceRoot: string): string {
  return createHash('sha256').update(sourceRoot.normalize('NFC')).digest('hex');
}

export async function resolveAtlasNodeLayout(options: AtlasNodeLayoutOptions): Promise<AtlasNodeLayout> {
  const sourceRoot = await realpath(path.resolve(options.sourceRoot));
  const requestedWorkspace = options.workspace ?? path.basename(sourceRoot).toLowerCase();
  const canonical = canonicalizeWorkspaceName(requestedWorkspace);
  if (!canonical.ok) throw new Error(canonical.message);
  const dataMode = options.dataMode ?? 'project';
  const key = repositoryKey(sourceRoot);
  const dataDir = path.resolve(options.dataRoot ?? (dataMode === 'project'
    ? path.join(sourceRoot, '.atlas')
    : path.join(defaultUserStateRoot(), 'repositories', `${canonical.name}-${key.slice(0, 12)}`)));
  const dbPath = path.resolve(options.dbPath ?? path.join(dataDir, 'atlas.sqlite'));
  return {
    sourceRoot,
    workspace: canonical.name,
    dataMode,
    dataDir,
    dbPath,
    backupDir: path.join(dataDir, 'backups'),
    lockPath: `${dbPath}.lock`,
    identityPath: path.join(dataDir, 'repository.json'),
    repositoryKey: key,
  };
}

export async function initializeAtlasNodeLayout(options: AtlasNodeLayoutOptions): Promise<AtlasNodeLayout> {
  const layout = await resolveAtlasNodeLayout(options);
  await mkdir(layout.backupDir, { recursive: true, mode: 0o700 });
  const identity: AtlasRepositoryIdentity = {
    version: 1,
    workspace: layout.workspace,
    sourceRoot: layout.sourceRoot,
    repositoryKey: layout.repositoryKey,
    dataMode: layout.dataMode,
  };
  const serialized = `${JSON.stringify(identity, null, 2)}\n`;
  try {
    await writeFile(layout.identityPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(layout.identityPath, 'utf8')) as Partial<AtlasRepositoryIdentity>;
    if (existing.version !== identity.version
      || existing.workspace !== identity.workspace
      || existing.sourceRoot !== identity.sourceRoot
      || existing.repositoryKey !== identity.repositoryKey
      || existing.dataMode !== identity.dataMode) {
      throw new Error('Atlas data directory belongs to a different repository identity.');
    }
  }
  return layout;
}
