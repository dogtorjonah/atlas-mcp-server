import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  AtlasChangelogEntryWire,
  AtlasFailure,
  AtlasFileWire,
  AtlasGraphEdgeWire,
  AtlasGraphRequest,
  AtlasListData,
  AtlasProvenanceEvidenceWire,
  AtlasQueryRequest,
  AtlasQueryWireRequest,
  AtlasResult,
  AtlasSymbolIdentityWire,
} from '../core/types.js';

interface CoreTypesFixture {
  schema_version: 1;
  file: AtlasFileWire;
  symbol_identity: AtlasSymbolIdentityWire;
  graph_edge: AtlasGraphEdgeWire;
  changelog: AtlasChangelogEntryWire;
  query_request: AtlasQueryWireRequest;
  result: AtlasResult<AtlasListData<AtlasFileWire>>;
  failure: AtlasFailure;
}

const evidence = {
  namespace: 'fixture.provenance',
  schema_version: '1',
  provider_id: 'fixture-repository',
  provider_version: '1.0.0',
  evidence_id: 'evidence-0001',
  subject: {
    kind: 'file',
    workspace: 'fixture-small',
    key: 'src/index.ts',
  },
  kind: 'reviewed',
  principal: {
    id: 'fixture-reviewer',
    display_name: 'Fixture Reviewer',
    kind: 'automation',
  },
  occurred_at: '2025-01-02T03:05:00.000Z',
  observed_at: '2025-01-02T03:05:01.000Z',
  authority: 'verified-external',
  confidence: 'high',
  source_ref: 'fixture://small/review/1',
  payload: {
    verdict: 'pass',
    checks: ['paths', 'imports', 'history'],
  },
  payload_hash: 'sha256:fixture-evidence-0001',
} satisfies AtlasProvenanceEvidenceWire;

const file = {
  id: 1,
  workspace: 'fixture-small',
  file_path: 'src/index.ts',
  file_hash: 'sha256:fixture-file-0001',
  cluster: 'src',
  line_count: 11,
  blurb: 'Fixture entrypoint',
  purpose: 'Exports deterministic formatting and arithmetic fixture behavior.',
  public_api: [
    { name: 'describeTotal', type: 'function', signature: '(values: number[]) => string' },
  ],
  exports: [{ name: 'describeTotal', type: 'function' }],
  patterns: ['pure-function'],
  tags: ['fixture', 'entrypoint'],
  dependencies: {
    imports: ['src/format.ts', 'src/math/index.ts'],
  },
  data_flows: ['numbers -> sum -> formatted string'],
  key_types: [],
  hazards: ['Input order is significant.'],
  ranged_hazards: [
    { text: 'Input order is significant.', start_line: 4, end_line: 9 },
  ],
  conventions: ['Repository-relative POSIX paths'],
  cross_references: null,
  source_highlights: [
    {
      id: 1,
      label: 'Deterministic public entrypoint',
      start_line: 4,
      end_line: 9,
      content: 'export function describeTotal(values: number[]): string {\n  return formatTotal(sum(values));\n}',
    },
  ],
  language: 'typescript',
  extraction_provider: null,
  extracted_at: '2025-01-02T03:04:05.000Z',
} satisfies AtlasFileWire;

