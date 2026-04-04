import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface WorkspaceContext {
  db: AtlasDatabase;
  workspace: string;
}

function resolveWorkspace(runtime: AtlasRuntime, workspace?: string): WorkspaceContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }
  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function truncateOneLine(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function summarizeApi(row: AtlasFileRecord): string {
  const entries = (row.public_api as Array<{ name?: string; signature?: string; type?: string }>).slice(0, 4);
  if (entries.length === 0) return '(none)';
  return entries.map((entry) => {
    const name = entry.name ?? 'anonymous';
    const signature = entry.signature ? truncateOneLine(entry.signature, 60) : (entry.type ?? '?');
    return `${name}: ${signature}`;
  }).join(' | ');
}

function topConsumers(row: AtlasFileRecord): Array<{ file: string; count: number }> {
  const aggregate = new Map<string, number>();
  const symbols = row.cross_refs?.symbols ?? {};
  for (const info of Object.values(symbols)) {
    for (const site of info.call_sites ?? []) {
      aggregate.set(site.file, (aggregate.get(site.file) ?? 0) + Math.max(1, site.count || 1));
    }
  }
  return [...aggregate.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, count]) => ({ file, count }));
}

export function registerBriefTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_brief',
    'Quick one-screen summary of a file: purpose, top API surface, and top consumers. Lighter than atlas_lookup — use when you just need fast orientation on what a file does.',
    {
      filePath: z.string().min(1),
      workspace: z.string().optional(),
    },
    async ({ filePath, workspace }: { filePath: string; workspace?: string }) => {
      const context = resolveWorkspace(runtime, workspace);
      if (!context) {
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
      }

      const row = getAtlasFile(context.db, context.workspace, filePath);
      if (!row) {
        return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
      }

      const purpose = truncateOneLine(row.purpose || row.blurb || '(no purpose)');
      const api = summarizeApi(row);
      const consumers = topConsumers(row);
      const consumersLine = consumers.length > 0
        ? consumers.map((c) => `${c.file} (${c.count})`).join(', ')
        : '(none)';

      const text = [
        `# ${row.file_path}`,
        `Purpose: ${purpose}`,
        `API: ${api}`,
        `Top consumers: ${consumersLine}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    },
  );
}
