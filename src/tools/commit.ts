/**
 * atlas_commit — unified changelog + inline atlas update tool.
 *
 * Replaces the two-step atlas_log + atlas_flush workflow with a single tool
 * that does both: records what changed (changelog) and updates the
 * atlas_files row directly with the coding AI's own extraction. The coding AI
 * has maximum context — it just wrote the code — so its extraction is
 * higher-quality than a cold re-extraction by a cheaper model.
 *
 * This tool enforces a single path: every call must include at least one
 * inline atlas_files field (purpose, patterns, hazards, etc.). No background
 * reextract enqueue fallback is used here.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import type { AtlasChangelogRecord } from '../db.js';
import {
  getAtlasFile,
  insertAtlasChangelog,
  upsertChangelogEmbedding,
  upsertFileRecord,
  upsertEmbedding,
} from '../db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildChangelogEmbeddingInput(entry: AtlasChangelogRecord): string {
  return [
    entry.summary,
    ...entry.patterns_added,
    ...entry.patterns_removed,
    ...entry.hazards_added,
    ...entry.hazards_removed,
  ].join(' ').trim();
}

function buildAtlasEmbeddingInput(fields: {
  purpose?: string;
  blurb?: string;
  patterns?: string[];
  hazards?: string[];
  conventions?: string[];
}): string {
  return [
    fields.purpose ?? '',
    fields.blurb ?? '',
    ...(fields.patterns ?? []),
    ...(fields.hazards ?? []),
    ...(fields.conventions ?? []),
  ].join('\n').trim();
}

const apiEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  signature: z.string().optional(),
  description: z.string().optional(),
});

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerCommitTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_commit',
    [
      'Strategic post-edit tool for recording why a file changed and updating its Atlas record in the same call.',
      'Use atlas_commit after a reviewed edit when you want the Atlas to stay aligned with the code without waiting for a cold re-extraction pass.',
      'What it gives you: a durable changelog entry for the change rationale plus an inline update to the file atlas entry, including purpose, public API, conventions, key types, data flows, hazards, patterns, and dependency metadata. This is the right tool when the coding agent has the freshest understanding of the file and should write that knowledge back immediately.',
      'Workflow hints: call atlas_commit after review PASS and before releasing file ownership; use it for focused metadata corrections after refactors, API changes, or hazard updates; include the most important atlas fields you actually changed instead of trying to restate the whole file from scratch.',
      'This matters even more now because Atlas consumers rely on richer pipeline outputs such as AST-verified structure, deterministic flow edges, heuristic cross-reference context, and community clustering. atlas_commit keeps the human and machine rationale attached to those evolving graph facts.',
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
    }) => {
      const hasInlineUpdate = purpose !== undefined
        || public_api !== undefined
        || conventions !== undefined
        || key_types !== undefined
        || data_flows !== undefined
        || hazards !== undefined
        || patterns !== undefined
        || dependencies !== undefined
        || blurb !== undefined;

      if (!hasInlineUpdate) {
        throw new Error(
          'atlas_commit requires at least one inline atlas field (purpose, public_api, conventions, key_types, data_flows, hazards, patterns, dependencies, or blurb).',
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

      // Embed the changelog entry
      if (runtime.provider) {
        const changelogText = buildChangelogEmbeddingInput(entry);
        if (changelogText) {
          try {
            const embedding = await runtime.provider.embedText(changelogText);
            upsertChangelogEmbedding(runtime.db, entry.id, embedding);
          } catch {
            // Embedding failures are non-fatal; FTS remains available.
          }
        }
      }

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

      upsertFileRecord(runtime.db, {
        workspace: runtime.config.workspace,
        file_path,
        file_hash: existing?.file_hash ?? null,
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
        language: existing?.language ?? 'typescript',
        extraction_model: `${author_engine ?? 'agent'}/atlas_commit`,
        last_extracted: new Date().toISOString(),
      });

      // Re-embed the updated atlas entry
      if (runtime.provider) {
        const atlasText = buildAtlasEmbeddingInput({
          purpose: mergedPurpose,
          blurb: mergedBlurb,
          patterns: mergedPatterns,
          hazards: mergedHazards,
          conventions: mergedConventions,
        });
        if (atlasText) {
          try {
            const embedding = await runtime.provider.embedText(atlasText);
            upsertEmbedding(runtime.db, runtime.config.workspace, file_path, embedding);
          } catch {
            // Non-fatal — atlas entry still updated, just not re-embedded.
          }
        }
      }

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
