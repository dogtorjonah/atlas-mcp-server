import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, searchAtlasFiles, searchFts, searchVector } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface RankedResult {
  file_path: string;
  score: number;
  record: AtlasFileRecord;
  source: 'fts' | 'vector' | 'fallback';
}

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function buildEmbeddingInput(file: AtlasFileRecord): string {
  return [
    file.file_path,
    file.purpose,
    file.blurb,
    ...file.patterns,
    ...file.hazards,
  ].filter(Boolean).join('\n').trim();
}

function mapHitsToRanked(hits: Array<{ file: AtlasFileRecord; score: number; source: 'fts' | 'vector' }>): RankedResult[] {
  return hits.map((hit) => ({
    file_path: hit.file.file_path,
    score: hit.score,
    record: hit.file,
    source: hit.source,
  }));
}

function fuseResults(fts: RankedResult[], vector: RankedResult[], k = 60): RankedResult[] {
  const fused = new Map<string, { score: number; record: AtlasFileRecord; source: RankedResult['source'] }>();

  fts.forEach((result, index) => {
    const current = fused.get(result.file_path);
    fused.set(result.file_path, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  vector.forEach((result, index) => {
    const current = fused.get(result.file_path);
    fused.set(result.file_path, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([file_path, value]) => ({
      file_path,
      score: value.score,
      record: value.record,
      source: value.source,
    }));
}

function atlasContent(format: 'json' | 'text' | undefined, payload: Record<string, unknown>, text: string) {
  return {
    content: [{
      type: 'text' as const,
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export function registerSimilarTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_similar',
    'Find files similar to a given file by semantic similarity. Compares file purpose, patterns, hazards, and descriptions using vector embeddings, then falls back to atlas text search if embeddings are unavailable. Best for: finding related modules, potential duplicates, parallel implementations, and migration candidates. Supports cross-workspace lookup.',
    {
      file_path: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      min_score: z.number().min(0).max(1).optional(),
      minScore: z.number().min(0).max(1).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      file_path,
      filePath,
      workspace,
      limit,
      min_score,
      minScore,
      format,
    }: {
      file_path?: string;
      filePath?: string;
      workspace?: string;
      limit?: number;
      min_score?: number;
      minScore?: number;
      format?: 'json' | 'text';
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
      }

      const ws = context.workspace;
      const targetFile = file_path ?? filePath;
      if (!targetFile) {
        return { content: [{ type: 'text', text: 'atlas_similar requires "file_path".' }] };
      }

      const seedRow = getAtlasFile(context.db, ws, targetFile);
      if (!seedRow) {
        return { content: [{ type: 'text', text: `No atlas row found for ${targetFile} in workspace "${ws}".` }] };
      }

      const maxResults = Math.max(1, Math.min(limit ?? 10, 50));
      const minSimilarity = Math.max(0, Math.min(min_score ?? minScore ?? 0.5, 1));
      const query = buildEmbeddingInput(seedRow) || `${seedRow.file_path}\n${seedRow.purpose || seedRow.blurb || ''}`;
      const ftsResults = mapHitsToRanked(searchFts(context.db, ws, query, Math.max(maxResults * 3, 20)));

      let vectorResults: RankedResult[] = [];
      if (runtime.provider) {
        try {
          const embedding = await runtime.provider.embedText(query);
          vectorResults = mapHitsToRanked(searchVector(context.db, ws, embedding, Math.max(maxResults * 3, 20)));
        } catch {
          // Non-fatal: FTS and fallback search still work.
        }
      }

      let results = (ftsResults.length > 0 || vectorResults.length > 0)
        ? fuseResults(ftsResults, vectorResults)
        : searchAtlasFiles(context.db, ws, query, Math.max(maxResults * 3, 20)).map((record, index) => ({
          file_path: record.file_path,
          score: 1 / (index + 1),
          record,
          source: 'fallback' as const,
        }));

      results = results
        .filter((entry) => entry.file_path !== seedRow.file_path)
        .filter((entry) => entry.score >= minSimilarity)
        .slice(0, maxResults);

      const lines = [
        '## Atlas Similar',
        '',
        `Seed: ${seedRow.file_path}`,
      ];

      if (results.length === 0) {
        lines.push(`- No similar files found with min_score=${minSimilarity.toFixed(2)}.`);
      } else {
        lines.push(...results.map((entry) => `- ${entry.record.file_path} (${(entry.score * 100).toFixed(1)}%) — ${entry.record.purpose || entry.record.blurb}`));
      }

      return atlasContent(format, {
        ok: true,
        workspace: ws,
        file_path: seedRow.file_path,
        limit: maxResults,
        min_score: minSimilarity,
        results: results.map((entry) => ({
          file_path: entry.record.file_path,
          score: entry.score,
          source: entry.source,
          cluster: entry.record.cluster ?? null,
          purpose: entry.record.purpose || entry.record.blurb || '',
        })),
        summary: {
          result_count: results.length,
        },
      }, lines.join('\n'));
    },
  );
}
