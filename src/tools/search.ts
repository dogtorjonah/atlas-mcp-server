import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { searchAtlasFiles, searchFts } from '../db.js';
import { toolWithDescription } from './helpers.js';
import { trackQuery } from '../queryLog.js';
import { discoverWorkspaces, resolveWorkspaceDb } from './bridge.js';

interface RankedResult {
  file_path: string;
  score: number;
  record: AtlasFileRecord;
  source: 'fts' | 'fallback';
}

function mapHitsToRanked(hits: Array<{ file: AtlasFileRecord; score: number; source: 'fts' | 'vector' }>): RankedResult[] {
  return hits
    .filter((hit) => hit.file.file_path.length > 0)
    .map((hit) => ({
      file_path: hit.file.file_path,
      score: hit.score,
      record: hit.file,
      source: 'fts' as const,
    }));
}

function formatResult(result: RankedResult): string {
  return `${result.record.file_path} — ${result.record.purpose || result.record.blurb}`;
}

// Primary path: BM25 full-text search via FTS5.
// No API key required — search quality improves organically as agents
// populate metadata via atlas_commit.
function searchOneWorkspace(
  db: AtlasDatabase,
  ws: string,
  query: string,
  limit: number,
): RankedResult[] {
  const bm25Results = mapHitsToRanked(searchFts(db, ws, query, limit));

  if (bm25Results.length > 0) {
    return bm25Results;
  }
  // Fallback: LIKE-based search when FTS index has no matches
  return searchAtlasFiles(db, ws, query, limit).map((record, index) => ({
    file_path: record.file_path,
    score: 1 / (index + 1),
    record,
    source: 'fallback' as const,
  }));
}

function formatResultWithWorkspace(result: RankedResult, ws: string, showWorkspace: boolean): string {
  const prefix = showWorkspace ? `[${ws}] ` : '';
  return `${prefix}${result.record.file_path} — ${result.record.purpose || result.record.blurb}`;
}

export interface AtlasSearchArgs {
  query: string;
  limit?: number;
  workspace?: string;
  workspaces?: string[];
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runSearchTool(runtime: AtlasRuntime, { query, limit, workspace, workspaces }: AtlasSearchArgs): Promise<AtlasToolTextResult> {
  const maxResults = limit ?? 5;

  // ── Cross-workspace mode ──
  if (workspaces?.length) {
    const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
    if (allDbs.length === 0) {
      return { content: [{ type: 'text', text: 'No atlas databases found on this machine.' }] };
    }

    const targetDbs = allDbs.filter((d) => workspaces.includes(d.workspace));
    if (targetDbs.length === 0) {
      const available = allDbs.map((d) => d.workspace).join(', ');
      return { content: [{ type: 'text', text: `No matching workspaces. Available: ${available}` }] };
    }

    const perDbLimit = Math.max(maxResults, 10);
    const allResults: Array<RankedResult & { workspace: string }> = [];

    for (const bdb of targetDbs) {
      const results = searchOneWorkspace(bdb.db, bdb.workspace, query, perDbLimit);
      for (const r of results) {
        allResults.push({ ...r, workspace: bdb.workspace });
      }
    }

    // Cross-workspace RRF fusion
    const fused = new Map<string, { score: number; result: RankedResult; workspace: string }>();
    allResults.forEach((r, index) => {
      const key = `${r.workspace}:${r.file_path}`;
      const existing = fused.get(key);
      const addedScore = 1 / (60 + index + 1);
      if (existing) {
        existing.score += addedScore;
      } else {
        fused.set(key, { score: r.score + addedScore, result: r, workspace: r.workspace });
      }
    });

    const sorted = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
    if (sorted.length === 0) {
      return { content: [{ type: 'text', text: `No results for "${query}" across workspaces: ${workspaces.join(', ')}` }] };
    }

    const header = `Atlas search: "${query}" (${sorted.length} results across ${targetDbs.length} workspaces)\n`;
    const lines = sorted.map((s) => formatResultWithWorkspace(s.result, s.workspace, true));
    return { content: [{ type: 'text', text: header + '\n' + lines.join('\n\n') }] };
  }

  // ── Single-workspace mode ──
  // Primary: BM25 full-text search. No API key required.
  // Resolve correct database for cross-workspace queries
  const resolved = resolveWorkspaceDb(runtime, workspace);
  if ('error' in resolved) {
    return { content: [{ type: 'text' as const, text: resolved.error }] };
  }
  const { db: resolvedDb, workspace: activeWorkspace } = resolved;
  const results = searchOneWorkspace(resolvedDb, activeWorkspace, query, maxResults);

  const sliced = results.slice(0, maxResults);
  trackQuery(
    query,
    sliced.map((row) => row.record.id),
    sliced.map((row) => row.record.file_path),
  );
  return {
    content: [{
      type: 'text',
      text: sliced.length === 0
        ? `No atlas results for "${query}".`
        : sliced.map(formatResult).join('\n\n'),
    }],
  };
}

export function registerSearchTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_search',
    'Search the codebase atlas using natural language. Uses BM25 full-text search over file purposes, patterns, and descriptions, with optional vector fusion when embeddings are available. The index grows organically as agents fill in metadata via atlas_commit. Best for: "where does X happen?", "which files handle Y?", "find code related to Z". Supports cross-workspace search. No API key required.',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(30).optional(),
      workspace: z.string().optional().describe('Single workspace to search (defaults to current)'),
      workspaces: z.array(z.string()).optional().describe('Search across multiple workspaces. Overrides workspace param. Omit to search current workspace only.'),
    },
    async (args: AtlasSearchArgs) => runSearchTool(runtime, args),
  );
}
