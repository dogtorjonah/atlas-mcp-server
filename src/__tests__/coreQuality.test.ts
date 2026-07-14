import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../core/index.js';
import {
  buildIncompleteEntryReport,
  classifyIncompleteEntry,
  collectFilledIdentityFields,
  computeCompleteness,
  computeMetadataCompleteness,
  dedupeHazardsFuzzy,
  deriveClusterFromPath,
  filterHazards,
  formatCompletenessTierGuide,
  getStructuralSymbolRegex,
  includesStructuralSymbolByContext,
  isStructuralSymbolName,
  normalizeHazardKey,
  requirementsForTier,
  rollupEnrichmentFindings,
  sanitizePatternEntry,
  selectIndexedRecords,
  shouldRenderHazardText,
  sortIncompleteEntryFindings,
  supportsStructuralImportExportAnalysis,
  tierForLineCount,
  type AtlasIncompleteEntryInput,
  type AtlasIndexedRecordCandidate,
  type AtlasObservedPathState,
} from '../core/quality.js';

interface CompletenessFixtureCase {
  name: string;
  line_count: number | null;
  filled: string[];
  expected: {
    tier: string;
    line_count: number;
    missing_required: string[];
    required_fill_rate: number;
    overall_fill_rate: number;
  };
}

interface RecordFixtureCandidate {
  id: string;
  identity: string;
  path_state: AtlasObservedPathState;
  indexed_hash: string | null;
  current_hash: string | null;
  completeness: number;
  indexed_at: string;
}

