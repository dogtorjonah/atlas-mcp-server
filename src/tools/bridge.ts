/**
 * Atlas Bridge Tool — Cross-workspace search for atlas-mcp-server
 *
 * Discovers atlas databases from sibling repositories on the local machine
 * and provides unified search/lookup across workspace boundaries.
 *
 * Discovery: scans parent directory of the current source root for
 * sibling repos with .atlas/atlas.sqlite files.
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BridgeDb {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
  dbPath: string;
}

interface BridgeSearchResult {
  workspace: string;
  file_path: string;
  cluster: string;
  loc: number;
  purpose: string;
  patterns: string[];
  hazards: string[];
  score: number;
}

// ---------------------------------------------------------------------------
// Database pool
// ---------------------------------------------------------------------------

const bridgeDbs = new Map<string, BridgeDb>();

function loadSqliteVec(db: AtlasDatabase): void {
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') {
      db.loadExtension(sv.getLoadablePath());
    }
  } catch {
    // sqlite-vec not available
  }
}

function openBridgeDb(workspace: string, sourceRoot: string): BridgeDb | null {
  const dbPath = path.join(sourceRoot, '.atlas', 'atlas.sqlite');
  const existing = bridgeDbs.get(dbPath);
  if (existing) return existing;

  if (!fs.existsSync(dbPath)) return null;

  try {
    const db: AtlasDatabase = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    loadSqliteVec(db);

    const entry: BridgeDb = { db, workspace, sourceRoot, dbPath };
    bridgeDbs.set(dbPath, entry);
    return entry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Scan common parent dirs for sibling atlas databases */
