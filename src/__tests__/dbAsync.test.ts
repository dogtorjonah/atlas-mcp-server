import test from 'node:test';
import assert from 'node:assert/strict';

import { getAtlasFileAsync } from '../dbAsync.js';
import type { AtlasDatabase, AtlasStatement } from '../db.js';

function createFakeDb(calls: unknown[][]): AtlasDatabase {
  const statement: AtlasStatement = {
    get: (...params: unknown[]) => {
      calls.push(params);
      return {
        id: 7,
        workspace: 'demo',
        file_path: 'src/demo.ts',
        file_hash: 'abc123',
        cluster: 'src',
        loc: 12,
        blurb: 'Demo file',
        purpose: 'Demo purpose',
        public_api: '[]',
        exports: '[]',
        patterns: '[]',
        tags: '["demo"]',
        dependencies: '{}',
        data_flows: '[]',
        key_types: '[]',
        hazards: '[]',
        hazards_with_ranges: '[]',
        conventions: '[]',
        cross_refs: '{}',
        source_highlights: '[]',
        language: 'typescript',
        extraction_model: null,
        last_extracted: null,
        updated_at: '2026-06-16T00:00:00.000Z',
      };
    },
    all: () => [],
    run: () => ({ changes: 0 }),
  };

  return {
    prepare: () => statement,
    pragma: () => undefined,
    exec: () => undefined,
    loadExtension: () => undefined,
    transaction: <F extends (...args: never[]) => unknown>(fn: F) => fn,
    close: () => undefined,
  };
}

test('dbAsync forwards an AtlasDatabase handle into handle-first db APIs', async () => {
  const calls: unknown[][] = [];
  const fakeDb = createFakeDb(calls);

  const row = await getAtlasFileAsync('demo', 'src/demo.ts', fakeDb);

  assert.equal(row?.file_path, 'src/demo.ts');
  assert.deepEqual(calls, [['demo', 'src/demo.ts']]);
});