const expectedFixture = {
  schema_version: 1,
  file,
  symbol_identity: {
    id: 7,
    workspace: 'fixture-small',
    file_path: 'src/index.ts',
    symbol: 'describeTotal',
    purpose: 'Formats the deterministic aggregate exposed by the fixture entrypoint.',
    hazards: ['Input order is significant.'],
    attribution: {
      principal: {
        id: 'fixture-author',
        display_name: 'Fixture Author',
        kind: 'automation',
      },
      runtime: { name: 'fixture-builder', version: '1.0.0' },
      tool_id: 'fixture-materializer',
      source: 'fixture',
    },
    created_at: '2025-01-02T03:04:05.000Z',
    updated_at: '2025-01-02T03:05:00.000Z',
  },
  graph_edge: {
    id: 11,
    workspace: 'fixture-small',
    source_file: 'src/index.ts',
    target_file: 'src/math/index.ts',
    source_symbol_id: 7,
    target_symbol_id: 8,
    edge_type: 'import',
    usage_count: 1,
    confidence: 1,
    provenance: 'ast',
    last_verified_at: '2025-01-02T03:04:05.000Z',
  },
  changelog: {
    id: 21,
    workspace: 'fixture-small',
    file_path: 'src/index.ts',
    summary: 'Created the deterministic fixture entrypoint.',
    patterns_added: ['pure-function'],
    patterns_removed: [],
    hazards_added: ['Input order is significant.'],
    hazards_removed: [],
    cluster: 'src',
    breaking_changes: false,
    repository_revision: 'fixture-revision-0001',
    attribution: {
      principal: {
        id: 'fixture-author',
        display_name: 'Fixture Author',
        kind: 'automation',
      },
      runtime: { name: 'fixture-builder', version: '1.0.0' },
      tool_id: 'fixture-materializer',
      source: 'fixture',
    },
    evidence: [evidence],
    source: 'atlas_commit',
    verification_status: 'verified',
    verification_notes: 'Fixture evidence is byte-stable.',
    created_at: '2025-01-02T03:05:00.000Z',
  },
  query_request: {
    action: 'history',
    workspace: 'fixture-small',
    format: 'json',
    limit: 20,
    file_path: 'src/index.ts',
    mode: 'entries',
    order: 'asc',
    principal_id: 'fixture-author',
    verification_status: 'verified',
  },
  result: {
    protocol_version: '1',
    ok: true,
    request_id: 'request-0001',
    data: { items: [file] },
    meta: {
      workspace: 'fixture-small',
      repository_id: 'repository-fixture-small',
      capabilities: {
        lexical_search: 'available',
        vector_search: 'disabled',
      },
      warnings: [],
      page: {
        next_cursor: null,
        returned: 1,
        total: 1,
        truncated: false,
      },
      evidence: {
        authority: 'mixed',
        freshness: 'current',
        confidence: 'high',
        completeness: 'complete',
      },
      extensions: [evidence],
    },
  },
  failure: {
    protocol_version: '1',
    ok: false,
    request_id: 'request-0002',
    error: {
      code: 'ATLAS_INVALID_REQUEST',
      message: 'start_line must be less than or equal to end_line',
      retryable: false,
      details: { field: 'start_line' },
      actions: [{ label: 'Correct the requested line range.' }],
    },
    meta: {
      capabilities: {},
      warnings: [],
      extensions: [],
    },
  },
} satisfies CoreTypesFixture;

const programmaticQuery = {
  action: 'history',
  workspace: 'fixture-small',
  filePath: 'src/index.ts',
  principalId: 'fixture-author',
  verificationStatus: 'verified',
} satisfies AtlasQueryRequest;

const programmaticGraph = {
  action: 'impact',
  workspace: 'fixture-small',
  filePath: 'src/index.ts',
  includeReferences: true,
  edgeTypes: ['import'],
} satisfies AtlasGraphRequest;

const fixturePath = fileURLToPath(
  new URL('../../test/fixtures/contracts/core-types.json', import.meta.url),
);

test('core records and result envelopes have a byte-exact public wire fixture', async () => {
  const raw = await readFile(fixturePath, 'utf8');
  const expected = `${JSON.stringify(expectedFixture, null, 2)}\n`;

  assert.equal(raw, expected);
  assert.deepEqual(JSON.parse(raw) as unknown, expectedFixture);
  assert.equal(JSON.stringify(JSON.parse(raw)), JSON.stringify(expectedFixture));
});

test('programmatic requests use explicit camelCase contracts', () => {
  assert.equal(programmaticQuery.filePath, expectedFixture.query_request.file_path);
  assert.equal(programmaticQuery.principalId, expectedFixture.query_request.principal_id);
  assert.equal(programmaticGraph.filePath, expectedFixture.graph_edge.source_file);
});

test('wire fixtures exclude private host and relay-era identity vocabulary', async () => {
  const raw = await readFile(fixturePath, 'utf8');
  const forbidden = [
    /\/home\//i,
    /\/Users\//i,
    /voxxo-swarm/i,
    /relay\/src/i,
    /author_instance_id/i,
    /author_engine/i,
    /review_entry_id/i,
    /instance_name/i,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(raw, pattern);
  }
});
