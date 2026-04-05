/**
 * atlas_admin — composite admin/ops tool for atlas-mcp-server.
 *
 * Consolidates operational tools into a single action-dispatched interface:
 *   - init: nuke the database and reindex from scratch (destructive)
 *   - reindex: re-run extraction pipeline (status / dry-run / full / crossref / flush specific files)
 *   - bridge_list: discover local atlas workspaces
 *
 * Reindex action delegates to the shared runReindexTool handler from reindex.ts
 * so that state (activeReindexes, progress tracking) is shared.
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { resetAtlasDatabase } from '../db.js';
import { toolWithDescription } from './helpers.js';
import { discoverWorkspaces, closeBridgeDb } from './bridge.js';
import { runReindexTool } from './reindex.js';

// ============================================================================
// Action handlers
// ============================================================================

interface AdminArgs {
  action: 'init' | 'reindex' | 'bridge_list';
  files?: string[];
  workspace?: string;
  confirm?: boolean;
  phase?: 'crossref';
}

async function handleInit(
  runtime: AtlasRuntime,
  workspace?: string,
  confirm?: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const targetWorkspace = workspace ?? runtime.config.workspace;
  const isCrossWorkspace = targetWorkspace !== runtime.config.workspace;

  // ── Cross-workspace init ──
  if (isCrossWorkspace) {
    const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
    const target = allDbs.find((bdb) => bdb.workspace === targetWorkspace);
    if (!target) {
      const available = allDbs.map((d) => d.workspace).join(', ');
      return {
        content: [{ type: 'text', text: `Workspace "${targetWorkspace}" not found. Available: ${available}` }],
      };
    }

    if (!confirm) {
      return {
        content: [{
          type: 'text',
          text: [
            `⚠️  atlas_admin(action=init) will **destroy** the atlas database for workspace "${targetWorkspace}" (cross-workspace).`,
            '',
            `  Workspace: ${targetWorkspace}`,
            `  Database:  ${target.dbPath}`,
            `  Source:    ${target.sourceRoot}`,
            '',
            'This deletes all extractions, embeddings, changelog entries, symbols, references, and community clusters.',
            'Call with confirm=true to proceed.',
          ].join('\n'),
        }],
      };
    }

    // Close the read-only bridge handle before nuking
    closeBridgeDb(target.dbPath);

    // Nuke and reopen with write access
    const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const freshDb = resetAtlasDatabase(
      { dbPath: target.dbPath, migrationDir, sqliteVecExtension: runtime.config.sqliteVecExtension },
    );

    // Build temporary runtime targeting the remote workspace
    const tempRuntime: AtlasRuntime = {
      config: {
        ...runtime.config,
        workspace: targetWorkspace,
        sourceRoot: target.sourceRoot,
        dbPath: target.dbPath,
      },
      db: freshDb,
      provider: runtime.provider,
      server: runtime.server,
    };

    const reindexResult = await runReindexTool(tempRuntime, { confirm: true });
    const reindexText = reindexResult.content.map((c) => c.text).join('\n');

    return {
      content: [
        { type: 'text', text: `🔥 Database nuked and recreated for workspace "${targetWorkspace}" (cross-workspace).\n\n${reindexText}` },
        { type: 'text', text: '💡 All previous extractions, embeddings, and changelog entries for this workspace have been destroyed.' },
      ],
    };
  }

  // ── Local init ──
  if (!confirm) {
    return {
      content: [{
        type: 'text',
        text: [
          '⚠️  atlas_admin(action=init) will **destroy** the current atlas database and rebuild from scratch.',
          '',
          `  Workspace: ${runtime.config.workspace}`,
          `  Database:  ${runtime.config.dbPath}`,
          '',
          'This deletes all extractions, embeddings, changelog entries, symbols, references, and community clusters.',
          'Call with confirm=true to proceed.',
        ].join('\n'),
      }],
    };
  }

  // Nuke and reopen
  const migrationDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const freshDb = resetAtlasDatabase(
    { dbPath: runtime.config.dbPath, migrationDir, sqliteVecExtension: runtime.config.sqliteVecExtension },
    runtime.db,
  );

  // Swap the live db handle so the rest of the server uses the fresh database
  (runtime as { db: typeof freshDb }).db = freshDb;

  // Kick off full reindex
  const reindexResult = await runReindexTool(runtime, { confirm: true });
  const reindexText = reindexResult.content.map((c) => c.text).join('\n');

  return {
    content: [
      { type: 'text', text: `🔥 Database nuked and recreated for workspace "${runtime.config.workspace}".\n\n${reindexText}` },
      { type: 'text', text: '💡 All previous extractions, embeddings, and changelog entries have been destroyed. The full pipeline is now running from scratch.' },
    ],
  };
}

async function handleBridgeList(
  runtime: AtlasRuntime,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
  if (allDbs.length === 0) {
    return { content: [{ type: 'text', text: 'No atlas databases found on this machine.' }] };
  }

  const getFileCount = (db: import('../db.js').AtlasDatabase, workspace: string): number => {
    try {
      const row = db.prepare('SELECT count(*) as cnt FROM atlas_files WHERE workspace = ?').get(workspace) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  };

  const lines = allDbs.map((bdb) => {
    const count = getFileCount(bdb.db, bdb.workspace);
    return `📦 ${bdb.workspace} — ${count} files\n   ${bdb.sourceRoot}`;
  });

  return {
    content: [
      {
        type: 'text',
        text: `🌉 Atlas Bridge — ${allDbs.length} workspaces\n\n${lines.join('\n\n')}`,
      },
      {
        type: 'text',
        text: '💡 Use `atlas_query action=search workspace=X` to query across workspaces.',
      },
    ],
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerAdminTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_admin',
    [
      'Strategic operations tool for Atlas maintenance, refresh, and workspace discovery.',
      'Use atlas_admin when the Atlas itself needs to be updated or inspected, not when you want code answers from the Atlas.',
      'Actions: init destroys the database and rebuilds from scratch (requires confirm=true); reindex reruns extraction work and is the main way to refresh Atlas state after code changes; bridge_list discovers every local Atlas workspace available on the machine.',
      'Workflow hints: use init when the database is corrupted, the schema changed, or you need a clean slate; use reindex with no args first to inspect status before starting work; use files=[...] for targeted refreshes after touching a few files; use confirm=true only when you actually want to launch a broader run; use phase="crossref" for cross-reference-only refreshes when structural passes are already current; use bridge_list before querying another workspace.',
      'The refreshed pipeline now feeds richer outputs, including AST-verified structural edges, deterministic flow analysis, heuristic crossref cross-references, and Leiden community clusters, so admin actions directly control the quality and freshness of those higher-value results.',
    ].join('\n'),
    {
      action: z.enum(['init', 'reindex', 'bridge_list']),
      files: z.array(z.string().min(1)).optional().describe('File paths to re-extract (reindex action)'),
      workspace: z.string().optional().describe('Target workspace (defaults to current)'),
      confirm: z.boolean().optional().describe('Confirm reindex execution (default: dry-run)'),
      phase: z.enum(['crossref']).optional().describe('Limit reindex to crossref phase only'),
    },
    async (args: AdminArgs) => {
      switch (args.action) {
        case 'init':
          return handleInit(runtime, args.workspace, args.confirm);
        case 'reindex':
          return runReindexTool(runtime, {
            files: args.files,
            workspace: args.workspace,
            confirm: args.confirm,
            phase: args.phase,
          });
        case 'bridge_list':
          return handleBridgeList(runtime);
        default:
          return {
            content: [{
              type: 'text',
              text: `Unknown atlas_admin action: ${String((args as { action: string }).action)}. Valid: init, reindex, bridge_list.`,
            }],
          };
      }
    },
  );
}
