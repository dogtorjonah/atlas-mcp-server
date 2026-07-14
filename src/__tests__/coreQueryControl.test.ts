import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyCharacterBudget,
  AtlasQueryController,
  createAtlasCursor,
  measureTextCharacters,
  paginateAtlasItems,
  parseAtlasCursor,
  planAtlasQuery,
  planAtlasQueryRequest,
  planCharacterBudget,
  planSourceOutput,
  splitBoundedReadLimit,
  type AtlasQueryControlArgs,
  type AtlasQueryPlan,
} from '../core/queryControl.js';
import type { AtlasJsonValue, AtlasQueryRequest } from '../core/types.js';

interface QueryPlanFixtureCase {
  name: string;
  action: string;
  args: AtlasQueryControlArgs;
  expected: AtlasQueryPlan;
}

interface ReadSplitFixtureCase {
  total_limit: number;
  source_count: number;
  expected: number[];
}

interface QueryControlFixture {
  schema_version: 1;
  plans: QueryPlanFixtureCase[];
  read_splits: ReadSplitFixtureCase[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFixture(value: unknown): QueryControlFixture {
  assert.ok(isObject(value));
  assert.equal(value.schema_version, 1);
  assert.ok(Array.isArray(value.plans));
  assert.ok(Array.isArray(value.read_splits));
  return value as unknown as QueryControlFixture;
}

const fixturePath = fileURLToPath(
  new URL('../../test/fixtures/contracts/query-control.json', import.meta.url),
);

async function loadFixture(): Promise<QueryControlFixture> {
  return parseFixture(JSON.parse(await readFile(fixturePath, 'utf8')) as unknown);
}

test('query work plans and bounded read splits match frozen fixtures', async () => {
  const fixture = await loadFixture();
  for (const fixtureCase of fixture.plans) {
    const first = planAtlasQuery(fixtureCase.action, fixtureCase.args);
    const second = planAtlasQuery(fixtureCase.action, fixtureCase.args);
    assert.deepEqual(first, fixtureCase.expected, fixtureCase.name);
    assert.deepEqual(second, first, `${fixtureCase.name} must be deterministic`);
    assert.equal(first.cost_model.unit, 'work_units');
    assert.ok(first.planned_work_units <= first.max_work_units);
  }
  for (const fixtureCase of fixture.read_splits) {
    assert.deepEqual(
      splitBoundedReadLimit(fixtureCase.total_limit, fixtureCase.source_count),
      fixtureCase.expected,
    );
  }
  assert.deepEqual(splitBoundedReadLimit(Number.NaN, Number.POSITIVE_INFINITY), []);
  assert.throws(
    () => splitBoundedReadLimit(1, 50_000),
    /Source count exceeds the bounded maximum/,
  );
  assert.throws(
    () => planAtlasQuery('search', { max_work_units: 10, maxWorkUnits: 11 }),
    /Conflicting max work unit aliases/,
  );
});

test('explicit query actions route to bounded format, result, character, and work plans', () => {
  const requests: AtlasQueryRequest[] = [
    { action: 'search', query: 'authority' },
    { action: 'lookup', filePath: 'src/index.ts' },
    { action: 'brief', filePath: 'src/index.ts' },
    { action: 'snippet', filePath: 'src/index.ts', symbol: 'main' },
    { action: 'similar', filePath: 'src/index.ts' },
    { action: 'plan_context', query: 'port query control' },
    { action: 'cluster' },
    { action: 'patterns' },
    { action: 'history' },
    { action: 'catalog' },
    { action: 'ask', query: 'How is query output bounded?' },
  ];

  for (const request of requests) {
    const plan = planAtlasQueryRequest(request);
    assert.equal(plan.route, request.action);
    assert.equal(plan.work.action, request.action);
    assert.equal(plan.format, 'text');
    assert.ok(plan.result_limit >= 1 && plan.result_limit <= 500);
    assert.equal(plan.character_budget.unit, 'unicode_code_points');
  }

  const clamped = planAtlasQueryRequest({
    action: 'plan_context',
    query: 'bounded planning',
    format: 'json',
    limit: 9_999,
    characterBudget: 128,
  }, { maxWorkUnits: 100 });
  assert.equal(clamped.format, 'json');
  assert.equal(clamped.result_limit, 500);
  assert.deepEqual(clamped.character_budget, {
    unit: 'unicode_code_points',
    requested: 128,
    applied: 256,
    minimum: 256,
    maximum: 100_000,
    clamped: true,
  });
  assert.equal(clamped.work.max_work_units, 100);
  assert.throws(
    () => planAtlasQueryRequest({ action: 'search', query: 'conflict' }, {
      character_budget: 1_000,
      characterBudget: 2_000,
    }),
    /Conflicting character budget aliases/,
  );
});

test('character budgets count Unicode code points and never claim token telemetry', () => {
  const budget = planCharacterBudget(256, 12_000);
  const input = '😀'.repeat(300);
  const bounded = applyCharacterBudget(input, budget);

  assert.equal(measureTextCharacters(input), 300);
  assert.equal(bounded.original_characters, 300);
  assert.equal(bounded.returned_characters, 256);
  assert.equal(measureTextCharacters(bounded.text), 256);
  assert.equal(bounded.truncated, true);
  assert.doesNotMatch(JSON.stringify({ budget, bounded }), /token/i);
});

test('opaque cursors are deterministic, request-bound, and paginate stable ordering', () => {
  const scopeA: AtlasJsonValue = { action: 'search', query: 'atlas', workspace: 'fixture' };
  const scopeB: AtlasJsonValue = { workspace: 'fixture', query: 'atlas', action: 'search' };
  const otherScope: AtlasJsonValue = { action: 'search', query: 'other', workspace: 'fixture' };
  assert.equal(createAtlasCursor(scopeA, 2), createAtlasCursor(scopeB, 2));

  const first = paginateAtlasItems(['a', 'b', 'c', 'd', 'e'], { scope: scopeA, limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.items, ['a', 'b']);
  assert.deepEqual(first.page, {
    next_cursor: createAtlasCursor(scopeA, 2),
    returned: 2,
    total: 5,
    truncated: true,
  });

  const second = paginateAtlasItems(['a', 'b', 'c', 'd', 'e'], {
    scope: scopeB,
    limit: 2,
    cursor: first.page.next_cursor,
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.deepEqual(second.items, ['c', 'd']);

  assert.deepEqual(parseAtlasCursor(first.page.next_cursor ?? '', otherScope), {
    ok: false,
    code: 'CURSOR_SCOPE_MISMATCH',
  });
  assert.deepEqual(parseAtlasCursor('not-a-cursor', scopeA), {
    ok: false,
    code: 'INVALID_CURSOR',
  });
  assert.deepEqual(parseAtlasCursor(createAtlasCursor(scopeA, Number.POSITIVE_INFINITY), scopeA), {
    ok: true,
    offset: 0,
  });
  assert.deepEqual(paginateAtlasItems(['a'], {
    scope: scopeA,
    cursor: createAtlasCursor(scopeA, 99),
  }), {
    ok: false,
    code: 'CURSOR_OUT_OF_RANGE',
  });
});

test('source output is snippet-first, range-bounded, and freshness-aware', () => {
  const highlights = [{ startLine: 20, endLine: 40 }];
  assert.deepEqual(planSourceOutput({ lineCount: 1_200, highlights }), {
    mode: 'highlights_only',
    body_deferred: true,
    start_line: null,
    end_line: null,
    deduplicate_highlights: false,
  });
  assert.deepEqual(planSourceOutput({ lineCount: 1_200, highlights, includeSource: true }), {
    mode: 'body',
    body_deferred: false,
    start_line: 1,
    end_line: 500,
    deduplicate_highlights: true,
  });
  assert.deepEqual(planSourceOutput({
    lineCount: 1_200,
    highlights,
    highlightsStale: true,
    sourceStart: 498,
    sourceEnd: 502,
  }), {
    mode: 'body',
    body_deferred: false,
    start_line: 498,
    end_line: 502,
    deduplicate_highlights: false,
  });
  assert.equal(planSourceOutput({ lineCount: 1_200 }).end_line, 500);
  assert.equal(planSourceOutput({ lineCount: 1_200, includeSource: false }).mode, 'omitted');
  assert.deepEqual(planSourceOutput({ lineCount: Number.NaN }), {
    mode: 'body',
    body_deferred: false,
    start_line: 0,
    end_line: 0,
    deduplicate_highlights: false,
  });
});

test('controller uses injected time, weighted units, bounded yielding, and request-local caching', async () => {
  let now = 1_000;
  let yieldCalls = 0;
  let loadCalls = 0;
  const controller = new AtlasQueryController('search', { maxWorkUnits: 310, deadlineMs: 50 }, {
    now: () => now,
    yieldControl: async () => {
      yieldCalls += 1;
    },
  });

  assert.equal(await controller.cooperate('scan_nodes', 100), true);
  assert.equal(yieldCalls, 1);
  const first = await controller.cached('file:1', async () => {
    loadCalls += 1;
    return { id: 1 };
  });
  const second = await controller.cached('file:1', async () => {
    loadCalls += 1;
    return { id: 2 };
  });
  assert.deepEqual(first, { id: 1 });
  assert.deepEqual(second, { id: 1 });
  assert.equal(loadCalls, 1);
  assert.equal(controller.checkpoint('invalid_units', Number.NaN, Number.NaN), true);
  assert.equal(controller.checkpoint('edge_scan', 11), false);
  assert.equal(controller.cancelled, true);

  now = 1_010;
  const snapshot = controller.snapshot('cancelled');
  assert.equal(snapshot.status, 'cancelled');
  assert.equal(snapshot.cancellation_reason, 'work_budget_exhausted');
  assert.equal(snapshot.work_units, 300);
  assert.deepEqual(snapshot.cache, { scope: 'request', entries: 1, hits: 1, misses: 1 });

  let deadlineNow = 5_000;
  const deadlineController = new AtlasQueryController('history', {}, { now: () => deadlineNow });
  deadlineNow += 5_001;
  assert.equal(deadlineController.checkpoint('history', 0), false);
  assert.equal(deadlineController.snapshot().cancellation_reason, 'deadline_exceeded');
});