function discoverWorkspaces(currentSourceRoot: string): BridgeDb[] {
  const seen = new Set<string>();
  const results: BridgeDb[] = [];
  const scanDirs = new Set<string>();

  // Always scan the parent of the current source root
  scanDirs.add(path.dirname(currentSourceRoot));

  // Also scan home dir if it exists
  const homeDir = process.env.HOME || '/Users/administrator';
  scanDirs.add(homeDir);

  for (const scanDir of scanDirs) {
    if (!fs.existsSync(scanDir)) continue;
    try {
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (!entry.isDirectory()) continue;

        const childPath = path.join(scanDir, entry.name);
        const atlasPath = path.join(childPath, '.atlas', 'atlas.sqlite');
        if (!fs.existsSync(atlasPath) || seen.has(atlasPath)) continue;

        const ws = path.basename(childPath).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const bdb = openBridgeDb(ws, childPath);
        if (bdb) {
          seen.add(atlasPath);
          results.push(bdb);
        }
      }
    } catch {
      // permission errors
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function hasTable(db: AtlasDatabase, tableName: string): boolean {
  try {
    const row = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1').get('table', tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try { return JSON.parse(value); } catch { return []; }
}

function searchFtsInDb(db: AtlasDatabase, workspace: string, query: string, limit: number): BridgeSearchResult[] {
  if (!hasTable(db, 'atlas_fts')) return [];
  try {
    const rows = db.prepare(
      `SELECT f.file_path, f.cluster, f.loc, f.purpose, f.patterns, f.hazards
       FROM atlas_fts
       JOIN atlas_files AS f ON f.id = atlas_fts.rowid
       WHERE f.workspace = ?
         AND atlas_fts MATCH ?
       ORDER BY bm25(atlas_fts)
       LIMIT ?`,
    ).all(workspace, normalizeSearchText(query), limit) as Array<Record<string, unknown>>;
    return rows.map((row, index) => ({
      workspace,
      file_path: String(row.file_path ?? ''),
      cluster: String(row.cluster ?? ''),
      loc: Number(row.loc ?? 0),
      purpose: String(row.purpose ?? ''),
      patterns: parseJsonArray(row.patterns),
      hazards: parseJsonArray(row.hazards),
      score: 1 / (index + 1),
    }));
  } catch {
    return [];
  }
}

function searchFallbackInDb(db: AtlasDatabase, workspace: string, query: string, limit: number): BridgeSearchResult[] {
  const like = `%${query}%`;
  try {
    const rows = db.prepare(
      `SELECT file_path, cluster, loc, purpose, patterns, hazards
       FROM atlas_files
       WHERE workspace = ?
         AND (file_path LIKE ? OR purpose LIKE ? OR patterns LIKE ? OR hazards LIKE ?)
       ORDER BY file_path ASC
       LIMIT ?`,
    ).all(workspace, like, like, like, like, limit) as Array<Record<string, unknown>>;
    return rows.map((row, index) => ({
      workspace,
      file_path: String(row.file_path ?? ''),
      cluster: String(row.cluster ?? ''),
      loc: Number(row.loc ?? 0),
      purpose: String(row.purpose ?? ''),
      patterns: parseJsonArray(row.patterns),
      hazards: parseJsonArray(row.hazards),
      score: 1 / (index + 1),
    }));
  } catch {
    return [];
  }
}

function getFileCount(db: AtlasDatabase, workspace: string): number {
  try {
    const row = db.prepare('SELECT count(*) as cnt FROM atlas_files WHERE workspace = ?').get(workspace) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

function fuseResults(allResults: BridgeSearchResult[], k = 60): BridgeSearchResult[] {
  const scores = new Map<string, BridgeSearchResult & { fusedScore: number }>();

  allResults.forEach((result, index) => {
    const key = `${result.workspace}:${result.file_path}`;
    const existing = scores.get(key);
    const addedScore = 1 / (k + index + 1);
    if (existing) {
      existing.fusedScore += addedScore;
    } else {
      scores.set(key, { ...result, fusedScore: result.score + addedScore });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .map(({ fusedScore, ...rest }) => ({ ...rest, score: fusedScore }));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBridgeTools(server: McpServer, runtime: AtlasRuntime): void {
  // ── atlas_bridge ──
  server.tool(
    'atlas_bridge',
    {
      query: z.string().min(1),
      workspaces: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    },
    async ({ query, workspaces, limit }: { query: string; workspaces?: string[]; limit?: number }) => {
      const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
      if (allDbs.length === 0) {
        return { content: [{ type: 'text', text: 'No atlas databases found on this machine.' }] };
      }

      const targetDbs = workspaces?.length
        ? allDbs.filter((d) => workspaces.includes(d.workspace))
        : allDbs;

      if (targetDbs.length === 0) {
        const available = allDbs.map((d) => d.workspace).join(', ');
        return { content: [{ type: 'text', text: `No matching workspaces. Available: ${available}` }] };
      }

      const maxResults = limit ?? 10;
      const perDbLimit = Math.max(maxResults, 10);

      const allResults: BridgeSearchResult[] = [];
      for (const bdb of targetDbs) {
        const ftsResults = searchFtsInDb(bdb.db, bdb.workspace, query, perDbLimit);
        if (ftsResults.length > 0) {
          allResults.push(...ftsResults);
        } else {
          allResults.push(...searchFallbackInDb(bdb.db, bdb.workspace, query, perDbLimit));
        }
      }

      if (allResults.length === 0) {
        const searched = targetDbs.map((d) => d.workspace).join(', ');
        return { content: [{ type: 'text', text: `No results for "${query}" across workspaces: ${searched}` }] };
      }

      const fused = fuseResults(allResults).slice(0, maxResults);
      const header = `🌉 Atlas Bridge: "${query}" (${fused.length} results across ${targetDbs.length} workspaces)\n`;

      const lines = fused.map((r) => {
        const hazardStr = r.hazards?.length ? `\n  ⚠️ ${r.hazards.join('; ')}` : '';
        const patternStr = r.patterns?.length ? `\n  Patterns: ${r.patterns.join(', ')}` : '';
        return `📄 [${r.workspace}] ${r.file_path}\n  Cluster: ${r.cluster} | ${r.loc} LOC\n  ${r.purpose}${patternStr}${hazardStr}`;
      });

      return { content: [{ type: 'text', text: header + '\n' + lines.join('\n\n') }] };
    },
  );

  // ── atlas_bridge_list ──
  server.tool(
    'atlas_bridge_list',
    {},
    async () => {
      const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
      if (allDbs.length === 0) {
        return { content: [{ type: 'text', text: 'No atlas databases found on this machine.' }] };
      }

      const lines = allDbs.map((bdb) => {
        const count = getFileCount(bdb.db, bdb.workspace);
        return `📦 ${bdb.workspace} — ${count} files\n   ${bdb.sourceRoot}`;
      });

      return {
        content: [{
          type: 'text',
          text: `🌉 Atlas Bridge — ${allDbs.length} workspaces\n\n${lines.join('\n\n')}`,
        }],
      };
    },
  );

  // ── atlas_bridge_lookup ──
  server.tool(
    'atlas_bridge_lookup',
    {
      file_path: z.string().min(1),
      workspace: z.string().min(1),
    },
    async ({ file_path, workspace }: { file_path: string; workspace: string }) => {
      const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
      const target = allDbs.find((d) => d.workspace === workspace);
      if (!target) {
        const available = allDbs.map((d) => d.workspace).join(', ');
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found. Available: ${available}` }] };
      }

      const row = target.db.prepare(
        'SELECT * FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
      ).get(target.workspace, file_path) as Record<string, unknown> | undefined;

      if (!row) {
        const fuzzy = target.db.prepare(
          'SELECT file_path FROM atlas_files WHERE workspace = ? AND file_path LIKE ? LIMIT 5',
        ).all(target.workspace, `%${file_path}%`) as Array<{ file_path: string }>;

        if (fuzzy.length > 0) {
          return { content: [{ type: 'text', text: `No exact match. Did you mean:\n${fuzzy.map((r) => `  - ${r.file_path}`).join('\n')}` }] };
        }
        return { content: [{ type: 'text', text: `No atlas entry for "${file_path}" in workspace "${workspace}".` }] };
      }

      const purpose = String(row.purpose ?? '');
      const blurb = String(row.blurb ?? '');
      const cluster = String(row.cluster ?? '');
      const loc = Number(row.loc ?? 0);
      const patterns = parseJsonArray(row.patterns);
      const hazards = parseJsonArray(row.hazards);
      const conventions = parseJsonArray(row.conventions);

      let publicApi: Array<{ name: string; type: string; signature?: string; description?: string }> = [];
      try { publicApi = JSON.parse(String(row.public_api ?? '[]')); } catch { /* */ }

      const sections: string[] = [];
      sections.push(`# [${workspace}] ${file_path}`);
      sections.push(`**Cluster:** ${cluster} | **LOC:** ${loc}`);
      sections.push(`**Purpose:** ${purpose}`);
      if (blurb) sections.push(`**Blurb:** ${blurb}`);
      if (publicApi?.length) {
        const apis = publicApi.map((api) =>
          `  - \`${api.name}\` (${api.type})${api.signature ? `: ${api.signature}` : ''}${api.description ? ` — ${api.description}` : ''}`,
        );
        sections.push(`**Public API:**\n${apis.join('\n')}`);
      }
      if (patterns?.length) sections.push(`**Patterns:** ${patterns.join(', ')}`);
      if (hazards?.length) sections.push(`**⚠️ Hazards:**\n${hazards.map((h) => `  - ${h}`).join('\n')}`);
      if (conventions?.length) sections.push(`**Conventions:**\n${conventions.map((c) => `  - ${c}`).join('\n')}`);

      return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    },
  );
}
