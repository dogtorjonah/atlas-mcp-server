import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type {
  AtlasAdminRequest,
  AtlasAuditRequest,
  AtlasCommitRequest,
  AtlasGraphRequest,
  AtlasOperationOptions,
  AtlasQueryRequest,
  AtlasResult,
} from '../core/types.js';

export interface AtlasApplicationService {
  query(request: AtlasQueryRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>>;
  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>>;
  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>>;
  commit(request: AtlasCommitRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>>;
  admin(request: AtlasAdminRequest, options?: AtlasOperationOptions): Promise<AtlasResult<unknown>>;
}

export interface AtlasMcpAdapterOptions {
  workspace: string;
  name?: string;
  version?: string;
}

const boundedString = z.string().trim().min(1).max(8_192);
const pathString = z.string().trim().min(1).max(4_096);
const limit = z.number().int().min(1).max(500).optional();
const format = z.enum(['text', 'json']).optional();

const querySchema = z.object({
  action: z.enum(['search', 'lookup', 'brief', 'snippet', 'similar', 'plan_context', 'cluster', 'patterns', 'history', 'catalog', 'ask', 'snapshot', 'diff']),
  workspace: boundedString.optional(), format, limit, cursor: z.string().max(4_096).optional(),
  query: boundedString.optional(), workspaces: z.array(boundedString).max(200).optional(),
  file_path: pathString.optional(), path_prefix: pathString.optional(), cluster: boundedString.optional(),
  include_test_files: z.boolean().optional(), include_source: z.boolean().optional(),
  include_neighbors: z.boolean().optional(), include_cross_refs: z.boolean().optional(),
  source_start: z.number().int().min(1).max(10_000_000).optional(),
  source_end: z.number().int().min(1).max(10_000_000).optional(),
  symbol: boundedString.optional(), start_line: z.number().int().min(1).max(10_000_000).optional(),
  end_line: z.number().int().min(1).max(10_000_000).optional(), min_score: z.number().finite().optional(),
  neighbor_depth: z.number().int().min(0).max(5).optional(), character_budget: z.number().int().min(1).max(200_000).optional(),
  pattern: boundedString.optional(), mode: boundedString.optional(), since: boundedString.optional(), until: boundedString.optional(),
  order: z.enum(['asc', 'desc']).optional(), bucket: z.enum(['day', 'week', 'month']).optional(),
  group_by: z.enum(['file_path', 'cluster', 'principal_id', 'runtime_name', 'verification_status']).optional(),
  breaking_changes: z.boolean().optional(), principal_id: boundedString.optional(), runtime_name: boundedString.optional(),
  verification_status: boundedString.optional(), field: z.enum(['blurb', 'purpose']).optional(),
  at: z.union([z.string(), z.number().int().positive()]).optional(), max_lines: z.number().int().min(1).max(5_000).optional(),
  from: z.union([z.string(), z.number().int().positive()]).optional(), to: z.union([z.string(), z.number().int().positive()]).optional(),
  context_lines: z.number().int().min(0).max(20).optional(),
}).strict();

const graphSchema = z.object({
  action: z.enum(['impact', 'neighbors', 'trace', 'cycles', 'reachability', 'graph', 'cluster']),
  workspace: boundedString.optional(), format, limit, file_path: pathString.optional(), symbol: boundedString.optional(),
  depth: z.number().int().min(0).max(20).optional(), direction: z.enum(['imports', 'importers', 'both']).optional(),
  edge_types: z.array(boundedString).max(200).optional(), include_references: z.boolean().optional(),
  include_symbols: z.boolean().optional(), include_test_files: z.boolean().optional(),
  from: pathString.optional(), to: pathString.optional(), from_symbol: boundedString.optional(), to_symbol: boundedString.optional(),
  max_hops: z.number().int().min(1).max(100).optional(), weighted: z.boolean().optional(),
  min_size: z.number().int().min(1).max(2_000).optional(), mode: z.enum(['dead_exports', 'dead_files', 'path_query', 'entrypoints']).optional(),
  max_nodes: z.number().int().min(1).max(2_000).optional(), max_edges: z.number().int().min(1).max(10_000).optional(),
  cluster: boundedString.optional(), cursor: z.string().max(4_096).optional(),
}).strict();

const auditSchema = z.object({
  action: z.enum(['gaps', 'smells', 'hotspots']), workspace: boundedString.optional(), format, limit,
  cluster: boundedString.optional(), file_path: pathString.optional(), include_test_files: z.boolean().optional(),
  gap_types: z.array(boundedString).max(200).optional(), min_severity: boundedString.optional(),
  weights: z.record(z.number().finite().nonnegative()).optional(), since: boundedString.optional(),
  top_n: z.number().int().min(1).max(500).optional(), cursor: z.string().max(4_096).optional(),
}).strict();

const principalSchema = z.object({
  id: boundedString.optional(), display_name: boundedString.optional(), kind: z.enum(['human', 'service', 'automation', 'unknown']),
}).strict();
const evidenceSchema = z.object({
  namespace: boundedString, schema_version: boundedString, provider_id: boundedString, provider_version: boundedString,
  evidence_id: boundedString,
  subject: z.object({ kind: z.enum(['file', 'symbol', 'snapshot', 'changelog', 'operation']), workspace: boundedString, key: boundedString }).strict(),
  kind: z.enum(['authored', 'observed', 'modified', 'committed', 'reviewed', 'referenced', 'other']),
  principal: principalSchema.optional(), occurred_at: boundedString.optional(), observed_at: boundedString,
  authority: z.enum(['caller', 'repository', 'provider', 'verified-external']),
  confidence: z.enum(['high', 'medium', 'low', 'unknown']), source_ref: boundedString.optional(),
  payload: z.unknown(), payload_hash: boundedString,
}).strict();
const commitSchema = z.object({
  workspace: boundedString.optional(), format,
  file_path: pathString, changelog_entry: boundedString, idempotency_key: boundedString.optional(),
  expected_version: boundedString.optional(), purpose: boundedString.optional(), blurb: boundedString.optional(),
  cluster: boundedString.optional(), tags: z.array(boundedString).max(200).optional(),
  conventions: z.array(boundedString).max(200).optional(), key_types: z.array(boundedString).max(200).optional(),
  data_flows: z.array(boundedString).max(200).optional(),
  public_api: z.array(z.object({ name: boundedString, type: boundedString, signature: boundedString.optional(), description: boundedString.optional() }).strict()).max(200).optional(),
  source_highlights: z.array(z.object({
    id: z.number().int().positive().optional(), label: boundedString,
    start_line: z.number().int().min(1).max(10_000_000), end_line: z.number().int().min(1).max(10_000_000),
    content: z.string().max(200_000).optional(),
  }).strict()).max(50).optional(),
  patterns: z.array(boundedString).max(200).optional(), hazards: z.array(boundedString).max(200).optional(),
  patterns_added: z.array(boundedString).max(200).optional(), patterns_removed: z.array(boundedString).max(200).optional(),
  hazards_added: z.array(boundedString).max(200).optional(), hazards_removed: z.array(boundedString).max(200).optional(),
  breaking_changes: z.boolean().optional(), repository_revision: boundedString.optional(),
  attribution: z.object({
    principal: principalSchema.optional(), runtime: z.object({ name: boundedString.optional(), version: boundedString.optional() }).strict().optional(),
    tool_id: boundedString.optional(), source: boundedString.optional(),
  }).strict().optional(),
  evidence: z.array(evidenceSchema).max(128).optional(), response_detail: z.enum(['compact', 'full']).optional(),
}).strict();

const adminSchema = z.object({
  action: z.enum(['index', 'migrate', 'backup', 'doctor', 'workspace_list']), workspace: boundedString.optional(), format,
  paths: z.array(pathString).min(1).max(4_096).optional(), full: z.boolean().optional(),
  phase: z.enum(['all', 'discovery', 'parse', 'crossref', 'embeddings']).optional(), force: z.boolean().optional(),
  dry_run: z.boolean().optional(), backup: z.boolean().optional(), target_generation: boundedString.optional(),
  label: z.string().trim().min(1).max(64).optional(), protected: z.boolean().optional(),
  checks: z.array(boundedString).max(200).optional(), include_optional: z.boolean().optional(), include_unavailable: z.boolean().optional(),
}).strict();

function camelize(value: unknown, parentKey = ''): unknown {
  if (parentKey === 'payload') return value;
  if (Array.isArray(value)) return value.map((item) => camelize(item, parentKey));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const camel = key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    output[camel] = camelize(child, key);
  }
  return output;
}

function structured(result: AtlasResult<unknown>, selectedFormat: 'text' | 'json' = 'text') {
  const body = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: selectedFormat === 'json' ? JSON.stringify(body) : JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: !result.ok,
  };
}

