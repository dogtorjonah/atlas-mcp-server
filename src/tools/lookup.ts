import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { getAtlasFile, listImports, listImportedBy } from '../db.js';
import { trackQuery } from '../queryLog.js';

async function currentFileHash(sourceRoot: string, filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null;
  }
}

function formatNeighborBlurb(filePath: string, blurb: string | undefined | null, keyTypes?: unknown[]): string {
  const b = blurb?.trim() || '(no blurb)';
  const types = Array.isArray(keyTypes) && keyTypes.length > 0
    ? ` [exports: ${(keyTypes as Array<{ name?: string }>).slice(0, 5).map((t) => t.name).filter(Boolean).join(', ')}]`
    : '';
  return `  ${filePath}${types}\n    ${b}`;
}

export function registerLookupTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_lookup',
    {
      filePath: z.string().min(1),
      workspace: z.string().optional(),
    },
    async ({ filePath, workspace }: { filePath: string; workspace?: string }) => {
      const ws = workspace ?? runtime.config.workspace;
      const row = getAtlasFile(runtime.db, ws, filePath);
      trackQuery(filePath, row ? [row.id] : [], row ? [row.file_path] : []);
      if (!row) {
        return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
      }

      const currentHash = await currentFileHash(runtime.config.sourceRoot, filePath);
      const stale = currentHash && row.file_hash && currentHash !== row.file_hash
        ? '\n⚠️  STALE: file has changed since last extraction.\n'
        : '';

      // Build full extraction section
      const lines: string[] = [];
      lines.push(`# ${row.file_path}`);
      if (stale) lines.push(stale);
      if (row.cluster) lines.push(`Cluster: ${row.cluster}`);
      lines.push('');
      lines.push(`## Purpose`);
      lines.push(row.purpose || row.blurb || '(no extraction yet)');

      if (Array.isArray(row.patterns) && row.patterns.length > 0) {
        lines.push('');
        lines.push(`## Patterns`);
        lines.push(row.patterns.join(', '));
      }

      if (Array.isArray(row.hazards) && row.hazards.length > 0) {
        lines.push('');
        lines.push(`## Hazards`);
        for (const h of row.hazards) lines.push(`- ${h}`);
      }

      if (Array.isArray(row.public_api) && row.public_api.length > 0) {
        lines.push('');
        lines.push(`## Public API`);
        for (const entry of (row.public_api as Array<{ name?: string; type?: string; description?: string }>).slice(0, 20)) {
          lines.push(`- ${entry.name} (${entry.type ?? '?'})${entry.description ? ': ' + entry.description : ''}`);
        }
      }

      if (Array.isArray(row.data_flows) && row.data_flows.length > 0) {
        lines.push('');
        lines.push(`## Data Flows`);
        for (const f of row.data_flows) lines.push(`- ${f}`);
      }

      // Neighborhood — import graph proximity
      const imports = listImports(runtime.db, ws, filePath);
      const callers = listImportedBy(runtime.db, ws, filePath);

      if (imports.length > 0) {
        lines.push('');
        lines.push(`## Imports (${imports.length} direct dependencies)`);
        for (const imp of imports.slice(0, 20)) {
          const neighbor = getAtlasFile(runtime.db, ws, imp);
          lines.push(formatNeighborBlurb(imp, neighbor?.blurb || neighbor?.purpose, neighbor?.key_types));
        }
        if (imports.length > 20) lines.push(`  ... and ${imports.length - 20} more`);
      }

      if (callers.length > 0) {
        lines.push('');
        lines.push(`## Callers (${callers.length} files import this)`);
        for (const caller of callers.slice(0, 20)) {
          const neighbor = getAtlasFile(runtime.db, ws, caller);
          lines.push(formatNeighborBlurb(caller, neighbor?.blurb || neighbor?.purpose));
        }
        if (callers.length > 20) lines.push(`  ... and ${callers.length - 20} more`);
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n'),
        }],
      };
    },
  );
}
