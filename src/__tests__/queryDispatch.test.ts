import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerQueryTool } from '../tools/query.js';
import type { AtlasDatabase } from '../db.js';
import type { AtlasRuntime } from '../types.js';

type RegisteredTool = {
  name: string;
  description: string;
  schema: {
    action: {
      safeParse: (value: unknown) => { success: boolean };
    };
  };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
};

function createFakeRuntime(sourceRoot: string): AtlasRuntime {
  const fakeDb = {
    prepare: () => {
      throw new Error('fake db should not be queried by dispatch smoke');
    },
    pragma: () => undefined,
    exec: () => undefined,
    loadExtension: () => undefined,
    transaction: <F extends (...args: never[]) => unknown>(fn: F) => fn,
    close: () => undefined,
  } satisfies AtlasDatabase;

  return {
    config: {
      workspace: 'demo',
      sourceRoot,
      dbPath: path.join(sourceRoot, '.atlas', 'atlas.sqlite'),
      concurrency: 1,
      sqliteVecExtension: '',
      embeddingModel: 'test-model',
      embeddingDimensions: 384,
    },
    db: fakeDb,
  };
}

test('atlas_query registers catalog and ask actions in the composite dispatcher', async () => {
  const tools: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => {
      tools.push({ name, description, schema, handler });
    },
  };
  const tempHome = mkdtempSync(path.join(tmpdir(), 'atlas-query-dispatch-'));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    registerQueryTool(server as never, createFakeRuntime(path.join(tempHome, 'repo')));
    const queryTool = tools.find((tool) => tool.name === 'atlas_query');
    assert.ok(queryTool, 'atlas_query tool should be registered');
    assert.equal(queryTool.schema.action.safeParse('catalog').success, true);
    assert.equal(queryTool.schema.action.safeParse('ask').success, true);
    assert.match(queryTool.description, /catalog pages file blurbs\/purposes/);
    assert.match(queryTool.description, /ask returns a cited BM25\/FTS evidence bundle/);

    const askResult = await queryTool.handler({ action: 'ask' });
    assert.match(askResult.content[0]?.text ?? '', /requires "query"/);

    const catalogResult = await queryTool.handler({ action: 'catalog', workspace: 'missing-workspace' });
    assert.match(catalogResult.content[0]?.text ?? '', /Workspace "missing-workspace" not found/);
  } finally {
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
