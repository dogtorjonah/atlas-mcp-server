/**
 * Atlas Bridge Tool — Cross-workspace search for atlas-mcp-server
 *
 * Discovers atlas databases from sibling repositories on the local machine
 * and provides unified search/lookup across workspace boundaries.
 *
 * Discovery: scans parent directory of the current source root for
 * sibling repos with .atlas/atlas.sqlite files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolWithDescription } from './helpers.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeDb {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Database pool
// ---------------------------------------------------------------------------

const bridgeDbs = new Map<string, BridgeDb>();

/** Close and remove a bridge DB handle from the pool (e.g. before nuking it). */
export function closeBridgeDb(dbPath: string): void {
  const entry = bridgeDbs.get(dbPath);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    bridgeDbs.delete(dbPath);
  }
}

function loadSqliteVec(db: AtlasDatabase): void {
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') {
      db.loadExtension(sv.getLoadablePath());
    }
  } catch (err) {
    console.warn('[atlas-bridge] sqlite-vec extension not available:', err instanceof Error ? err.message : String(err));
  }
}

export function openBridgeDb(workspace: string, sourceRoot: string): BridgeDb | null {
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
export function discoverWorkspaces(currentSourceRoot: string): BridgeDb[] {
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

function getFileCount(db: AtlasDatabase, workspace: string): number {
  try {
    const row = db.prepare('SELECT count(*) as cnt FROM atlas_files WHERE workspace = ?').get(workspace) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBridgeTools(server: McpServer, runtime: AtlasRuntime): void {
  // ── atlas_bridge_list ──
  toolWithDescription(server)(
    'atlas_bridge_list',
    'Discover all local atlas SQLite databases on this machine. Shows each workspace name, file count, and source root. Use to see what repositories have atlas knowledge available for cross-workspace search.',
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

}
