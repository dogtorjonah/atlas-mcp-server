/**
 * atlas_commit — the primary mechanism for organic Atlas enrichment.
 *
 * This is the cornerstone of the heuristic-only Atlas model. Instead of a
 * cold LLM extraction pass that pre-computes semantic fields for every file,
 * atlas_commit captures knowledge from the agent that actually worked on the
 * code — the one with maximum context because it just wrote or reviewed it.
 *
 * How organic growth works:
 * 1. Atlas starts with heuristic-only data (AST symbols, edges, clusters, cross-refs)
 * 2. Semantic fields (purpose, blurb, patterns, hazards, etc.) begin empty
 * 3. As agents work with files, they call atlas_commit after review PASS
 * 4. Each commit merges the agent's knowledge into the Atlas record
 * 5. The most-touched files accumulate the richest metadata — exactly the right priority
 *
 * The result: a living knowledge base that grows organically from real work,
 * not a pre-computed snapshot that decays the moment it's generated.
 *
 * This tool enforces a single path: every call must include at least one
 * inline atlas_files field (purpose, patterns, hazards, etc.). No background
 * reextract enqueue fallback is used here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import {
  getAtlasFile,
  insertAtlasChangelog,
  upsertFileRecord,
} from '../db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeCurrentFileHash(filePath: string, sourceRoot: string): string | null {
  try {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(sourceRoot, filePath);
    const content = fs.readFileSync(absPath, 'utf8');
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null;
  }
}

const apiEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  signature: z.string().optional(),
  description: z.string().optional(),
});

const sourceHighlightSchema = z.object({
  id: z.number().int().min(1).describe('1-indexed snippet number for referencing ("see snippet 3")'),
  label: z.string().optional().describe('Short description ("main export", "error handling", "config parsing")'),
  startLine: z.number().int().min(1).describe('1-indexed start line in source file'),
  endLine: z.number().int().min(1).describe('1-indexed end line in source file'),
  content: z.string().describe('The actual source code text of this segment'),
});

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerCommitTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_commit',
    [
      'The primary mechanism for enriching Atlas records with semantic understanding.',
      'Atlas indexes start with heuristic-only data (AST symbols, structural edges, cross-references, clusters). Semantic fields begin empty — waiting for YOU to fill them in.',
      'When you see empty fields in an atlas_query lookup, that is your cue: you have the context to fill them. Call atlas_commit after review PASS and before releasing file ownership.',
      '',
      '## Field Guide — What to Write',
      '- **purpose**: 1-2 sentences. What this file does and why it exists. ("Core database layer — opens SQLite, runs migrations, exposes typed query helpers.")',
      '- **blurb**: Tweet-length, under 80 chars. Used in compact neighbor listings and search results. ("SQLite database layer with migration runner and typed queries")',
      '- **patterns**: Architectural patterns — facade, middleware chain, observer, singleton, builder, registry, etc. Not code style.',
      '- **hazards**: Correctness risks — race conditions, silent failures, mutation traps, ordering dependencies, implicit coupling. Not style nits or TODOs.',
      '- **conventions**: Project-specific conventions this file follows or establishes — naming schemes, error handling patterns, import ordering, test structure.',
      '- **key_types**: Important type definitions, interfaces, or enums that downstream consumers depend on.',
      '- **data_flows**: How data moves through this file — inputs, transformations, outputs, side effects.',
      '- **public_api**: Exported functions/classes with name, type, optional signature and description.',
      '- **source_highlights**: The 2-5 most important/tricky code sections. Skip boilerplate. Pick the segments a future agent NEEDS to see to understand the file. Can be disjointed — for a 2000-line file, select 3 key segments from different parts. Each has an id (1-indexed), optional label, line range, and content. Changelog entries can reference them ("refer to snippet 5").',
      '',
      'Fill in ANY empty fields you can — not just the ones related to your edit. You have the context right now; a future agent won\'t.',
      'The more agents commit knowledge, the richer the Atlas becomes. The most-touched files accumulate the best metadata — exactly the right priority.',
    ].join('\n'),
    {
      // ── Changelog fields (same as atlas_log) ──
      file_path: z.string().min(1),
      summary: z.string().min(1),
      patterns_added: z.array(z.string()).optional(),
      patterns_removed: z.array(z.string()).optional(),
      hazards_added: z.array(z.string()).optional(),
      hazards_removed: z.array(z.string()).optional(),
      cluster: z.string().optional(),
      breaking_changes: z.boolean().optional(),
      commit_sha: z.string().optional(),
      author_instance_id: z.string().optional(),
      author_engine: z.string().optional(),
      review_entry_id: z.string().optional(),

      // ── Inline atlas_files update fields (NEW) ──
      purpose: z.string().optional(),
      public_api: z.array(apiEntrySchema).optional(),
      conventions: z.array(z.string()).optional(),
      key_types: z.array(z.string()).optional(),
      data_flows: z.array(z.string()).optional(),
      hazards: z.array(z.string()).optional(),
      patterns: z.array(z.string()).optional(),
      dependencies: z.record(z.unknown()).optional(),
      blurb: z.string().optional(),
      source_highlights: z.array(sourceHighlightSchema).optional().describe(
        'AI-curated source snippets: select the most important/relevant disjointed sections of the file. Each snippet has id (1-indexed), optional label, startLine, endLine, and content. Replaces naive truncation with intelligent curation.',
      ),
    },
    async ({
      file_path,
      summary,
      patterns_added,
      patterns_removed,
      hazards_added,
      hazards_removed,
      cluster,
      breaking_changes,
      commit_sha,
      author_instance_id,
      author_engine,
      review_entry_id,
      // Inline atlas fields
      purpose,
      public_api,
      conventions,
      key_types,
      data_flows,
      hazards,
      patterns,
      dependencies,
      blurb,
      source_highlights,
    }: {
      file_path: string;
      summary: string;
      patterns_added?: string[];
      patterns_removed?: string[];
      hazards_added?: string[];
      hazards_removed?: string[];
      cluster?: string;
      breaking_changes?: boolean;
      commit_sha?: string;
      author_instance_id?: string;
      author_engine?: string;
      review_entry_id?: string;
      purpose?: string;
      public_api?: Array<{ name: string; type: string; signature?: string; description?: string }>;
      conventions?: string[];
      key_types?: string[];
      data_flows?: string[];
      hazards?: string[];
      patterns?: string[];
      dependencies?: Record<string, unknown>;
      blurb?: string;
      source_highlights?: Array<{ id: number; label?: string; startLine: number; endLine: number; content: string }>;
    }) => {
      const hasInlineUpdate = purpose !== undefined
        || public_api !== undefined
        || conventions !== undefined
        || key_types !== undefined
        || data_flows !== undefined
        || hazards !== undefined
        || patterns !== undefined
        || dependencies !== undefined
        || blurb !== undefined
        || source_highlights !== undefined;

      if (!hasInlineUpdate) {
        throw new Error(
          'atlas_commit requires at least one inline atlas field (purpose, public_api, conventions, key_types, data_flows, hazards, patterns, dependencies, blurb, or source_highlights).',
        );
      }

      // ── Step 1: Write changelog entry ──────────────────────────────────
      const entry = insertAtlasChangelog(runtime.db, {
        workspace: runtime.config.workspace,
        file_path,
        summary,
        patterns_added,
        patterns_removed,
        hazards_added,
        hazards_removed,
        cluster: cluster ?? null,
        breaking_changes,
        commit_sha: commit_sha ?? null,
        author_instance_id: author_instance_id ?? null,
        author_engine: author_engine ?? null,
        review_entry_id: review_entry_id ?? null,
        source: 'atlas_commit',
      });

      // ── Step 2: Inline atlas_files update (required) ───────────────────
      // Read existing record to merge with — we only overwrite fields the
      // agent explicitly provided, preserving everything else.
      const existing = getAtlasFile(runtime.db, runtime.config.workspace, file_path);

      const mergedPurpose = purpose ?? existing?.purpose ?? '';
      const mergedBlurb = blurb ?? existing?.blurb ?? '';
      const mergedPatterns = patterns ?? existing?.patterns ?? [];
      const mergedHazards = hazards ?? existing?.hazards ?? [];
      const mergedConventions = conventions ?? existing?.conventions ?? [];
      const mergedPublicApi = public_api ?? existing?.public_api ?? [];
      const mergedExports = public_api
        ? public_api.map((a) => ({ name: a.name, type: a.type }))
        : existing?.exports ?? [];
      const mergedKeyTypes = key_types ?? existing?.key_types ?? [];
      const mergedDataFlows = data_flows ?? existing?.data_flows ?? [];
      const mergedDependencies = dependencies ?? existing?.dependencies ?? {};
      const mergedSourceHighlights = source_highlights ?? existing?.source_highlights ?? [];

      upsertFileRecord(runtime.db, {
        workspace: runtime.config.workspace,
        file_path,
        file_hash: computeCurrentFileHash(file_path, runtime.config.sourceRoot) ?? existing?.file_hash ?? null,
        cluster: cluster ?? existing?.cluster ?? null,
        loc: existing?.loc ?? 0,
        blurb: mergedBlurb,
        purpose: mergedPurpose,
        public_api: mergedPublicApi,
        exports: mergedExports,
        patterns: mergedPatterns,
        dependencies: mergedDependencies,
        data_flows: mergedDataFlows,
        key_types: mergedKeyTypes,
        hazards: mergedHazards,
        conventions: mergedConventions,
        cross_refs: existing?.cross_refs ?? null,
        source_highlights: mergedSourceHighlights,
        language: existing?.language ?? 'typescript',
        extraction_model: `${author_engine ?? 'agent'}/atlas_commit`,
        last_extracted: new Date().toISOString(),
      });

      // ── Step 3: Build response ─────────────────────────────────────────
      const parts = [
        `Atlas commit #${entry.id} for ${file_path}`,
        `Summary: ${entry.summary}`,
      ];

      if (entry.patterns_added.length > 0) {
        parts.push(`Patterns added: ${entry.patterns_added.join(', ')}`);
      }
      if (entry.patterns_removed.length > 0) {
        parts.push(`Patterns removed: ${entry.patterns_removed.join(', ')}`);
      }
      if (entry.hazards_added.length > 0) {
        parts.push(`Hazards added: ${entry.hazards_added.join(', ')}`);
      }
      if (entry.hazards_removed.length > 0) {
        parts.push(`Hazards removed: ${entry.hazards_removed.join(', ')}`);
      }
      if (entry.breaking_changes) {
        parts.push('⚠ Breaking changes flagged');
      }

      const fields = [
        purpose !== undefined && 'purpose',
        public_api !== undefined && 'public_api',
        patterns !== undefined && 'patterns',
        hazards !== undefined && 'hazards',
        conventions !== undefined && 'conventions',
        key_types !== undefined && 'key_types',
        data_flows !== undefined && 'data_flows',
        dependencies !== undefined && 'dependencies',
        blurb !== undefined && 'blurb',
        source_highlights !== undefined && `source_highlights (${source_highlights?.length ?? 0} snippets)`,
      ].filter(Boolean);
      parts.push(`Atlas entry updated inline: ${fields.join(', ')}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: parts.join('\n'),
          },
          {
            type: 'text' as const,
            text: '💡 If you changed exports or public API, run `atlas_admin action=flush files=[...]` to refresh cross-references for downstream consumers.',
          },
        ],
      };
    },
  );
}
