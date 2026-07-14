import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildChangelogFactAuthority,
  buildEvidenceAuthority,
  renderEvidenceAuthority,
  summarizeEvidenceAuthority,
  withEvidenceAuthority,
  type AtlasEvidenceAuthorityResolution,
  type AtlasFactAuthority,
  type BuildEvidenceAuthorityArgs,
} from '../core/evidenceAuthority.js';
import type { AtlasFailure, AtlasResult, AtlasSuccess } from '../core/types.js';

interface EvidenceFixtureCase {
  name: string;
  input: BuildEvidenceAuthorityArgs;
  expected: unknown;
}

interface EvidenceFixture {
  schema_version: 1;
  cases: EvidenceFixtureCase[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFixture(value: unknown): EvidenceFixture {
  assert.ok(isObject(value));
  assert.equal(value.schema_version, 1);
  assert.ok(Array.isArray(value.cases));
  return value as unknown as EvidenceFixture;
}

function projectFact(fact: AtlasFactAuthority): Omit<AtlasFactAuthority, 'provenance'> {
  return {
    freshness: fact.freshness,
    confidence: fact.confidence,
    completeness: fact.completeness,
    authoritative: fact.authoritative,
  };
}

function projectResolution(authority: AtlasEvidenceAuthorityResolution): unknown {
  return {
    resolution_rule: authority.resolution_rule,
    current_source: {
      authority: authority.current_source.authority,
      state: authority.current_source.state,
      sha1: authority.current_source.sha1,
      confidence: authority.current_source.confidence,
      completeness: authority.current_source.completeness,
    },
    indexed_metadata: {
      freshness: authority.indexed_metadata.freshness,
      recorded_sha1: authority.indexed_metadata.recorded_sha1,
      confidence: authority.indexed_metadata.confidence,
      completeness: authority.indexed_metadata.completeness,
    },
    changelog: {
      freshness: authority.changelog.freshness,
      confidence: authority.changelog.confidence,
      completeness: authority.changelog.completeness,
    },
    facts: {
      current_parsed_source: projectFact(authority.facts.current_parsed_source),
      verified_snapshot: projectFact(authority.facts.verified_snapshot),
      pending_narration: projectFact(authority.facts.pending_narration),
      historical_deleted_artifact: projectFact(authority.facts.historical_deleted_artifact),
      inferred_relationship: projectFact(authority.facts.inferred_relationship),
      incomplete_set: projectFact(authority.facts.incomplete_set),
    },
    summary: summarizeEvidenceAuthority(authority),
  };
}

const fixturePath = fileURLToPath(
  new URL('../../test/fixtures/contracts/evidence-authority.json', import.meta.url),
);

async function loadFixture(): Promise<EvidenceFixture> {
  return parseFixture(JSON.parse(await readFile(fixturePath, 'utf8')) as unknown);
}

test('evidence authority fixtures resolve conflicts byte-deterministically', async () => {
  const fixture = await loadFixture();

  for (const fixtureCase of fixture.cases) {
    const first = buildEvidenceAuthority(fixtureCase.input);
    const second = buildEvidenceAuthority(fixtureCase.input);
    assert.deepEqual(projectResolution(first), fixtureCase.expected, fixtureCase.name);
    assert.deepEqual(second, first, `${fixtureCase.name} must be deterministic`);
    assert.equal(first.current_source.provenance, 'workspace_disk');
    assert.equal(first.indexed_metadata.authority, 'advisory');
    assert.equal(first.indexed_metadata.provenance, 'atlas_store');
    assert.equal(first.changelog.authority, 'historical_record');
    assert.equal(first.changelog.provenance, 'atlas_changelog');
  }
});

test('current source stays authoritative when the indexed hash is stale', async () => {
  const fixture = await loadFixture();
  const fixtureCase = fixture.cases.find((entry) => entry.name.startsWith('stale indexed'));
  assert.ok(fixtureCase);
  const authority = buildEvidenceAuthority(fixtureCase.input);
  const summary = summarizeEvidenceAuthority(authority);

  assert.equal(authority.current_source.authority, 'authoritative');
  assert.equal(authority.indexed_metadata.freshness, 'stale');
  assert.equal(summary.freshness, 'current');
  assert.equal(summary.confidence, 'high');
});

test('changelog verification states never promote pending narration', () => {
  assert.equal(buildChangelogFactAuthority('verified').authoritative, true);
  assert.deepEqual(buildChangelogFactAuthority('pending'), {
    provenance: 'pending_narration',
    freshness: 'pending',
    confidence: 'low',
    completeness: 'partial',
    authoritative: false,
  });
  assert.deepEqual(buildChangelogFactAuthority('needs_review'), {
    provenance: 'pending_narration',
    freshness: 'unverified',
    confidence: 'low',
    completeness: 'partial',
    authoritative: false,
  });
  assert.equal(buildChangelogFactAuthority('disputed').authoritative, false);
});

test('success and failure envelopes receive the same structured authority summary', () => {
  const authority = buildEvidenceAuthority({
    sourceObserved: true,
    sourceHash: 'sha1:current',
    indexedHash: 'sha1:stale',
    incompleteSet: false,
  });
  const meta = { capabilities: {}, warnings: [], extensions: [] } as const;
  const success: AtlasSuccess<{ items: readonly string[] }> = {
    protocol_version: '1',
    ok: true,
    request_id: 'request-success',
    data: { items: ['src/index.ts'] },
    meta,
  };
  const failure: AtlasFailure = {
    protocol_version: '1',
    ok: false,
    request_id: 'request-failure',
    error: {
      code: 'ATLAS_NOT_FOUND',
      message: 'The requested file was not found.',
      retryable: false,
    },
    meta,
  };

  const attachedSuccess: AtlasResult<{ items: readonly string[] }> = withEvidenceAuthority(
    success,
    authority,
  );
  const attachedFailure: AtlasResult<never> = withEvidenceAuthority(failure, authority);
  const expected = summarizeEvidenceAuthority(authority);

  assert.deepEqual(attachedSuccess.meta.evidence, expected);
  assert.deepEqual(attachedFailure.meta.evidence, expected);
  assert.equal(success.meta.evidence, undefined);
  assert.equal(failure.meta.evidence, undefined);
});

test('text rendering labels each authority and the result-set completeness', () => {
  const authority = buildEvidenceAuthority({
    sourceObserved: true,
    sourceHash: 'sha1:current',
    indexedHash: 'sha1:stale',
    inferredRelationship: true,
    setCompleteness: 'partial',
  });

  assert.deepEqual(renderEvidenceAuthority(authority), [
    '## Evidence Authority',
    '- Resolution: current_disk_source_overrides_indexed_metadata_on_conflict',
    '- Current source: authoritative (workspace_disk; current; confidence=high; completeness=complete)',
    '- Indexed metadata: advisory (atlas_store; stale; confidence=low; completeness=partial)',
    '- Changelog: historical_record (atlas_changelog; unknown; confidence=unknown; completeness=unknown)',
    '- Inferred relationships: inferred; confidence=medium; completeness=partial',
    '- Result set: confidence=low; completeness=partial',
  ]);
});
