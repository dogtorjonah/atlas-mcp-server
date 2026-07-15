import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openAtlasNodeHost, initializeAtlasNodeLayout } from '../node/index.js';

test('Node layout creates deterministic guarded project and user identities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-node-layout-'));
  const userState = path.join(root, 'state');
  try {
    const project = await initializeAtlasNodeLayout({ sourceRoot: root, workspace: 'Fixture', dataMode: 'project' });
    const repeated = await initializeAtlasNodeLayout({ sourceRoot: root, workspace: 'fixture', dataMode: 'project' });
    assert.equal(project.dbPath, path.join(root, '.atlas', 'atlas.sqlite'));
    assert.deepEqual(repeated, project);
    const identity = JSON.parse(await readFile(project.identityPath, 'utf8')) as { repositoryKey: string; workspace: string };
    assert.equal(identity.workspace, 'fixture');
    assert.equal(identity.repositoryKey.length, 64);

    const user = await initializeAtlasNodeLayout({ sourceRoot: root, workspace: 'fixture', dataMode: 'user', dataRoot: userState });
    assert.equal(user.dataDir, userState);
    await assert.rejects(initializeAtlasNodeLayout({
      sourceRoot: root, workspace: 'different', dataMode: 'user', dataRoot: userState,
    }), /different repository identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Node host composes only the async SQLite worker proxy and closes its lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-node-host-'));
  const host = await openAtlasNodeHost({ sourceRoot: root, workspace: 'fixture' });
  try {
    const result = await host.service.admin({ action: 'doctor' });
    assert.equal(result.ok, true);
    assert.equal(host.store.status.state, 'ready');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