function workspaceFailure(workspace: string, requested: string): AtlasResult<unknown> {
  return {
    protocol_version: '1', ok: false, request_id: 'mcp-workspace-validation',
    error: { code: 'ATLAS_WORKSPACE_NOT_FOUND', message: `Workspace ${requested} is not registered by this server.`, retryable: false },
    meta: { workspace, capabilities: {}, warnings: [], extensions: [] },
  };
}

function optionsFrom(extra: { signal?: AbortSignal }): AtlasOperationOptions {
  return extra.signal ? { signal: extra.signal } : {};
}

export function registerAtlasMcpTools(
  server: McpServer,
  service: AtlasApplicationService,
  options: AtlasMcpAdapterOptions,
): void {
  const invoke = async (
    family: 'query' | 'graph' | 'audit' | 'commit' | 'admin',
    args: Record<string, unknown>,
    extra: { signal?: AbortSignal },
  ) => {
    const selectedFormat = args.format === 'json' ? 'json' : 'text';
    const requestedWorkspace = typeof args.workspace === 'string' ? args.workspace : options.workspace;
    if ((family === 'commit' || family === 'admin') && requestedWorkspace !== options.workspace) {
      return structured(workspaceFailure(options.workspace, requestedWorkspace), selectedFormat);
    }
    const wire = { ...args };
    delete wire.format;
    if (family === 'commit' || family === 'admin') delete wire.workspace;
    const request = camelize(wire) as never;
    const callOptions = optionsFrom(extra);
    const result = family === 'query' ? await service.query(request, callOptions)
      : family === 'graph' ? await service.graph(request, callOptions)
        : family === 'audit' ? await service.audit(request, callOptions)
          : family === 'commit' ? await service.commit(request, callOptions)
            : await service.admin(request, callOptions);
    return structured(result, selectedFormat);
  };

  server.registerTool('atlas_query', { description: 'Query Atlas through the structured application service.', inputSchema: querySchema },
    async (args, extra) => invoke('query', args, extra));
  server.registerTool('atlas_graph', { description: 'Analyze Atlas dependency and reference graphs.', inputSchema: graphSchema },
    async (args, extra) => invoke('graph', args, extra));
  server.registerTool('atlas_audit', { description: 'Run bounded Atlas completeness and risk audits.', inputSchema: auditSchema },
    async (args, extra) => invoke('audit', args, extra));
  server.registerTool('atlas_commit', { description: 'Atomically commit semantic metadata, changelog, attribution, and evidence.', inputSchema: commitSchema },
    async (args, extra) => invoke('commit', args, extra));
  server.registerTool('atlas_admin', { description: 'Run typed non-destructive Atlas administration.', inputSchema: adminSchema },
    async (args, extra) => invoke('admin', args, extra));

  const diffSchema = querySchema.pick({ workspace: true, format: true, file_path: true, from: true, to: true, context_lines: true }).extend({
    file_path: pathString, from: z.union([z.string(), z.number().int().positive()]).optional(), to: z.union([z.string(), z.number().int().positive()]).optional(),
    mode: z.enum(['unified', 'stat']).optional(),
  }).strict();
  server.registerTool('atlas_diff', { description: 'Compare two retained Atlas snapshots.', inputSchema: diffSchema },
    async (args, extra) => invoke('query', { ...args, action: 'diff' }, extra));
  const snapshotSchema = querySchema.pick({ workspace: true, format: true, file_path: true, at: true, start_line: true, end_line: true, max_lines: true }).extend({
    changelog_id: z.number().int().positive().optional(),
  }).strict();
  server.registerTool('atlas_snapshot', { description: 'Read a retained Atlas source snapshot.', inputSchema: snapshotSchema },
    async (args, extra) => invoke('query', { ...args, action: 'snapshot', at: args.at ?? args.changelog_id }, extra));

  const changelogSchema = querySchema.omit({ action: true }).extend({ action: z.literal('query').optional() }).strict();
  server.registerTool('atlas_changelog', { description: 'Deprecated compatibility alias for atlas_query(history).', inputSchema: changelogSchema },
    async (args, extra) => invoke('query', { ...args, action: 'history' }, extra));
  const changelogDiffSchema = diffSchema.omit({ file_path: true }).extend({
    changelog_id: z.number().int().positive(),
  }).strict();
  server.registerTool('atlas_changelog_diff', { description: 'Deprecated changelog-first alias for atlas_diff.', inputSchema: changelogDiffSchema },
    async (args, extra) => invoke('query', { ...args, action: 'diff' }, extra));

  const unavailableSchema = z.object({ workspace: boundedString.optional(), format }).strict();
  for (const name of ['atlas_worktree_status', 'atlas_worktree_diff'] as const) {
    server.registerTool(name, { description: 'Optional Node worktree capability.', inputSchema: unavailableSchema }, async (args) => structured({
      protocol_version: '1', ok: false, request_id: `${name}-unavailable`,
      error: { code: 'ATLAS_CAPABILITY_UNAVAILABLE', message: `${name} requires the optional Node repository host.`, retryable: false },
      meta: { workspace: typeof args.workspace === 'string' ? args.workspace : options.workspace, capabilities: { worktree: 'unavailable' }, warnings: [], extensions: [] },
    }, args.format === 'json' ? 'json' : 'text'));
  }
}

export function createAtlasMcpServer(
  service: AtlasApplicationService,
  options: AtlasMcpAdapterOptions,
): McpServer {
  const server = new McpServer({
    name: options.name ?? '@voxxo/atlas',
    version: options.version ?? '1.0.0',
  });
  registerAtlasMcpTools(server, service, options);
  return server;
}
