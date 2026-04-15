import { z } from 'zod';

export interface NormalizedAtlasCommitSourceHighlight {
  id: number;
  label?: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface NormalizedAtlasCommitPublicApiEntry {
  name: string;
  type: string;
  signature?: string;
  description?: string;
}

/**
 * Canonical atlas_commit payload after input healing.
 *
 * The Atlas MCP server is the source of truth for this shape.
 * Callers may send compatibility aliases or shorthand forms, but the commit
 * implementation should consume only this normalized representation.
 */
export interface NormalizedAtlasCommitPayload {
  file_path: string;
  changelog_entry?: string;
  summary?: string;
  patterns_added?: string[];
  patterns_removed?: string[];
  hazards_added?: string[];
  hazards_removed?: string[];
  cluster?: string;
  breaking_changes?: boolean;
  commit_sha?: string;
  author_instance_id?: string;
  author_engine?: string;
  review_entry_id?: string;
  quiet?: boolean;
  purpose?: string;
  public_api?: NormalizedAtlasCommitPublicApiEntry[];
  conventions?: string[];
  key_types?: string[];
  data_flows?: string[];
  hazards?: string[];
  patterns?: string[];
  dependencies?: Record<string, unknown>;
  blurb?: string;
  source_highlights?: NormalizedAtlasCommitSourceHighlight[];
}

const stringListInputSchema = z.union([z.array(z.string()), z.string()]);
const publicApiLooseEntrySchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  kind: z.string().optional(),
  signature: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
});
const sourceHighlightLooseEntrySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  startLine: z.union([z.number(), z.string()]).optional(),
  start_line: z.union([z.number(), z.string()]).optional(),
  start: z.union([z.number(), z.string()]).optional(),
  endLine: z.union([z.number(), z.string()]).optional(),
  end_line: z.union([z.number(), z.string()]).optional(),
  end: z.union([z.number(), z.string()]).optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  snippet: z.string().optional(),
});

/**
 * Input boundary schema:
 * - canonical fields remain documented and preferred
 * - compatibility aliases/shorthand forms are accepted for healing
 * - output must still be normalized through normalizeAtlasCommitPayload()
 */
export const atlasCommitInputSchema = {
  file_path: z.string().min(1),
  filePath: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  filepath: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  path: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  changelog_entry: z.string().min(1).optional().describe(
    'What you changed and why (1-2 sentences). This becomes the changelog entry visible under "Recent Changes" in atlas_query lookups. Describe YOUR EDIT, not the file itself — use purpose/blurb for file identity.',
  ),
  summary: z.string().min(1).optional().describe('Deprecated alias for changelog_entry. Use changelog_entry instead.'),
  change_summary: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  changeSummary: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  rationale: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  description: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  patterns_added: stringListInputSchema.optional(),
  patternsAdded: stringListInputSchema.optional().describe('Compatibility alias for patterns_added.'),
  patterns_removed: stringListInputSchema.optional(),
  patternsRemoved: stringListInputSchema.optional().describe('Compatibility alias for patterns_removed.'),
  hazards_added: stringListInputSchema.optional(),
  hazardsAdded: stringListInputSchema.optional().describe('Compatibility alias for hazards_added.'),
  hazards_removed: stringListInputSchema.optional(),
  hazardsRemoved: stringListInputSchema.optional().describe('Compatibility alias for hazards_removed.'),
  cluster: z.string().optional(),
  breaking_changes: z.union([z.boolean(), z.string()]).optional(),
  breakingChanges: z.union([z.boolean(), z.string()]).optional().describe('Compatibility alias for breaking_changes.'),
  commit_sha: z.string().optional(),
  author_instance_id: z.string().optional(),
  author_engine: z.string().optional(),
  review_entry_id: z.string().optional(),
  quiet: z.boolean().optional().describe('Controls response verbosity (default true — compact one-line response). Set false to get verbose feedback with coverage warnings, changelog hints, and flush reminders.'),
  purpose: z.string().optional(),
  public_api: z.union([z.array(publicApiLooseEntrySchema), z.record(z.unknown()), z.string(), z.array(z.string())]).optional(),
  publicApi: z.union([z.array(publicApiLooseEntrySchema), z.record(z.unknown()), z.string(), z.array(z.string())]).optional().describe('Compatibility alias for public_api.'),
  conventions: stringListInputSchema.optional(),
  key_types: stringListInputSchema.optional(),
  keyTypes: stringListInputSchema.optional().describe('Compatibility alias for key_types.'),
  data_flows: stringListInputSchema.optional(),
  dataFlows: stringListInputSchema.optional().describe('Compatibility alias for data_flows.'),
  hazards: stringListInputSchema.optional(),
  patterns: stringListInputSchema.optional(),
  dependencies: z.record(z.unknown()).optional(),
  blurb: z.string().optional(),
  source_highlights: z.union([z.array(sourceHighlightLooseEntrySchema), z.record(z.unknown()), z.string()]).optional(),
  sourceHighlights: z.union([z.array(sourceHighlightLooseEntrySchema), z.record(z.unknown()), z.string()]).optional().describe('Compatibility alias for source_highlights.'),
} satisfies z.ZodRawShape;

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonIfString<T = unknown>(value: T): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toStringList(value: unknown): string[] | undefined {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) {
    const normalized = parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof parsed !== 'string') return undefined;
  const text = parsed.trim();
  if (!text) return undefined;
  const normalized = text
    .split(/\r?\n|,/g)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePublicApi(value: unknown): NormalizedAtlasCommitPublicApiEntry[] | undefined {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) {
    const normalized = parsed
      .map((entry) => {
        if (typeof entry === 'string') {
          const name = entry.trim();
          return name ? { name, type: 'value' } : null;
        }
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Record<string, unknown>;
        const name = toTrimmedString(record.name ?? record.symbol ?? record.id);
        if (!name) return null;
        const apiEntry: NormalizedAtlasCommitPublicApiEntry = {
          name,
          type: toTrimmedString(record.type ?? record.kind) ?? 'value',
        };
        const signature = toTrimmedString(record.signature);
        if (signature) apiEntry.signature = signature;
        const description = toTrimmedString(record.description ?? record.summary);
        if (description) apiEntry.description = description;
        return apiEntry;
      })
      .filter((entry): entry is NormalizedAtlasCommitPublicApiEntry => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }
  if (parsed && typeof parsed === 'object') {
    return normalizePublicApi([parsed]);
  }
  const list = toStringList(parsed);
  if (!list) return undefined;
  return list.map((name) => ({ name, type: 'value' }));
}

