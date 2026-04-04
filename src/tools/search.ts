import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { searchAtlasFiles, searchFts, searchVector } from '../db.js';
import { trackQuery } from '../queryLog.js';

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

export function registerSearchTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_search',
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      workspace: z.string().optional(),
    },
    async ({ query, limit, workspace }: { query: string; limit?: number; workspace?: string }) => {
      const activeWorkspace = workspace ?? runtime.config.workspace;
      const maxResults = limit ?? 5;
      const bm25Results = mapHitsToRanked(searchFts(runtime.db, activeWorkspace, query, maxResults));
      const vectorResults = runtime.provider
        ? mapHitsToRanked(searchVector(runtime.db, activeWorkspace, await runtime.provider.embedText(query), maxResults))
        : [];

      const results = bm25Results.length > 0 || vectorResults.length > 0
        ? fuseResults(bm25Results, vectorResults)
        : fallbackSearch(runtime, activeWorkspace, query, maxResults);

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
