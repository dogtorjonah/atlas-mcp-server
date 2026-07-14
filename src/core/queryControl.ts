import type {
  AtlasJsonValue,
  AtlasOutputFormat,
  AtlasPageMeta,
  AtlasQueryAction,
  AtlasQueryRequest,
} from './types.js';

const DEFAULT_MAX_WORK_UNITS = 20_000;
const MAX_WORK_UNITS = 100_000;
const DEFAULT_DEADLINE_MS = 5_000;
const MAX_DEADLINE_MS = 30_000;
const MIN_CHARACTER_BUDGET = 256;
const MAX_CHARACTER_BUDGET = 100_000;
const MAX_PROGRESS_SNAPSHOTS = 32;
const YIELD_INTERVAL_UNITS = 256;
const MAX_REQUEST_CACHE_ENTRIES = 8;
const MAX_BOUNDED_READ_SOURCES = 1_000;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 500;
const DEFAULT_SOURCE_PAGE_LINES = 500;

const DEFAULT_ACTION_LIMITS = {
  search: 20,
  lookup: 1,
  brief: 1,
  snippet: 1,
  similar: 10,
  plan_context: 30,
  cluster: 100,
  patterns: 100,
  history: 50,
  catalog: 100,
  ask: 20,
} as const satisfies Readonly<Record<AtlasQueryAction, number>>;

const DEFAULT_CHARACTER_BUDGETS = {
  search: 12_000,
  lookup: 24_000,
  brief: 8_000,
  snippet: 16_000,
  similar: 12_000,
  plan_context: 30_000,
  cluster: 20_000,
  patterns: 20_000,
  history: 20_000,
  catalog: 16_000,
  ask: 24_000,
} as const satisfies Readonly<Record<AtlasQueryAction, number>>;

export interface AtlasQueryControlArgs {
  max_work_units?: number;
  maxWorkUnits?: number;
  deadline_ms?: number;
  deadlineMs?: number;
  character_budget?: number;
  characterBudget?: number;
}

export interface AtlasCharacterBudgetPlan {
  unit: 'unicode_code_points';
  requested: number | null;
  applied: number;
  minimum: number;
  maximum: number;
  clamped: boolean;
}

export interface AtlasQueryCostModel {
  unit: 'work_units';
  node_unit_cost: number;
  edge_unit_cost: number;
  expected_edges_per_node: number;
}

export interface AtlasQueryPlan {
  action: string;
  max_work_units: number;
  deadline_ms: number;
  node_limit: number;
  edge_limit: number;
  planned_work_units: number;
  strategy: 'weighted_action_cost';
  cost_model: AtlasQueryCostModel;
}

export interface AtlasQueryRequestPlan {
  route: AtlasQueryAction;
  format: AtlasOutputFormat;
  result_limit: number;
  cursor: string | null;
  character_budget: AtlasCharacterBudgetPlan;
  work: AtlasQueryPlan;
}

export interface AtlasQueryProgress {
  stage: string;
  work_units: number;
  elapsed_ms: number;
}

export interface AtlasQueryControlSnapshot {
  status: 'complete' | 'cancelled';
  cancellation_reason: 'work_budget_exhausted' | 'deadline_exceeded' | null;
  plan: AtlasQueryPlan;
  work_units: number;
  elapsed_ms: number;
  progress: readonly AtlasQueryProgress[];
  cache: {
    scope: 'request';
    entries: number;
    hits: number;
    misses: number;
  };
}

export interface AtlasBoundedText {
  text: string;
  unit: 'unicode_code_points';
  original_characters: number;
  returned_characters: number;
  truncated: boolean;
}

export interface AtlasSourceHighlightRange {
  startLine: number;
  endLine: number;
}

export type AtlasSourceOutputPlan =
  | {
      mode: 'omitted';
      body_deferred: false;
      start_line: null;
      end_line: null;
      deduplicate_highlights: false;
    }
  | {
      mode: 'highlights_only';
      body_deferred: true;
      start_line: null;
      end_line: null;
      deduplicate_highlights: false;
    }
  | {
      mode: 'body';
      body_deferred: false;
      start_line: number;
      end_line: number;
      deduplicate_highlights: boolean;
    };

export interface AtlasSourceOutputArgs {
  lineCount: number;
  highlights?: readonly AtlasSourceHighlightRange[];
  highlightsStale?: boolean;
  includeSource?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
}

export type AtlasCursorFailureCode =
  | 'INVALID_CURSOR'
  | 'CURSOR_SCOPE_MISMATCH'
  | 'CURSOR_OUT_OF_RANGE';

export type AtlasCursorResult =
  | { ok: true; offset: number }
  | { ok: false; code: AtlasCursorFailureCode };

