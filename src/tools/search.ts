import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { searchAtlasFiles, searchFts, searchVector } from '../db.js';
import { trackQuery } from '../queryLog.js';
import { discoverWorkspaces } from './bridge.js';

interface RankedResult {
  file_path: string;
  score: number;
  record: AtlasFileRecord;
  source: 'fts' | 'vector' | 'fallback';
}

function fuseResults(bm25: RankedResult[], vector: RankedResult[], k = 60): RankedResult[] {
  const scores = new Map<string, { score: number; record: AtlasFileRecord; source: RankedResult['source'] }>();

  bm25.forEach((result, index) => {
    const current = scores.get(result.file_path);
    scores.set(result.file_path, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  vector.forEach((result, index) => {
    const current = scores.get(result.file_path);
    scores.set(result.file_path, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  return [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .map(([filePath, value]) => ({
      file_path: filePath,
      score: value.score,
      record: value.record,
      source: value.source,
    }));
}

function mapHitsToRanked(hits: Array<{ file: AtlasFileRecord; score: number; source: 'fts' | 'vector' }>): RankedResult[] {
  return hits
    .filter((hit) => hit.file.file_path.length > 0)
    .map((hit) => ({
      file_path: hit.file.file_path,
      score: hit.score,
      record: hit.file,
      source: hit.source,
    }));
}

function fallbackSearch(runtime: AtlasRuntime, workspace: string, query: string, limit: number): RankedResult[] {
  return searchAtlasFiles(runtime.db, workspace, query, limit).map((record, index) => ({
    file_path: record.file_path,
    score: 1 / (index + 1),
    record,
    source: 'fallback' as const,
  }));
}

function formatResult(result: RankedResult): string {
  return `${result.record.file_path} — ${result.record.purpose || result.record.blurb}`;
}

function searchOneWorkspace(
  db: AtlasDatabase,
  ws: string,
  query: string,
  limit: number,
  provider: AtlasRuntime['provider'],
  embedding: number[] | null,
): RankedResult[] {
  const bm25Results = mapHitsToRanked(searchFts(db, ws, query, limit));
  const vectorResults = embedding
    ? mapHitsToRanked(searchVector(db, ws, embedding, limit))
    : [];

  if (bm25Results.length > 0 || vectorResults.length > 0) {
    return fuseResults(bm25Results, vectorResults);
  }
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

export function registerSearchTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_search',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(30).optional(),
      workspace: z.string().optional().describe('Single workspace to search (defaults to current)'),
      workspaces: z.array(z.string()).optional().describe('Search across multiple workspaces. Overrides workspace param. Omit to search current workspace only.'),
    },
    async ({ query, limit, workspace, workspaces }: { query: string; limit?: number; workspace?: string; workspaces?: string[] }) => {
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

        const embedding = runtime.provider ? await runtime.provider.embedText(query) : null;
        const perDbLimit = Math.max(maxResults, 10);
        const allResults: Array<RankedResult & { workspace: string }> = [];

        for (const bdb of targetDbs) {
          const results = searchOneWorkspace(bdb.db, bdb.workspace, query, perDbLimit, runtime.provider, embedding);
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

      // ── Single-workspace mode (existing behavior) ──
      const activeWorkspace = workspace ?? runtime.config.workspace;
      const embedding = runtime.provider ? await runtime.provider.embedText(query) : null;
      const results = searchOneWorkspace(runtime.db, activeWorkspace, query, maxResults, runtime.provider, embedding);

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
    },
  );
}
