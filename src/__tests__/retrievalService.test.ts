import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getAtlasCoreMigrationsDir } from '../paths.js';
import { openSqliteAtlasStore } from '../persistence/sqliteStore.js';
import { createAtlasService } from '../service/AtlasReadService.js';
import { measureTextCharacters } from '../core/queryControl.js';
import type { AtlasQueryRequest } from '../core/types.js';

const fixtureRoot = path.resolve('test/fixtures/repositories/small');
const migrationDir = getAtlasCoreMigrationsDir();

async function tempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'atlas-retrieval-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('worker-backed read service returns structured query, graph, audit, snapshot, and diff results', async (t) => {
  const directory = await tempDirectory(t);
  const sourceRoot = path.join(directory, 'repository');
  await cp(fixtureRoot, sourceRoot, { recursive: true });
  const store = await openSqliteAtlasStore({
    dbPath: path.join(directory, 'atlas.sqlite'),
    migrationDir,
  });
  t.after(() => store.close());
  await store.indexRepository({
    workspace: 'fixture',
    sourceRoot,
    mode: 'full',
    concurrency: 2,
    now: '2026-07-14T12:00:00.000Z',
  });

  const indexPath = path.join(sourceRoot, 'src/index.ts');
  const before = await readFile(indexPath, 'utf8');
  const firstChange = await store.insertChangelog({
    workspace: 'fixture',
    changelog: {
      workspace: 'fixture',
      file_path: 'src/index.ts',
      summary: 'Record the fixture source before the retrieval test edit.',
      created_at: '2026-07-14T12:01:00.000Z',
    },
  });
  await store.insertSnapshot({
    workspace: 'fixture',
    filePath: 'src/index.ts',
    content: before,
    changelogId: firstChange.id,
  });
  const after = `${before}\nexport const retrievalSentinel = true;\n`;
  await writeFile(indexPath, after);
  const secondChange = await store.insertChangelog({
    workspace: 'fixture',
    changelog: {
      workspace: 'fixture',
      file_path: 'src/index.ts',
      summary: 'Add the retrieval sentinel used by current-source authority tests.',
      created_at: '2026-07-14T12:02:00.000Z',
    },
  });
  await store.insertSnapshot({
    workspace: 'fixture',
    filePath: 'src/index.ts',
    content: after,
    changelogId: secondChange.id,
  });
  await store.insertChangelog({
    workspace: 'fixture',
    changelog: {
      workspace: 'fixture',
      file_path: 'src/math/add.ts',
      summary: 'Provide a second deterministic history group for cursor tests.',
      created_at: '2026-07-14T12:03:00.000Z',
    },
  });

  let requestNumber = 0;
  const service = createAtlasService(store, {
    workspace: 'fixture',
    requestIdFactory: () => `read-${++requestNumber}`,
  });

  const queryResults = await Promise.all([
    service.query({ action: 'search', query: 'calculate', limit: 10 }),
    service.query({ action: 'lookup', filePath: 'src/index.ts', includeSource: true, includeNeighbors: true }),
    service.query({ action: 'brief', filePath: 'src/index.ts' }),
    service.query({ action: 'snippet', filePath: 'src/index.ts', startLine: 1, endLine: 3 }),
    service.query({ action: 'similar', filePath: 'src/index.ts', limit: 5 }),
    service.query({ action: 'plan_context', query: 'calculate total', characterBudget: 10_000 }),
    service.query({ action: 'cluster', limit: 20 }),
    service.query({ action: 'patterns', limit: 20 }),
    service.query({ action: 'history', mode: 'entries', filePath: 'src/index.ts', limit: 20 }),
    service.query({ action: 'catalog', limit: 20 }),
    service.query({ action: 'ask', query: 'where is calculate implemented?', characterBudget: 10_000 }),
    service.query({ action: 'snapshot', filePath: 'src/index.ts', at: firstChange.id, maxLines: 100 }),
    service.query({ action: 'diff', filePath: 'src/index.ts', from: firstChange.id, to: secondChange.id, contextLines: 1 }),
  ]);
  assert.ok(queryResults.every((result) => result.ok));
  assert.deepEqual(queryResults.map((result) => result.ok && result.data.action), [
    'search', 'lookup', 'brief', 'snippet', 'similar', 'plan_context', 'cluster',
    'patterns', 'history', 'catalog', 'ask', 'snapshot', 'diff',
  ]);

  const lookup = queryResults[1]!;
  assert.ok(lookup.ok);
  assert.equal(lookup.data.record?.stale, true);
  assert.equal(lookup.meta.evidence?.freshness, 'stale');
  assert.match(String(lookup.data.source?.content), /retrievalSentinel/);
  assert.ok(Array.isArray(lookup.data.record?.neighbors));
  const brief = queryResults[2]!;
  assert.ok(brief.ok);
  assert.equal(brief.meta.evidence?.freshness, 'unknown');
  const contextPlan = queryResults[5]!;
  assert.ok(contextPlan.ok);
  assert.ok(contextPlan.data.items.some((item) =>
    Array.isArray(item.selection_reasons) && item.selection_reasons.includes('neighbor_expansion')));
  const snapshot = queryResults[11]!;
  assert.ok(snapshot.ok);
  assert.doesNotMatch(String(snapshot.data.record?.content), /retrievalSentinel/);
  const diff = queryResults[12]!;
  assert.ok(diff.ok);
  assert.match(String(diff.data.record?.diff_content), /retrievalSentinel/);
  const changelogSnapshot = await service.query({ action: 'snapshot', changelogId: firstChange.id, maxLines: 100 });
  assert.ok(changelogSnapshot.ok);
  assert.equal(changelogSnapshot.ok && changelogSnapshot.data.record?.file_path, 'src/index.ts');
  assert.doesNotMatch(String(changelogSnapshot.ok && changelogSnapshot.data.record?.content), /retrievalSentinel/);
  const changelogDiff = await service.query({
    action: 'diff', changelogId: secondChange.id, from: 'prev', to: 'changelog', contextLines: 1,
  });
  assert.ok(changelogDiff.ok);
  assert.match(String(changelogDiff.ok && changelogDiff.data.record?.diff_content), /retrievalSentinel/);

  const files = await store.listFiles({ workspace: 'fixture' });
  const cluster = files.find((file) => file.cluster)?.cluster ?? 'unclustered';
  const graphResults = await Promise.all([
    service.graph({ action: 'impact', filePath: 'src/math/add.ts', depth: 3 }),
    service.graph({ action: 'neighbors', filePath: 'src/index.ts', direction: 'both', depth: 2 }),
    service.graph({ action: 'trace', from: 'src/index.ts', to: 'src/math/add.ts', maxHops: 10, weighted: true }),
    service.graph({ action: 'cycles', minSize: 2 }),
    service.graph({ action: 'reachability', mode: 'entrypoints' }),
    service.graph({ action: 'graph', filePath: 'src/index.ts', depth: 2, includeSymbols: true }),
    service.graph({ action: 'cluster', cluster }),
    service.graph({ action: 'impact', filePath: 'src/math/add.ts', symbol: 'add', depth: 3, includeSymbols: true }),
    service.graph({ action: 'trace', fromSymbol: 'alpha', toSymbol: 'beta', maxHops: 10 }),
    service.graph({ action: 'reachability', mode: 'dead_exports', filePath: 'src/dead.ts' }),
  ]);
  assert.ok(graphResults.every((result) => result.ok));
  assert.deepEqual(graphResults.map((result) => result.ok && result.data.action), [
    'impact', 'neighbors', 'trace', 'cycles', 'reachability', 'graph', 'cluster',
    'impact', 'trace', 'reachability',
  ]);
  assert.ok(graphResults[2]?.ok && graphResults[2].data.paths.some((route) =>
    route[0] === 'src/index.ts' && route.at(-1) === 'src/math/add.ts'));
  assert.ok(graphResults[1]?.ok && graphResults[1].data.edges.every((edge) => edge.edge_type === 'import'));
  assert.equal(graphResults[2]?.ok && graphResults[2].data.summary.weighted, true);

  const auditResults = await Promise.all([
    service.audit({ action: 'gaps', limit: 50 }),
    service.audit({ action: 'smells', limit: 50 }),
    service.audit({ action: 'hotspots', topN: 5 }),
  ]);
  assert.ok(auditResults.every((result) => result.ok));
  assert.deepEqual(auditResults.map((result) => result.ok && result.data.action), ['gaps', 'smells', 'hotspots']);

  const firstPage = await service.query({ action: 'catalog', limit: 2 });
  assert.ok(firstPage.ok);
  assert.equal(firstPage.data.items.length, 2);
  assert.ok(firstPage.meta.page?.next_cursor);
  const secondPage = await service.query({
    action: 'catalog',
    limit: 2,
    cursor: firstPage.meta.page!.next_cursor!,
  });
  assert.ok(secondPage.ok);
  assert.notEqual(secondPage.data.items[0]?.file_path, firstPage.data.items[0]?.file_path);
  const badCursor = await service.query({ action: 'catalog', cursor: 'not-an-atlas-cursor' });
  assert.equal(badCursor.ok, false);
  if (!badCursor.ok) assert.equal(badCursor.error.code, 'ATLAS_INVALID_REQUEST');
  const firstHistoryGroup = await service.query({ action: 'history', mode: 'group', groupBy: 'file_path', limit: 1 });
  assert.ok(firstHistoryGroup.ok && firstHistoryGroup.meta.page?.next_cursor);
  const secondHistoryGroup = await service.query({
    action: 'history',
    mode: 'group',
    groupBy: 'file_path',
    limit: 1,
    cursor: firstHistoryGroup.ok ? firstHistoryGroup.meta.page?.next_cursor ?? undefined : undefined,
  });
  assert.ok(secondHistoryGroup.ok);
  assert.notEqual(firstHistoryGroup.ok && firstHistoryGroup.data.items[0]?.group,
    secondHistoryGroup.ok && secondHistoryGroup.data.items[0]?.group);

  assert.ok(contextPlan.ok && contextPlan.data.items.length >= 2);
  const singleItemBudget = Math.max(...contextPlan.data.items.slice(0, 2)
    .map((item) => measureTextCharacters(JSON.stringify([item]))));
  const boundedContext = await service.query({
    action: 'plan_context',
    query: 'calculate total',
    limit: 10,
    characterBudget: singleItemBudget,
  });
  assert.ok(boundedContext.ok);
  assert.equal(boundedContext.data.items.length, 1);
  assert.ok(boundedContext.meta.page?.next_cursor);
  const nextBoundedContext = await service.query({
    action: 'plan_context',
    query: 'calculate total',
    limit: 10,
    characterBudget: singleItemBudget,
    cursor: boundedContext.meta.page!.next_cursor!,
  });
  assert.ok(nextBoundedContext.ok);
  assert.equal(nextBoundedContext.data.items.length, 1);
  assert.notEqual(nextBoundedContext.data.items[0]?.file_path, boundedContext.data.items[0]?.file_path);
  const impossibleBudget = await service.query({
    action: 'plan_context',
    query: 'calculate total',
    characterBudget: 1,
  });
  assert.equal(impossibleBudget.ok, false);

  const boundedGraph = await service.graph({ action: 'graph', maxNodes: 2, maxEdges: 2 });
  assert.ok(boundedGraph.ok);
  assert.ok(boundedGraph.data.nodes.length <= 2);
  assert.ok(boundedGraph.data.edges.length <= 2);
  const hostileLimit = await service.query({ action: 'catalog', limit: Number.POSITIVE_INFINITY });
  assert.equal(hostileLimit.ok, false);
  const hostileBoolean = await service.query({
    action: 'catalog',
    includeTestFiles: 'yes',
  } as unknown as AtlasQueryRequest);
  assert.equal(hostileBoolean.ok, false);
  const hostileField = await service.query({
    action: 'catalog',
    field: 'file_path',
  } as unknown as AtlasQueryRequest);
  assert.equal(hostileField.ok, false);
  const unknownField = await service.query({
    action: 'catalog',
    unexpected: true,
  } as unknown as AtlasQueryRequest);
  assert.equal(unknownField.ok, false);

  const controller = new AbortController();
  controller.abort();
  const cancelled = await service.query({ action: 'catalog' }, { signal: controller.signal });
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, 'ATLAS_CANCELLED');

  const firstDeterministic = await service.query({ action: 'catalog', limit: 5 });
  const secondDeterministic = await service.query({ action: 'catalog', limit: 5 });
  assert.ok(firstDeterministic.ok && secondDeterministic.ok);
  assert.deepEqual(firstDeterministic.data, secondDeterministic.data);
  assert.deepEqual(firstDeterministic.meta, secondDeterministic.meta);
  const clientId = await service.query({ action: 'catalog', limit: 1 }, { requestId: 'caller-request' });
  assert.equal(clientId.request_id, 'caller-request');
  const invalidClientId = await service.query({ action: 'catalog', limit: 1 }, { requestId: '' });
  assert.equal(invalidClientId.ok, false);

  await service.close();
  const closed = await service.query({ action: 'catalog' });
  assert.equal(closed.ok, false);
  await assert.rejects(store.health(), (error: unknown) =>
    error instanceof Error && error.message.includes('closed'));
});