function normalizeSourceHighlights(value: unknown): NormalizedAtlasCommitSourceHighlight[] | undefined {
  const parsed = parseJsonIfString(value);
  const input = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  const normalized = input
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const content = toTrimmedString(record.content ?? record.text ?? record.snippet);
      if (!content) return null;

      const startRaw = record.startLine ?? record.start_line ?? record.start;
      const endRaw = record.endLine ?? record.end_line ?? record.end;
      const startLine = typeof startRaw === 'number' ? startRaw : Number(startRaw);
      const endLine = typeof endRaw === 'number' ? endRaw : Number(endRaw);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;
      if (startLine < 1 || endLine < 1) return null;

      const idRaw = record.id;
      const parsedId = typeof idRaw === 'number' ? idRaw : Number(idRaw);
      const id = Number.isFinite(parsedId) && parsedId >= 1 ? Math.floor(parsedId) : index + 1;

      const highlight: NormalizedAtlasCommitSourceHighlight = {
        id,
        content,
        startLine: Math.floor(startLine),
        endLine: Math.floor(endLine),
      };
      const label = toTrimmedString(record.label ?? record.title);
      if (label) highlight.label = label;
      return highlight;
    })
    .filter((entry): entry is NormalizedAtlasCommitSourceHighlight => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

const CANONICAL_OUTPUT_KEYS = [
  'file_path',
  'changelog_entry',
  'summary',
  'patterns_added',
  'patterns_removed',
  'hazards_added',
  'hazards_removed',
  'cluster',
  'breaking_changes',
  'commit_sha',
  'author_instance_id',
  'author_engine',
  'review_entry_id',
  'quiet',
  'purpose',
  'public_api',
  'conventions',
  'key_types',
  'data_flows',
  'hazards',
  'patterns',
  'dependencies',
  'blurb',
  'source_highlights',
] as const;

export function normalizeAtlasCommitPayload(input: Record<string, unknown>): NormalizedAtlasCommitPayload {
  const payload: Record<string, unknown> = { ...input };

  const aliasPairs: Array<[canonical: string, alias: string]> = [
    ['file_path', 'filePath'],
    ['file_path', 'filepath'],
    ['file_path', 'path'],
    ['changelog_entry', 'change_summary'],
    ['changelog_entry', 'changeSummary'],
    ['changelog_entry', 'rationale'],
    ['changelog_entry', 'description'],
    ['breaking_changes', 'breakingChanges'],
    ['key_types', 'keyTypes'],
    ['data_flows', 'dataFlows'],
    ['public_api', 'publicApi'],
    ['source_highlights', 'sourceHighlights'],
    ['patterns_added', 'patternsAdded'],
    ['patterns_removed', 'patternsRemoved'],
    ['hazards_added', 'hazardsAdded'],
    ['hazards_removed', 'hazardsRemoved'],
  ];
  for (const [canonical, alias] of aliasPairs) {
    if (payload[canonical] === undefined && payload[alias] !== undefined) {
      payload[canonical] = payload[alias];
    }
  }

  const filePath = toTrimmedString(payload.file_path);
  if (filePath) payload.file_path = filePath;

  const changelogEntry = toTrimmedString(payload.changelog_entry) ?? toTrimmedString(payload.summary);
  if (changelogEntry) {
    payload.changelog_entry = changelogEntry;
    if (!toTrimmedString(payload.summary)) payload.summary = changelogEntry;
  }

  const blurb = toTrimmedString(payload.blurb);
  if (blurb) payload.blurb = blurb;

  const purpose = toTrimmedString(payload.purpose);
  if (purpose) payload.purpose = purpose;

  for (const key of ['patterns_added', 'patterns_removed', 'hazards_added', 'hazards_removed', 'conventions', 'key_types', 'data_flows', 'hazards', 'patterns'] as const) {
    const normalized = toStringList(payload[key]);
    if (normalized) payload[key] = normalized;
  }

  const publicApi = normalizePublicApi(payload.public_api);
  if (publicApi) payload.public_api = publicApi;

  const sourceHighlights = normalizeSourceHighlights(payload.source_highlights);
  if (sourceHighlights) payload.source_highlights = sourceHighlights;

  const rawBreakingChanges = payload.breaking_changes;
  if (typeof rawBreakingChanges === 'string') {
    const folded = rawBreakingChanges.trim().toLowerCase();
    if (folded === 'true' || folded === 'yes' || folded === '1') payload.breaking_changes = true;
    else if (folded === 'false' || folded === 'no' || folded === '0') payload.breaking_changes = false;
  }

  const normalized: Partial<NormalizedAtlasCommitPayload> = {};
  for (const key of CANONICAL_OUTPUT_KEYS) {
    if (payload[key] !== undefined) {
      normalized[key] = payload[key] as never;
    }
  }
  return normalized as NormalizedAtlasCommitPayload;
}
