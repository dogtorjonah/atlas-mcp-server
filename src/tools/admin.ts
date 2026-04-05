/**
 * atlas_admin — composite admin/ops tool for atlas-mcp-server.
 *
 * Consolidates operational tools into a single action-dispatched interface:
 *   - reindex: re-run extraction pipeline (status / dry-run / full / pass2 / flush specific files)
 *   - bridge_list: discover local atlas workspaces
 *
 * Reindex action delegates to the shared runReindexTool handler from reindex.ts
 * so that state (activeReindexes, progress tracking) is shared.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { discoverWorkspaces } from './bridge.js';
import { runReindexTool } from './reindex.js';

// ============================================================================
// Action handlers
// ============================================================================

interface AdminArgs {
  action: 'reindex' | 'bridge_list';
  files?: string[];
  workspace?: string;
  confirm?: boolean;
  phase?: 'pass2';
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
      'Actions: reindex reruns extraction work and is the main way to refresh Atlas state after code changes; bridge_list discovers every local Atlas workspace available on the machine.',
      'Workflow hints: use reindex with no args first to inspect status before starting work; use files=[...] for targeted refreshes after touching a few files; use confirm=true only when you actually want to launch a broader run; use phase="pass2" for cross-reference-only refreshes when structural passes are already current; use bridge_list before querying another workspace.',
      'The refreshed pipeline now feeds richer outputs, including AST-verified structural edges, deterministic flow analysis, heuristic pass2 cross-references, and Leiden community clusters, so admin actions directly control the quality and freshness of those higher-value results.',
    ].join('\n'),
    {
      action: z.enum(['reindex', 'bridge_list']),
      files: z.array(z.string().min(1)).optional().describe('File paths to re-extract (reindex action)'),
      workspace: z.string().optional().describe('Target workspace (defaults to current)'),
      confirm: z.boolean().optional().describe('Confirm reindex execution (default: dry-run)'),
      phase: z.enum(['pass2']).optional().describe('Limit reindex to pass2 cross-refs only'),
    },
    async (args: AdminArgs) => {
      switch (args.action) {
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
              text: `Unknown atlas_admin action: ${String((args as { action: string }).action)}. Valid: reindex, bridge_list.`,
            }],
          };
      }
    },
  );
}
