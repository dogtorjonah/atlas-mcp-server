import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasChangelogRecord, AtlasChangelogSearchHit } from '../db.js';
import {
  insertAtlasChangelog,
  queryAtlasChangelog,
  searchChangelogFts,
  searchChangelogVector,
  upsertChangelogEmbedding,
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

function buildEmbeddingInput(entry: AtlasChangelogRecord): string {
  return [
    entry.summary,
    ...entry.patterns_added,
    ...entry.patterns_removed,
    ...entry.hazards_added,
    ...entry.hazards_removed,
  ].join(' ').trim();
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

export function registerChangelogTools(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_log',
    {
      file_path: z.string().min(1),
      summary: z.string().min(1),
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
    },
    async ({
      file_path,
      summary,
      patterns_added,
      patterns_removed,
      hazards_added,
      hazards_removed,
      cluster,
      breaking_changes,
      commit_sha,
      author_instance_id,
      author_engine,
      review_entry_id,
    }: {
      file_path: string;
      summary: string;
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
    }) => {
      const entry = insertAtlasChangelog(runtime.db, {
        workspace: runtime.config.workspace,
        file_path,
        summary,
        patterns_added,
        patterns_removed,
        hazards_added,
        hazards_removed,
        cluster: cluster ?? null,
        breaking_changes,
        commit_sha: commit_sha ?? null,
        author_instance_id: author_instance_id ?? null,
        author_engine: author_engine ?? null,
        review_entry_id: review_entry_id ?? null,
      });

      if (runtime.provider) {
        const embeddingInput = buildEmbeddingInput(entry);
        if (embeddingInput) {
          try {
            const embedding = await runtime.provider.embedText(embeddingInput);
            upsertChangelogEmbedding(runtime.db, entry.id, embedding);
          } catch {
            // Embedding failures are non-fatal; FTS remains available.
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Logged atlas changelog entry ${entry.id} for ${entry.file_path}.\n\n${formatEntry(entry)}`,
        }],
      };
    },
  );

  server.tool(
    'atlas_changelog',
    {
      file: z.string().optional(),
      file_prefix: z.string().optional(),
      query: z.string().optional(),
      cluster: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      verification_status: z.string().optional(),
      breaking_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      workspace: z.string().optional(),
    },
    async ({
      file,
      file_prefix,
      query,
      cluster,
      since,
      until,
      verification_status,
      breaking_only,
      limit,
      workspace,
    }: {
      file?: string;
      file_prefix?: string;
      query?: string;
      cluster?: string;
      since?: string;
      until?: string;
      verification_status?: string;
      breaking_only?: boolean;
      limit?: number;
      workspace?: string;
    }) => {
      const activeWorkspace = workspace ?? runtime.config.workspace;
      const maxResults = Math.max(1, Math.min(limit ?? 20, 100));
      const filterSet = {
        file,
        file_prefix,
        cluster,
        since,
        until,
        verification_status,
        breaking_only,
      };

      let entries: AtlasChangelogRecord[];
      if (query) {
        const candidateLimit = Math.min(100, Math.max(maxResults * 5, 25));
        const bm25Results = mapHitsToRanked(searchChangelogFts(runtime.db, activeWorkspace, query, candidateLimit));

        let vectorResults: RankedResult[] = [];
        if (runtime.provider) {
          try {
            const embedding = await runtime.provider.embedText(query);
            vectorResults = mapHitsToRanked(searchChangelogVector(runtime.db, activeWorkspace, embedding, candidateLimit));
          } catch {
            vectorResults = [];
          }
        }

        const fused = fuseResults(bm25Results, vectorResults);
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
          type: 'text',
          text: entries.length === 0
            ? 'No atlas changelog entries matched.'
            : entries.map(formatEntry).join('\n\n'),
        }],
      };
    },
  );
}
