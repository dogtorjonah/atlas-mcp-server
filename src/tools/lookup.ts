import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, listImports, listImportedBy } from '../db.js';
import { trackQuery } from '../queryLog.js';
import { discoverWorkspaces } from './bridge.js';

interface ChangelogRow {
  id: number;
  summary: string;
  patterns_added: string;
  hazards_added: string;
  author_instance_id: string | null;
  author_engine: string | null;
  verification_status: string;
  created_at: string;
}

function getRecentChangelog(db: AtlasDatabase, workspace: string, filePath: string, limit = 5): ChangelogRow[] {
  try {
    const rows = db.prepare(
      `SELECT id, summary, patterns_added, hazards_added, author_instance_id, author_engine,
              verification_status, created_at
       FROM atlas_changelog
       WHERE workspace = ? AND file_path = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(workspace, filePath, limit) as ChangelogRow[];
    return rows;
  } catch {
    return [];
  }
}

function formatChangelogRow(row: ChangelogRow, index: number): string {
  const ts = row.created_at ? new Date(row.created_at).toLocaleString() : 'unknown';
  const verified = row.verification_status === 'confirmed' ? '✅' : row.verification_status === 'pending' ? '⏳' : '❌';
  let lines = `  ${index + 1}. ${row.summary} ${verified}`;
  lines += `\n     Author: ${row.author_instance_id ?? 'unknown'} | ${row.author_engine ?? '?'} | ${ts}`;

  try {
    const patterns = JSON.parse(row.patterns_added) as string[];
    if (patterns.length > 0) {
      lines += `\n     Patterns added: ${patterns.join(', ')}`;
    }
    const hazards = JSON.parse(row.hazards_added) as string[];
    if (hazards.length > 0) {
      lines += `\n     Hazards added: ${hazards.join(', ')}`;
    }
  } catch { /* ignore parse errors */ }

  return lines;
}

async function readSourceFile(sourceRoot: string, filePath: string): Promise<{ hash: string; content: string } | null> {
  try {
    const content = await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
    const hash = createHash('sha1').update(content).digest('hex');
    return { hash, content };
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
      includeSource: z.boolean().optional().describe('Include source code in output (default false). Set true for full source.'),
    },
    async ({ filePath, workspace, includeSource }: { filePath: string; workspace?: string; includeSource?: boolean }) => {
      const ws = workspace ?? runtime.config.workspace;

      // Resolve DB and sourceRoot — local workspace or cross-workspace via bridge discovery
      let db: AtlasDatabase = runtime.db;
      let sourceRoot: string = runtime.config.sourceRoot;
      if (workspace && workspace !== runtime.config.workspace) {
        const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
        const target = allDbs.find((d) => d.workspace === workspace);
        if (!target) {
          const available = allDbs.map((d) => d.workspace).join(', ');
          return { content: [{ type: 'text', text: `Workspace "${workspace}" not found. Available: ${available}` }] };
        }
        db = target.db;
        sourceRoot = target.sourceRoot;
      }

      const row = getAtlasFile(db, ws, filePath);
      trackQuery(filePath, row ? [row.id] : [], row ? [row.file_path] : []);
      if (!row) {
        return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
      }

      const sourceFile = await readSourceFile(sourceRoot, filePath);
      const stale = sourceFile && row.file_hash && sourceFile.hash !== row.file_hash
        ? '\n⚠️  STALE: file has changed since last extraction.\n'
        : '';

      // Build full extraction section
      const lines: string[] = [];
      lines.push(`# ${row.file_path}`);
      if (stale) lines.push(stale);

      // ── Recent Changes (atlas_changelog consumer) ──
      const recentChanges = getRecentChangelog(db, ws, filePath, 5);
      if (recentChanges.length > 0) {
        lines.push('');
        lines.push(`## Recent Changes`);
        lines.push('These entries were written by agents after editing this file — capturing the "why" behind recent changes:');
        recentChanges.forEach((entry, i) => {
          lines.push(formatChangelogRow(entry, i));
        });
      }

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

      if (row.dependencies) {
        const deps = row.dependencies as { imports?: string[]; imported_by?: string[] };
        if (deps.imports?.length) {
          lines.push('');
          lines.push(`## Dependencies (imports)`);
          lines.push(deps.imports.join(', '));
        }
        if (deps.imported_by?.length) {
          lines.push('');
          lines.push(`## Dependencies (imported by)`);
          lines.push(deps.imported_by.join(', '));
        }
      }

      if (Array.isArray(row.data_flows) && row.data_flows.length > 0) {
        lines.push('');
        lines.push(`## Data Flows`);
        for (const f of row.data_flows) lines.push(`- ${f}`);
      }

      if (Array.isArray(row.key_types) && row.key_types.length > 0) {
        lines.push('');
        lines.push(`## Key Types`);
        for (const t of (row.key_types as Array<{ name?: string; kind?: string; exported?: boolean; description?: string }>).slice(0, 20)) {
          lines.push(`- \`${t.name}\` (${t.kind ?? '?'}${t.exported ? ', exported' : ''})${t.description ? ` — ${t.description}` : ''}`);
        }
      }

      if (row.cross_refs?.symbols) {
        const syms = Object.entries(row.cross_refs.symbols);
        if (syms.length > 0) {
          const totalRefs = row.cross_refs.total_cross_references ?? 0;
          lines.push('');
          lines.push(`## Cross-References (${totalRefs} total)`);
          for (const [name, info] of syms) {
            const callerLines = info.call_sites?.map((cs: { file: string; usage_type: string; count: number; context: string }) =>
              `    ${cs.file} (${cs.usage_type}, ${cs.count}x): ${cs.context}`) || [];
            lines.push(`- \`${name}\` (${info.type}, blast_radius=${info.blast_radius}, ${info.total_usages} usages)`);
            if (callerLines.length > 0) lines.push(callerLines.join('\n'));
          }
        }
      }

      // Neighborhood — import graph proximity
      const imports = listImports(db, ws, filePath);
      const callers = listImportedBy(db, ws, filePath);

      if (imports.length > 0) {
        lines.push('');
        lines.push(`## Imports (${imports.length} direct dependencies)`);
        for (const imp of imports.slice(0, 20)) {
          const neighbor = getAtlasFile(db, ws, imp);
          lines.push(formatNeighborBlurb(imp, neighbor?.blurb || neighbor?.purpose, neighbor?.key_types));
        }
        if (imports.length > 20) lines.push(`  ... and ${imports.length - 20} more`);
      }

      if (callers.length > 0) {
        lines.push('');
        lines.push(`## Callers (${callers.length} files import this)`);
        for (const caller of callers.slice(0, 20)) {
          const neighbor = getAtlasFile(db, ws, caller);
          lines.push(formatNeighborBlurb(caller, neighbor?.blurb || neighbor?.purpose));
        }
        if (callers.length > 20) lines.push(`  ... and ${callers.length - 20} more`);
      }

      // ── Source code (opt-in via includeSource: true) ──
      const shouldIncludeSource = includeSource === true;
      if (shouldIncludeSource && sourceFile) {
        const sourceLines = sourceFile.content.split('\n');
        const MAX_SOURCE_LINES = 500;
        const truncated = sourceLines.length > MAX_SOURCE_LINES;
        const displayLines = truncated ? sourceLines.slice(0, MAX_SOURCE_LINES) : sourceLines;
        lines.push('');
        lines.push(`## Source (${sourceLines.length} lines${truncated ? `, showing first ${MAX_SOURCE_LINES}` : ''})`);
        lines.push('```');
        lines.push(displayLines.join('\n'));
        lines.push('```');
        if (truncated) {
          lines.push(`\n... ${sourceLines.length - MAX_SOURCE_LINES} more lines. Use the Read tool to see the full file.`);
        }
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