export type AtlasPaginationResult<T> =
  | { ok: true; items: readonly T[]; page: AtlasPageMeta }
  | { ok: false; code: AtlasCursorFailureCode };

interface AtlasQueryCostProfile {
  nodeUnitCost: number;
  edgeUnitCost: number;
  expectedEdgesPerNode: number;
}

export interface AtlasQueryControllerOptions {
  now: () => number;
  yieldControl?: () => Promise<void>;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function finiteTime(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function resolveAliasedNumber(
  snakeCase: number | undefined,
  camelCase: number | undefined,
  name: string,
): number | undefined {
  if (snakeCase !== undefined && camelCase !== undefined && !Object.is(snakeCase, camelCase)) {
    throw new RangeError(`Conflicting ${name} aliases.`);
  }
  return camelCase ?? snakeCase;
}

function costProfileForAction(action: string): AtlasQueryCostProfile {
  if (action === 'cycles') return { nodeUnitCost: 3, edgeUnitCost: 1, expectedEdgesPerNode: 2 };
  if (action === 'audit:gaps') return { nodeUnitCost: 4, edgeUnitCost: 1, expectedEdgesPerNode: 2 };
  if (action === 'audit:smells') return { nodeUnitCost: 5, edgeUnitCost: 2, expectedEdgesPerNode: 3 };
  if (action === 'audit:hotspots') return { nodeUnitCost: 4, edgeUnitCost: 2, expectedEdgesPerNode: 3 };
  return { nodeUnitCost: 3, edgeUnitCost: 1, expectedEdgesPerNode: 2 };
}

function requestCharacterBudget(request: AtlasQueryRequest): number | undefined {
  if (request.action === 'plan_context' || request.action === 'ask') {
    return request.characterBudget;
  }
  return undefined;
}

function canonicalizeJson(value: AtlasJsonValue): AtlasJsonValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function fingerprintScope(scope: AtlasJsonValue): string {
  const value = JSON.stringify(canonicalizeJson(scope));
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function splitBoundedReadLimit(totalLimit: number, sourceCount: number): number[] {
  if (Number.isFinite(sourceCount) && Math.floor(sourceCount) > MAX_BOUNDED_READ_SOURCES) {
    throw new RangeError(`Source count exceeds the bounded maximum of ${MAX_BOUNDED_READ_SOURCES}.`);
  }
  const total = clampInteger(totalLimit, 0, 0, Number.MAX_SAFE_INTEGER);
  const count = clampInteger(sourceCount, 0, 0, MAX_BOUNDED_READ_SOURCES);
  if (count === 0) return [];
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function planCharacterBudget(
  requested: number | undefined,
  fallback: number,
): AtlasCharacterBudgetPlan {
  const normalizedRequest = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.floor(requested)
    : null;
  const applied = clampInteger(
    requested,
    clampInteger(fallback, MIN_CHARACTER_BUDGET, MIN_CHARACTER_BUDGET, MAX_CHARACTER_BUDGET),
    MIN_CHARACTER_BUDGET,
    MAX_CHARACTER_BUDGET,
  );
  return {
    unit: 'unicode_code_points',
    requested: normalizedRequest,
    applied,
    minimum: MIN_CHARACTER_BUDGET,
    maximum: MAX_CHARACTER_BUDGET,
    clamped: normalizedRequest !== null && normalizedRequest !== applied,
  };
}

export function planAtlasQuery(action: string, args: AtlasQueryControlArgs = {}): AtlasQueryPlan {
  const maxWorkUnits = clampInteger(
    resolveAliasedNumber(args.max_work_units, args.maxWorkUnits, 'max work unit'),
    DEFAULT_MAX_WORK_UNITS,
    1,
    MAX_WORK_UNITS,
  );
  const deadlineMs = clampInteger(
    resolveAliasedNumber(args.deadline_ms, args.deadlineMs, 'deadline'),
    DEFAULT_DEADLINE_MS,
    25,
    MAX_DEADLINE_MS,
  );
  const profile = costProfileForAction(action);
  const costPerNodeNeighborhood = profile.nodeUnitCost
    + profile.edgeUnitCost * profile.expectedEdgesPerNode;
  const nodeLimit = Math.max(0, Math.floor(maxWorkUnits / costPerNodeNeighborhood));
  const remainingAfterNodes = Math.max(0, maxWorkUnits - nodeLimit * profile.nodeUnitCost);
  const edgeLimit = Math.max(0, Math.min(
    nodeLimit * profile.expectedEdgesPerNode,
    Math.floor(remainingAfterNodes / profile.edgeUnitCost),
  ));

  return {
    action,
    max_work_units: maxWorkUnits,
    deadline_ms: deadlineMs,
    node_limit: nodeLimit,
    edge_limit: edgeLimit,
    planned_work_units: nodeLimit * profile.nodeUnitCost + edgeLimit * profile.edgeUnitCost,
    strategy: 'weighted_action_cost',
    cost_model: {
      unit: 'work_units',
      node_unit_cost: profile.nodeUnitCost,
      edge_unit_cost: profile.edgeUnitCost,
      expected_edges_per_node: profile.expectedEdgesPerNode,
    },
  };
}

export function planAtlasQueryRequest(
  request: AtlasQueryRequest,
  args: AtlasQueryControlArgs = {},
): AtlasQueryRequestPlan {
  const controlCharacterBudget = resolveAliasedNumber(
    args.character_budget,
    args.characterBudget,
    'character budget',
  );
  const requestedCharacters = controlCharacterBudget ?? requestCharacterBudget(request);
  return {
    route: request.action,
    format: request.format ?? 'text',
    result_limit: clampInteger(
      request.limit,
      DEFAULT_ACTION_LIMITS[request.action] ?? DEFAULT_PAGE_LIMIT,
      1,
      MAX_PAGE_LIMIT,
    ),
    cursor: request.cursor ?? null,
    character_budget: planCharacterBudget(
      requestedCharacters,
      DEFAULT_CHARACTER_BUDGETS[request.action],
    ),
    work: planAtlasQuery(request.action, args),
  };
}

export function measureTextCharacters(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

export function applyCharacterBudget(
  text: string,
  budget: AtlasCharacterBudgetPlan,
): AtlasBoundedText {
  const originalCharacters = measureTextCharacters(text);
  if (originalCharacters <= budget.applied) {
    return {
      text,
      unit: budget.unit,
      original_characters: originalCharacters,
      returned_characters: originalCharacters,
      truncated: false,
    };
  }

  const suffix = '\n… [truncated; use the cursor or a narrower query]';
  const prefixLength = Math.max(0, budget.applied - measureTextCharacters(suffix));
  let bounded = '';
  let copied = 0;
  for (const character of text) {
    if (copied >= prefixLength) break;
    bounded += character;
    copied += 1;
  }
  bounded += suffix;
  return {
    text: bounded,
    unit: budget.unit,
    original_characters: originalCharacters,
    returned_characters: measureTextCharacters(bounded),
    truncated: true,
  };
}

export function createAtlasCursor(scope: AtlasJsonValue, offset: number): string {
  const normalizedOffset = clampInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return `atlas-v1.${fingerprintScope(scope)}.${normalizedOffset}`;
}

export function parseAtlasCursor(cursor: string, scope: AtlasJsonValue): AtlasCursorResult {
  const match = /^atlas-v1\.([0-9a-f]{16})\.(\d+)$/.exec(cursor);
  if (!match) return { ok: false, code: 'INVALID_CURSOR' };
  if (match[1] !== fingerprintScope(scope)) return { ok: false, code: 'CURSOR_SCOPE_MISMATCH' };
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: 'INVALID_CURSOR' };
  return { ok: true, offset };
}

export function paginateAtlasItems<T>(
  items: readonly T[],
  args: { scope: AtlasJsonValue; limit?: number; cursor?: string | null },
): AtlasPaginationResult<T> {
  const limit = clampInteger(args.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  const parsed = args.cursor ? parseAtlasCursor(args.cursor, args.scope) : { ok: true as const, offset: 0 };
  if (!parsed.ok) return parsed;
  if (parsed.offset > items.length) return { ok: false, code: 'CURSOR_OUT_OF_RANGE' };
  const pageItems = items.slice(parsed.offset, parsed.offset + limit);
  const nextOffset = parsed.offset + pageItems.length;
  const truncated = nextOffset < items.length;
  return {
    ok: true,
    items: pageItems,
    page: {
      next_cursor: truncated ? createAtlasCursor(args.scope, nextOffset) : null,
      returned: pageItems.length,
      total: items.length,
      truncated,
    },
  };
}

export function planSourceOutput(args: AtlasSourceOutputArgs): AtlasSourceOutputPlan {
  if (args.includeSource === false) {
    return {
      mode: 'omitted',
      body_deferred: false,
      start_line: null,
      end_line: null,
      deduplicate_highlights: false,
    };
  }

  const lineCount = clampInteger(args.lineCount, 0, 0, Number.MAX_SAFE_INTEGER);
  const highlights = args.highlights ?? [];
  const hasExplicitRange = args.sourceStart !== undefined || args.sourceEnd !== undefined;
  if (highlights.length > 0 && args.includeSource !== true && !hasExplicitRange) {
    return {
      mode: 'highlights_only',
      body_deferred: true,
      start_line: null,
      end_line: null,
      deduplicate_highlights: false,
    };
  }

  const startLine = lineCount === 0
    ? 0
    : clampInteger(args.sourceStart, 1, 1, lineCount);
  const defaultEnd = startLine === 0 ? 0 : Math.min(lineCount, startLine + DEFAULT_SOURCE_PAGE_LINES - 1);
  const endLine = startLine === 0
    ? 0
    : clampInteger(args.sourceEnd, defaultEnd, startLine, lineCount);
  return {
    mode: 'body',
    body_deferred: false,
    start_line: startLine,
    end_line: endLine,
    deduplicate_highlights: highlights.length > 0 && args.highlightsStale !== true,
  };
}

export class AtlasQueryController {
  readonly plan: AtlasQueryPlan;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly yieldControl: (() => Promise<void>) | undefined;
  private workUnits = 0;
  private lastYieldAt = 0;
  private cancellationReason: AtlasQueryControlSnapshot['cancellation_reason'] = null;
  private readonly progressSnapshots: AtlasQueryProgress[] = [];
  private readonly requestCache = new Map<string, Promise<unknown>>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    action: string,
    args: AtlasQueryControlArgs,
    options: AtlasQueryControllerOptions,
  ) {
    this.plan = planAtlasQuery(action, args);
    this.now = options.now;
    this.yieldControl = options.yieldControl;
    this.startedAt = finiteTime(this.now(), 0);
  }

  get cancelled(): boolean {
    return this.cancellationReason !== null;
  }

  cancel(
    stage: string,
    reason: Exclude<AtlasQueryControlSnapshot['cancellation_reason'], null> = 'work_budget_exhausted',
    now = this.now(),
  ): void {
    if (this.cancellationReason) return;
    const observedAt = finiteTime(now, this.startedAt);
    this.cancellationReason = reason;
    if (this.progressSnapshots.length < MAX_PROGRESS_SNAPSHOTS) {
      this.progressSnapshots.push({
        stage,
        work_units: this.workUnits,
        elapsed_ms: Math.max(0, observedAt - this.startedAt),
      });
    }
  }

  checkpoint(stage: string, units = 0, now = this.now()): boolean {
    if (this.cancellationReason) return false;
    const observedAt = finiteTime(now, this.startedAt);
    const rawUnits = clampInteger(units, 0, 0, Number.MAX_SAFE_INTEGER);
    const isEdgeWork = /edge|reference|changelog|coupling|imported_not_used/.test(stage);
    const unitCost = isEdgeWork
      ? this.plan.cost_model.edge_unit_cost
      : this.plan.cost_model.node_unit_cost;
    const requestedUnits = rawUnits * unitCost;
    if (this.workUnits + requestedUnits > this.plan.max_work_units) {
      this.cancellationReason = 'work_budget_exhausted';
    } else {
      this.workUnits += requestedUnits;
    }
    if (!this.cancellationReason && observedAt - this.startedAt > this.plan.deadline_ms) {
      this.cancellationReason = 'deadline_exceeded';
    }

    const previous = this.progressSnapshots.at(-1);
    if (previous?.stage !== stage && this.progressSnapshots.length < MAX_PROGRESS_SNAPSHOTS) {
      this.progressSnapshots.push({
        stage,
        work_units: this.workUnits,
        elapsed_ms: Math.max(0, observedAt - this.startedAt),
      });
    }
    return this.cancellationReason === null;
  }

  async cooperate(stage: string, units = 1): Promise<boolean> {
    const canContinue = this.checkpoint(stage, units);
    if (!canContinue) return false;
    if (this.yieldControl && this.workUnits - this.lastYieldAt >= YIELD_INTERVAL_UNITS) {
      this.lastYieldAt = this.workUnits;
      await this.yieldControl();
      return this.checkpoint(stage);
    }
    return true;
  }

  async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.requestCache.get(key);
    if (cached) {
      this.cacheHits += 1;
      return cached as Promise<T>;
    }

    this.cacheMisses += 1;
    if (this.requestCache.size >= MAX_REQUEST_CACHE_ENTRIES) {
      const oldest = this.requestCache.keys().next().value as string | undefined;
      if (oldest) this.requestCache.delete(oldest);
    }
    const pending = loader();
    this.requestCache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.requestCache.delete(key);
      throw error;
    }
  }

  snapshot(finalStage = 'complete', now = this.now()): AtlasQueryControlSnapshot {
    const observedAt = finiteTime(now, this.startedAt);
    this.checkpoint(finalStage, 0, observedAt);
    return {
      status: this.cancellationReason ? 'cancelled' : 'complete',
      cancellation_reason: this.cancellationReason,
      plan: this.plan,
      work_units: this.workUnits,
      elapsed_ms: Math.max(0, observedAt - this.startedAt),
      progress: [...this.progressSnapshots],
      cache: {
        scope: 'request',
        entries: this.requestCache.size,
        hits: this.cacheHits,
        misses: this.cacheMisses,
      },
    };
  }
}
