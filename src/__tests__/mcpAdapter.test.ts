import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type {
  AtlasAdminRequest,
  AtlasAuditRequest,
  AtlasCommitRequest,
  AtlasGraphRequest,
  AtlasOperationOptions,
  AtlasQueryRequest,
  AtlasResult,
} from '../core/types.js';
import { createAtlasMcpServer, type AtlasApplicationService } from '../mcp/index.js';

function success(data: unknown): AtlasResult<unknown> {
  return {
    protocol_version: '1',
    ok: true,
    request_id: 'request-1',
    data,
    meta: { workspace: 'fixture', capabilities: {}, warnings: [], extensions: [] },
  };
}

class RecordingService implements AtlasApplicationService {
  readonly calls: Array<{ family: string; request: unknown; options?: AtlasOperationOptions }> = [];

  private record(family: string, request: unknown, options?: AtlasOperationOptions) {
    this.calls.push({ family, request, options });
    return Promise.resolve(success({ family, request }));
  }

  query(request: AtlasQueryRequest, options?: AtlasOperationOptions) { return this.record('query', request, options); }
  graph(request: AtlasGraphRequest, options?: AtlasOperationOptions) { return this.record('graph', request, options); }
  audit(request: AtlasAuditRequest, options?: AtlasOperationOptions) { return this.record('audit', request, options); }
  commit(request: AtlasCommitRequest, options?: AtlasOperationOptions) { return this.record('commit', request, options); }
  admin(request: AtlasAdminRequest, options?: AtlasOperationOptions) { return this.record('admin', request, options); }
}

async function connected(service: AtlasApplicationService) {
  const server = createAtlasMcpServer(service, { workspace: 'fixture', version: 'test' });
  const client = new Client({ name: 'atlas-test', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('MCP adapter registers the canonical tool surface and converts wire names without mutating evidence payloads', async () => {
  const service = new RecordingService();
  const { server, client } = await connected(service);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'atlas_admin', 'atlas_audit', 'atlas_changelog', 'atlas_changelog_diff', 'atlas_commit',
      'atlas_diff', 'atlas_graph', 'atlas_query', 'atlas_snapshot', 'atlas_worktree_diff', 'atlas_worktree_status',
    ]);

    const query = await client.callTool({
      name: 'atlas_query',
      arguments: { action: 'lookup', workspace: 'fixture', file_path: 'src/index.ts', include_source: true, format: 'json' },
    });
    assert.equal(query.isError, false);
    assert.deepEqual((query.structuredContent as { data: { request: unknown } }).data.request, {
      action: 'lookup', workspace: 'fixture', filePath: 'src/index.ts', includeSource: true,
    });

    await client.callTool({
      name: 'atlas_commit',
      arguments: {
        workspace: 'fixture', file_path: 'src/index.ts', changelog_entry: 'Document the MCP boundary.',
        evidence: [{
          namespace: 'test', schema_version: '1', provider_id: 'fixture', provider_version: '1', evidence_id: 'e-1',
          subject: { kind: 'file', workspace: 'fixture', key: 'src/index.ts' }, kind: 'observed',
          observed_at: '2026-07-14T00:00:00.000Z', authority: 'caller', confidence: 'high',
          payload: { source_field: 'must-remain-snake-case' }, payload_hash: 'hash',
        }],
      },
    });
    const commit = service.calls.at(-1)?.request as AtlasCommitRequest;
    assert.equal(commit.filePath, 'src/index.ts');
    assert.equal(commit.evidence?.[0]?.schemaVersion, '1');
    assert.deepEqual(commit.evidence?.[0]?.payload, { source_field: 'must-remain-snake-case' });

    await client.callTool({
      name: 'atlas_changelog_diff', arguments: { changelog_id: 42, from: 'prev', to: 'changelog' },
    });
    assert.deepEqual(service.calls.at(-1)?.request, {
      action: 'diff', changelogId: 42, from: 'prev', to: 'changelog',
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP adapter rejects unknown fields and reports cross-workspace writes as structured failures', async () => {
  const service = new RecordingService();
  const { server, client } = await connected(service);
  try {
    const invalid = await client.callTool({
      name: 'atlas_query', arguments: { action: 'lookup', file_path: 'src/index.ts', mystery: true },
    });
    assert.equal(invalid.isError, true);

    const result = await client.callTool({
      name: 'atlas_admin', arguments: { action: 'doctor', workspace: 'other' },
    });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'ATLAS_WORKSPACE_NOT_FOUND');
    assert.equal(service.calls.length, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
