import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { searchAtlasFiles } from '../db.js';
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

function mapRow(row: Record<string, unknown>): AtlasFileRecord {
  return {
    id: Number(row.id ?? row.rowid ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    file_hash: row.file_hash == null ? null : String(row.file_hash),
    cluster: row.cluster == null ? null : String(row.cluster),
    loc: Number(row.loc ?? 0),
    blurb: String(row.blurb ?? ''),
    purpose: String(row.purpose ?? ''),
    public_api: JSON.parse(String(row.public_api ?? '[]')),
    exports: JSON.parse(String(row.exports ?? '[]')),
    patterns: JSON.parse(String(row.patterns ?? '[]')),
    dependencies: JSON.parse(String(row.dependencies ?? '{}')),
    data_flows: JSON.parse(String(row.data_flows ?? '[]')),
    key_types: JSON.parse(String(row.key_types ?? '[]')),
    hazards: JSON.parse(String(row.hazards ?? '[]')),
    conventions: JSON.parse(String(row.conventions ?? '[]')),
    cross_refs: JSON.parse(String(row.cross_refs ?? 'null')),
    language: String(row.language ?? 'typescript'),
    extraction_model: row.extraction_model == null ? null : String(row.extraction_model),
    last_extracted: row.last_extracted == null ? null : String(row.last_extracted),
  };
}

function hasTable(db: AtlasRuntime['db'], tableName: string): boolean {
  try {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1').get('table', tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function searchFts(db: AtlasRuntime['db'], workspace: string, query: string, limit: number): RankedResult[] {
  if (!hasTable(db, 'atlas_fts')) {
    return [];
  }

  try {
    const rows = db.prepare(
      `SELECT rowid, file_path, blurb, purpose, public_api, patterns, hazards, cross_refs
       FROM atlas_fts
       WHERE atlas_fts MATCH ?
       ORDER BY bm25(atlas_fts)
       LIMIT ?`,
    ).all(query, limit) as Array<Record<string, unknown>>;

    return rows.map((row, index) => ({
      file_path: String(row.file_path ?? ''),
      score: 1 / (index + 1),
      record: mapRow({
        id: row.rowid,
        workspace,
        file_path: row.file_path,
        blurb: row.blurb,
        purpose: row.purpose,
        public_api: row.public_api,
        patterns: row.patterns,
        hazards: row.hazards,
        cross_refs: row.cross_refs,
      }),
      source: 'fts' as const,
    })).filter((row) => row.file_path.length > 0);
  } catch {
    return [];
  }
}

function searchVector(db: AtlasRuntime['db'], workspace: string, embedding: number[], limit: number): RankedResult[] {
  if (!hasTable(db, 'atlas_embeddings')) {
    return [];
  }

  try {
    const rows = db.prepare(
      `SELECT af.id, af.workspace, af.file_path, af.file_hash, af.cluster, af.loc, af.blurb, af.purpose,
              af.public_api, af.exports, af.patterns, af.dependencies, af.data_flows, af.key_types,
              af.hazards, af.conventions, af.cross_refs, af.language, af.extraction_model, af.last_extracted
       FROM atlas_embeddings ae
       JOIN atlas_files af ON af.id = ae.file_id
       WHERE af.workspace = ? AND ae.embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    ).all(workspace, JSON.stringify(embedding), limit) as Array<Record<string, unknown>>;

    return rows.map((row, index) => ({
      file_path: String(row.file_path ?? ''),
      score: 1 / (index + 1),
      record: mapRow(row),
      source: 'vector' as const,
    })).filter((row) => row.file_path.length > 0);
  } catch {
    return [];
  }
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
      const bm25Results = searchFts(runtime.db, activeWorkspace, query, maxResults);
      const vectorResults = runtime.provider
        ? searchVector(runtime.db, activeWorkspace, await runtime.provider.embedText(query), maxResults)
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