interface QualityFixture {
  schema_version: 1;
  completeness: CompletenessFixtureCase[];
  record_selection: {
    candidates: RecordFixtureCandidate[];
    expected: {
      selected: string[];
      excluded: Array<[string, string]>;
      duplicate_count: number;
      stale_count: number;
      missing_count: number;
    };
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFixture(value: unknown): QualityFixture {
  assert.ok(isObject(value));
  assert.equal(value.schema_version, 1);
  assert.ok(Array.isArray(value.completeness));
  assert.ok(isObject(value.record_selection));
  return value as unknown as QualityFixture;
}

const fixturePath = fileURLToPath(
  new URL('../../test/fixtures/contracts/quality.json', import.meta.url),
);

async function loadFixture(): Promise<QualityFixture> {
  return parseFixture(JSON.parse(await readFile(fixturePath, 'utf8')) as unknown);
}

test('the side-effect-free core barrel exposes quality helpers', () => {
  assert.equal(core.computeCompleteness, computeCompleteness);
  assert.equal(core.classifyIncompleteEntry, classifyIncompleteEntry);
  assert.equal(core.selectIndexedRecords, selectIndexedRecords);
});

function completeEntry(overrides: Partial<AtlasIncompleteEntryInput> = {}): AtlasIncompleteEntryInput {
  return {
    filePath: 'src/example.ts',
    blurb: 'A complete example record.',
    purpose: 'Provides a baseline for portable quality-classification tests.',
    tags: ['example'],
    extractionProvider: 'fixture-provider',
    extractedAt: '2026-07-02T00:00:00.000Z',
    crossReferences: {
      symbols: {},
      generatedAt: '2026-07-02T00:00:01.000Z',
    },
    hazards: ['mutates input'],
    conventions: ['ESM imports'],
    keyTypes: ['Example'],
    dataFlows: ['input -> result'],
    ...overrides,
  };
}

test('completeness fixtures freeze line tiers and fill-rate semantics', async () => {
  const fixture = await loadFixture();
  for (const fixtureCase of fixture.completeness) {
    const lineCount = fixtureCase.line_count ?? Number.NaN;
    const score = computeCompleteness(lineCount, new Set(fixtureCase.filled));
    assert.deepEqual({
      tier: score.tier,
      line_count: score.lineCount,
      missing_required: score.missingRequired,
      required_fill_rate: score.requiredFillRate,
      overall_fill_rate: score.overallFillRate,
    }, fixtureCase.expected, fixtureCase.name);
  }
});

test('metadata scoring recognizes only non-empty identity values', () => {
  const metadata = {
    blurb: 'identity',
    purpose: '   ',
    tags: ['core'],
    hazards: [],
    patterns: ['pure helper'],
    sourceHighlights: [{ startLine: 1, endLine: 4 }],
  };
  assert.deepEqual([...collectFilledIdentityFields(metadata)], [
    'blurb',
    'tags',
    'patterns',
    'source_highlights',
  ]);
  const score = computeMetadataCompleteness(700, metadata);
  assert.equal(score.tier, 'large');
  assert.deepEqual(score.missingRequired, ['purpose', 'hazards']);
  assert.equal(requirementsForTier('huge').required.includes('key_types'), true);
  assert.equal(tierForLineCount(Number.POSITIVE_INFINITY), 'small');
  assert.match(formatCompletenessTierGuide(), /overall=C\/10/);
});

test('incomplete entries preserve four distinct evidence tiers', () => {
  assert.deepEqual(classifyIncompleteEntry(completeEntry()), []);

  const findings = classifyIncompleteEntry(completeEntry({
    blurb: '',
    purpose: ' ',
    tags: [],
    extractionProvider: 'scaffold',
    crossReferences: null,
    hazards: [],
    conventions: [],
    keyTypes: [],
    dataFlows: [],
  }), { pathState: 'missing' });

  assert.deepEqual(findings.map((finding) => finding.tier), [
    'identity',
    'path_integrity',
    'crossref_freshness',
    'enrichment',
  ]);
  assert.deepEqual(findings[0]?.missing, [
    'blurb',
    'purpose',
    'tags',
    'extraction (scaffold or none)',
  ]);
  assert.match(findings[1]?.remediation ?? '', /reindex/);
  assert.match(findings[2]?.remediation ?? '', /refresh cross-references/);
});

test('filesystem absence is never inferred and unverifiable timestamps stay visible', () => {
  const unobserved = classifyIncompleteEntry(completeEntry());
  assert.equal(unobserved.some((finding) => finding.tier === 'path_integrity'), false);

  const stale = classifyIncompleteEntry(completeEntry({
    extractedAt: '2026-07-02T00:00:10.001Z',
    crossReferences: { symbols: {}, generatedAt: '2026-07-02T00:00:00.000Z' },
  }));
  assert.deepEqual(stale.map((finding) => finding.tier), ['crossref_freshness']);
  assert.deepEqual(stale[0]?.missing, ['fresh cross_references']);

  const hostDependentTimestamp = classifyIncompleteEntry(completeEntry({
    extractedAt: '2026-07-02T00:00:10',
    crossReferences: { symbols: {}, generatedAt: '2026-07-02T00:00:00' },
  }));
  assert.deepEqual(hostDependentTimestamp.map((finding) => finding.tier), ['crossref_freshness']);
  assert.deepEqual(hostDependentTimestamp[0]?.missing, ['valid cross_reference timestamp']);
});

test('gap reporting is stable, bounded, and gives tier-specific remediation', () => {
  const findings = [
    ...Array.from({ length: 4 }, (_, index) => classifyIncompleteEntry(completeEntry({
      filePath: `src/hollow-${index}.ts`,
      blurb: '',
    }))).flat(),
    ...classifyIncompleteEntry(completeEntry({ filePath: 'src/sparse.ts', hazards: [] })),
  ];
  const sorted = sortIncompleteEntryFindings(findings);
  assert.equal(sorted[0]?.tier, 'identity');
  const enrichment = rollupEnrichmentFindings(sorted, 1);
  assert.deepEqual(enrichment, {
    fileCount: 1,
    fieldCounts: { hazards: 1 },
    exampleFiles: ['src/sparse.ts'],
  });

  const report = buildIncompleteEntryReport(findings, {
    maxDetailPerTier: 2,
    maxEnrichmentExamples: 1,
  });
  const text = report.lines.join('\n');
  assert.equal(report.truncated, true);
  assert.equal(report.actionableFindings, 4);
  assert.match(text, /and 2 more/);
  assert.match(text, /remediation: supply the missing identity fields/);
  assert.match(text, /remediation: enrich opportunistically/);
  assert.doesNotMatch(text, /src\/hollow-3\.ts/);
});

test('cluster and pattern hygiene stay pure and host-neutral', () => {
  assert.equal(deriveClusterFromPath('src/core/quality.ts'), 'src');
  assert.equal(
    deriveClusterFromPath('packages/ui/src/index.ts', { twoSegmentRoots: ['packages'] }),
    'packages/ui',
  );
  assert.equal(deriveClusterFromPath('README.md'), 'root');
  assert.equal(deriveClusterFromPath(''), 'root');
  assert.equal(sanitizePatternEntry('  worker\n boundary  '), 'worker boundary');
  assert.equal(sanitizePatternEntry('<invoke name="commit">'), null);
  assert.equal(sanitizePatternEntry('<result> wrapper'), null);
  assert.equal(sanitizePatternEntry('clamp to < 100 before insert'), 'clamp to < 100 before insert');
  assert.equal(sanitizePatternEntry('🧭'.repeat(240)), '🧭'.repeat(240));
  assert.equal(sanitizePatternEntry('🧭'.repeat(241)), null);
  assert.equal(sanitizePatternEntry(' '.repeat(4_097)), null);
});

test('hazard suppression is exact and fuzzy dedupe preserves semantic differences', () => {
  assert.equal(shouldRenderHazardText('feature flag'), false);
  assert.equal(shouldRenderHazardText('Feature flag disables auth checks.'), true);
  assert.equal(normalizeHazardKey("Agents can't restart the relay."), 'agents can not restart the relay');

  const input = [
    'Relay changes require an operator restart to activate.',
    'Relay changes require an operator restart to activate them.',
    'The timeout is 30s and must stop the worker before shutdown.',
    'The timeout is 60s and must stop the worker before shutdown.',
    'The worker must restart after the handoff completes.',
    'The worker must not restart after the handoff completes.',
    'Apply the migration before service startup.',
    'Apply the migration after service startup.',
  ];
  assert.deepEqual(dedupeHazardsFuzzy(input), [
    input[0],
    input[2],
    input[3],
    input[4],
    input[5],
    input[6],
    input[7],
  ]);
  assert.deepEqual(filterHazards(['feature flag', '', ...input.slice(0, 2)]), [input[0]]);
  assert.deepEqual(dedupeHazardsFuzzy(dedupeHazardsFuzzy(input)), dedupeHazardsFuzzy(input));
  assert.throws(() => dedupeHazardsFuzzy(['x'.repeat(4_001)]), /bounded maximum/);
  assert.throws(() => filterHazards(Array.from({ length: 1_001 }, () => 'hazard')), /entry count/);
});

test('structural symbol filters reject prose without breaking dollar-prefixed identifiers', () => {
  assert.equal(supportsStructuralImportExportAnalysis('src/view.tsx'), true);
  assert.equal(supportsStructuralImportExportAnalysis('docs/view.md'), false);
  assert.equal(isStructuralSymbolName('PanelStatus'), true);
  assert.equal(isStructuralSymbolName('Panel({ close'), false);
  assert.ok(getStructuralSymbolRegex('$state'));
  assert.equal(includesStructuralSymbolByContext('return $state.value;', '$state'), true);
  assert.equal(includesStructuralSymbolByContext('PanelStatusExtra', 'PanelStatus'), false);
});

test('record selection fixtures expose stale, missing, and duplicate suppression', async () => {
  const fixture = await loadFixture();
  const candidates: Array<AtlasIndexedRecordCandidate<{ id: string }>> =
    fixture.record_selection.candidates.map((candidate) => ({
      identity: candidate.identity,
      value: { id: candidate.id },
      pathState: candidate.path_state,
      indexedHash: candidate.indexed_hash,
      currentHash: candidate.current_hash,
      completeness: candidate.completeness,
      indexedAt: candidate.indexed_at,
    }));
  const result = selectIndexedRecords(candidates);
  assert.deepEqual(
    result.selected.map((selection) => selection.candidate.value.id),
    fixture.record_selection.expected.selected,
  );
  assert.deepEqual(
    result.excluded.map((exclusion) => [exclusion.candidate.value.id, exclusion.reason]),
    fixture.record_selection.expected.excluded,
  );
  assert.equal(result.duplicateCount, fixture.record_selection.expected.duplicate_count);
  assert.equal(result.staleCount, fixture.record_selection.expected.stale_count);
  assert.equal(result.missingCount, fixture.record_selection.expected.missing_count);
});

test('callers may retain stale or historical records only as labeled evidence', () => {
  const candidates: Array<AtlasIndexedRecordCandidate<string>> = [
    {
      identity: 'fixture::src/stale.ts',
      value: 'stale',
      pathState: 'current',
      indexedHash: 'old',
      currentHash: 'new',
    },
    {
      identity: 'fixture::src/ghost.ts',
      value: 'ghost',
      pathState: 'missing',
      indexedHash: 'old',
      currentHash: null,
    },
  ];
  const result = selectIndexedRecords(candidates, { includeStale: true, includeHistorical: true });
  assert.deepEqual(result.selected.map(({ identity, quality }) => [identity, quality]), [
    ['fixture::src/ghost.ts', 'historical'],
    ['fixture::src/stale.ts', 'stale_advisory'],
  ]);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.staleCount, 1);
  assert.equal(result.missingCount, 1);
});
