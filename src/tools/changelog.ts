import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import type { AtlasChangelogRecord, AtlasChangelogSearchHit } from '../db.js';
import {
  insertAtlasChangelog,
  queryAtlasChangelog,
  searchChangelogFts,
} from '../db.js';
import { trackQuery } from '../queryLog.js';

interface RankedResult {
  changelog_id: number;
  score: number;
  record: AtlasChangelogRecord;
  source: 'fts' | 'vector';
}

function formatStringList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function mapHitsToRanked(hits: AtlasChangelogSearchHit[]): RankedResult[] {
  return hits
    .filter((hit) => hit.record.id > 0)
    .map((hit) => ({
      changelog_id: hit.record.id,
      score: hit.score,
      record: hit.record,
      source: hit.source,
    }));
}

function fuseResults(bm25: RankedResult[], vector: RankedResult[], k = 60): RankedResult[] {
  const scores = new Map<number, { score: number; record: AtlasChangelogRecord; source: RankedResult['source'] }>();

  bm25.forEach((result, index) => {
    const current = scores.get(result.changelog_id);
    scores.set(result.changelog_id, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  vector.forEach((result, index) => {
    const current = scores.get(result.changelog_id);
    scores.set(result.changelog_id, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  return [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .map(([changelogId, value]) => ({
      changelog_id: changelogId,
      score: value.score,
      record: value.record,
      source: value.source,
    }));
}

function matchesFilters(
  entry: AtlasChangelogRecord,
  filters: {
    file?: string;
    file_prefix?: string;
    cluster?: string;
    since?: string;
    until?: string;
    verification_status?: string;
    breaking_only?: boolean;
  },
): boolean {
  if (filters.file && entry.file_path !== filters.file) return false;
  if (filters.file_prefix && !entry.file_path.startsWith(filters.file_prefix)) return false;
  if (filters.cluster && entry.cluster !== filters.cluster) return false;
  if (filters.since && entry.created_at < filters.since) return false;
  if (filters.until && entry.created_at > filters.until) return false;
  if (filters.verification_status && entry.verification_status !== filters.verification_status) return false;
  if (filters.breaking_only && !entry.breaking_changes) return false;
  return true;
}

function formatEntry(entry: AtlasChangelogRecord): string {
  return [
    `# ${entry.file_path}`,
    `- id: ${entry.id}`,
    `- created_at: ${entry.created_at}`,
    `- summary: ${entry.summary}`,
    `- cluster: ${entry.cluster ?? '(none)'}`,
    `- breaking_changes: ${entry.breaking_changes ? 'true' : 'false'}`,
    `- verification_status: ${entry.verification_status}`,
    `- source: ${entry.source}`,
    `- commit_sha: ${entry.commit_sha ?? '(none)'}`,
    `- author_instance_id: ${entry.author_instance_id ?? '(none)'}`,
    `- author_engine: ${entry.author_engine ?? '(none)'}`,
    `- review_entry_id: ${entry.review_entry_id ?? '(none)'}`,
    `- patterns_added: ${formatStringList(entry.patterns_added)}`,
    `- patterns_removed: ${formatStringList(entry.patterns_removed)}`,
    `- hazards_added: ${formatStringList(entry.hazards_added)}`,
    `- hazards_removed: ${formatStringList(entry.hazards_removed)}`,
    `- verification_notes: ${entry.verification_notes ?? '(none)'}`,
  ].join('\n');
}

// ── Log action handler ──
async function handleLog(runtime: AtlasRuntime, args: Record<string, unknown>) {
  const file_path = args.file_path as string;
  const summary = args.summary as string;
  if (!file_path || !summary) {
    return { content: [{ type: 'text' as const, text: 'atlas_changelog(action=log) requires file_path and summary.' }] };
  }

  const entry = insertAtlasChangelog(runtime.db, {
    workspace: runtime.config.workspace,
    file_path,
    summary,
    patterns_added: args.patterns_added as string[] | undefined,
    patterns_removed: args.patterns_removed as string[] | undefined,
    hazards_added: args.hazards_added as string[] | undefined,
    hazards_removed: args.hazards_removed as string[] | undefined,
    cluster: (args.cluster as string) ?? null,
    breaking_changes: args.breaking_changes as boolean | undefined,
    commit_sha: (args.commit_sha as string) ?? null,
    author_instance_id: (args.author_instance_id as string) ?? null,
    author_engine: (args.author_engine as string) ?? null,
    review_entry_id: (args.review_entry_id as string) ?? null,
  });

  return {
    content: [
      { type: 'text' as const, text: `Logged atlas changelog entry ${entry.id} for ${entry.file_path}.\n\n${formatEntry(entry)}` },
      { type: 'text' as const, text: '💡 Use `atlas_changelog action=query file=<path>` to review this file\'s full change history.' },
    ],
  };
}

// ── Query action handler ──
async function handleQuery(runtime: AtlasRuntime, args: Record<string, unknown>) {
  const file = args.file as string | undefined;
  const file_prefix = args.file_prefix as string | undefined;
  const query = args.query as string | undefined;
  const cluster = args.cluster as string | undefined;
  const since = args.since as string | undefined;
  const until = args.until as string | undefined;
  const verification_status = args.verification_status as string | undefined;
  const breaking_only = args.breaking_only as boolean | undefined;
  const limit = args.limit as number | undefined;
  const workspace = args.workspace as string | undefined;

  const activeWorkspace = workspace ?? runtime.config.workspace;
  const maxResults = Math.max(1, Math.min(limit ?? 20, 100));
  const filterSet = { file, file_prefix, cluster, since, until, verification_status, breaking_only };

  let entries: AtlasChangelogRecord[];
  if (query) {
    const candidateLimit = Math.min(100, Math.max(maxResults * 5, 25));
    const bm25Results = mapHitsToRanked(searchChangelogFts(runtime.db, activeWorkspace, query, candidateLimit));

    const fused = fuseResults(bm25Results, []);
    entries = fused
      .map((result) => result.record)
      .filter((entry) => matchesFilters(entry, filterSet))
      .slice(0, maxResults);
  } else {
    entries = queryAtlasChangelog(runtime.db, {
      workspace: activeWorkspace,
      file,
      file_prefix,
      cluster,
      since,
      until,
      verification_status,
      breaking_only,
      limit: maxResults,
    });
  }

  trackQuery(
    query || file || file_prefix || cluster || 'atlas_changelog',
    entries.map((entry) => entry.id),
    [...new Set(entries.map((entry) => entry.file_path))],
  );

  return {
    content: [{
      type: 'text' as const,
      text: entries.length === 0
        ? 'No atlas changelog entries matched.'
        : entries.map(formatEntry).join('\n\n'),
    }],
  };
}

// ── Composite registration ──
export function registerChangelogTools(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_changelog',
    'Unified changelog tool. Actions: log records a new changelog entry for a file (patterns, hazards, breaking changes); query retrieves changelog history with filters (file, cluster, date range, breaking-only, verification status). Use atlas_commit instead of log for combined changelog + atlas update in one call.',
    {
      action: z.enum(['log', 'query']),
      // log action params
      file_path: z.string().optional(),
      summary: z.string().optional(),
      patterns_added: z.array(z.string()).optional(),
      patterns_removed: z.array(z.string()).optional(),
      hazards_added: z.array(z.string()).optional(),
      hazards_removed: z.array(z.string()).optional(),
      cluster: z.string().optional(),
      breaking_changes: z.boolean().optional(),
      commit_sha: z.string().optional(),
      author_instance_id: z.string().optional(),
      author_engine: z.string().optional(),
      review_entry_id: z.string().optional(),
      // query action params
      file: z.string().optional(),
      file_prefix: z.string().optional(),
      query: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      verification_status: z.string().optional(),
      breaking_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      workspace: z.string().optional(),
    },
    async (args: Record<string, unknown>) => {
      const { action } = args;
      switch (action) {
        case 'log':
          return handleLog(runtime, args);
        case 'query':
          return handleQuery(runtime, args);
        default:
          return { content: [{ type: 'text' as const, text: `Unknown atlas_changelog action: ${action}. Use "log" or "query".` }] };
      }
    },
  );
}
