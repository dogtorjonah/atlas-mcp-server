/**
 * Dependency-free Atlas completeness, gap-classification, and corpus-hygiene
 * rules. Hosts provide filesystem and persistence observations explicitly;
 * this module only classifies and ranks facts it receives.
 */

export type AtlasFileTier = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export const ATLAS_IDENTITY_FIELDS = [
  'purpose',
  'blurb',
  'tags',
  'patterns',
  'hazards',
  'conventions',
  'key_types',
  'data_flows',
  'public_api',
  'source_highlights',
] as const;

export type AtlasIdentityField = (typeof ATLAS_IDENTITY_FIELDS)[number];

export interface AtlasTierRequirements {
  tier: AtlasFileTier;
  required: readonly AtlasIdentityField[];
  recommended: readonly AtlasIdentityField[];
  rationale: string;
}

export interface AtlasCompletenessScore extends AtlasTierRequirements {
  lineCount: number;
  filled: readonly AtlasIdentityField[];
  missingRequired: readonly AtlasIdentityField[];
  missingRecommended: readonly AtlasIdentityField[];
  requiredFillRate: number;
  overallFillRate: number;
}

export interface AtlasIdentityMetadata {
  purpose?: string | null;
  blurb?: string | null;
  tags?: readonly unknown[] | null;
  patterns?: readonly unknown[] | null;
  hazards?: readonly unknown[] | null;
  conventions?: readonly unknown[] | null;
  keyTypes?: readonly unknown[] | null;
  dataFlows?: readonly unknown[] | null;
  publicApi?: readonly unknown[] | null;
  sourceHighlights?: readonly unknown[] | null;
}

const TIER_REQUIREMENTS: Readonly<Record<AtlasFileTier, AtlasTierRequirements>> = {
  tiny: {
    tier: 'tiny',
    required: ['blurb', 'tags'],
    recommended: ['purpose'],
    rationale: 'Tiny files usually need a one-line identity and canonical tags.',
  },
  small: {
    tier: 'small',
    required: ['blurb', 'purpose', 'tags'],
    recommended: ['hazards', 'patterns'],
    rationale: 'Small files need enough identity metadata for search and lookup summaries.',
  },
  medium: {
    tier: 'medium',
    required: ['blurb', 'purpose', 'tags', 'hazards'],
    recommended: ['patterns', 'key_types', 'data_flows'],
    rationale: 'Medium files should record their important correctness hazards.',
  },
  large: {
    tier: 'large',
    required: ['blurb', 'purpose', 'tags', 'hazards', 'patterns', 'source_highlights'],
    recommended: ['key_types', 'data_flows', 'public_api'],
    rationale: 'Large files need source highlights so orientation does not require a full reread.',
  },
  huge: {
    tier: 'huge',
    required: [
      'blurb',
      'purpose',
      'tags',
      'hazards',
      'patterns',
      'source_highlights',
      'key_types',
    ],
    recommended: ['data_flows', 'public_api', 'conventions'],
    rationale: 'Huge files need structural metadata because they are expensive to re-orient within.',
  },
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedNonNegativeInteger(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function boundedRate(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasItems(value: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function tierForLineCount(lineCount: number): AtlasFileTier {
  if (!Number.isFinite(lineCount) || lineCount <= 0) return 'small';
  if (lineCount <= 50) return 'tiny';
  if (lineCount <= 200) return 'small';
  if (lineCount <= 600) return 'medium';
  if (lineCount <= 1_500) return 'large';
  return 'huge';
}

export function requirementsForTier(tier: AtlasFileTier): AtlasTierRequirements {
  return TIER_REQUIREMENTS[tier];
}

export function formatCompletenessTierGuide(): string {
  return [
    'tiny <=50 lines: required blurb + tags',
    'small <=200 lines: required blurb + purpose + tags',
    'medium <=600 lines: adds hazards',
    'large <=1500 lines: adds patterns + source_highlights',
    'huge >1500 lines: adds key_types',
    'required=A/B is tier-required coverage; overall=C/10 is all identity-field coverage',
  ].join('; ');
}

export function collectFilledIdentityFields(
  metadata: AtlasIdentityMetadata,
): ReadonlySet<AtlasIdentityField> {
  const filled = new Set<AtlasIdentityField>();
  if (hasText(metadata.purpose)) filled.add('purpose');
  if (hasText(metadata.blurb)) filled.add('blurb');
  if (hasItems(metadata.tags)) filled.add('tags');
  if (hasItems(metadata.patterns)) filled.add('patterns');
  if (hasItems(metadata.hazards)) filled.add('hazards');
  if (hasItems(metadata.conventions)) filled.add('conventions');
  if (hasItems(metadata.keyTypes)) filled.add('key_types');
  if (hasItems(metadata.dataFlows)) filled.add('data_flows');
  if (hasItems(metadata.publicApi)) filled.add('public_api');
  if (hasItems(metadata.sourceHighlights)) filled.add('source_highlights');
  return filled;
}

export function computeCompleteness(
  lineCount: number,
  filledFields: ReadonlySet<string>,
): AtlasCompletenessScore {
  const tier = tierForLineCount(lineCount);
  const requirements = requirementsForTier(tier);
  const filled = ATLAS_IDENTITY_FIELDS.filter((field) => filledFields.has(field));
  const missingRequired = requirements.required.filter((field) => !filledFields.has(field));
  const missingRecommended = requirements.recommended.filter((field) => !filledFields.has(field));

  return {
    ...requirements,
    lineCount: Number.isFinite(lineCount) && lineCount > 0 ? Math.round(lineCount) : 0,
    filled,
    missingRequired,
    missingRecommended,
    requiredFillRate: (requirements.required.length - missingRequired.length)
      / requirements.required.length,
    overallFillRate: filled.length / ATLAS_IDENTITY_FIELDS.length,
  };
}

export function computeMetadataCompleteness(
  lineCount: number,
  metadata: AtlasIdentityMetadata,
): AtlasCompletenessScore {
  return computeCompleteness(lineCount, collectFilledIdentityFields(metadata));
}

export type AtlasIncompleteEntryTier =
  | 'identity'
  | 'path_integrity'
  | 'crossref_freshness'
  | 'enrichment';

export const ATLAS_INCOMPLETE_ENTRY_TIER_ORDER: readonly AtlasIncompleteEntryTier[] = [
  'identity',
  'path_integrity',
  'crossref_freshness',
  'enrichment',
];

export const ATLAS_INCOMPLETE_ENTRY_TIER_LABELS: Readonly<Record<
  AtlasIncompleteEntryTier,
  string
>> = {
  identity: 'Required identity — commit fields missing',
  path_integrity: 'Path integrity — record has no current file',
  crossref_freshness: 'Cross-reference freshness — missing or stale cross-references',
  enrichment: 'Optional enrichment — empty fields (empty may be correct)',
};

export const ATLAS_INCOMPLETE_ENTRY_REMEDIATION: Readonly<Record<
  AtlasIncompleteEntryTier,
  string
>> = {
  identity: 'supply the missing identity fields on the next metadata write',
  path_integrity: 'reindex the path or retain the record explicitly as historical evidence',
  crossref_freshness: 'refresh cross-references for the affected file',
  enrichment: 'enrich opportunistically when the file is next edited',
};

export interface AtlasIncompleteCrossReferences {
  symbols?: Readonly<Record<string, unknown>>;
  generatedAt?: string | null;
}

export interface AtlasIncompleteEntryInput extends AtlasIdentityMetadata {
  filePath: string;
  extractionProvider?: string | null;
  extractedAt?: string | null;
  crossReferences?: AtlasIncompleteCrossReferences | null;
}

export type AtlasObservedPathState = 'current' | 'missing' | 'unknown';

export interface AtlasIncompleteEntryObservation {
  /** Filesystem state supplied by a host or worker; omitted means unobserved. */
  pathState?: AtlasObservedPathState;
}

export interface AtlasIncompleteEntryFinding {
  tier: AtlasIncompleteEntryTier;
  filePath: string;
  missing: readonly string[];
  evidence: readonly string[];
  remediation: string;
  note?: string;
}

const CROSS_REFERENCE_STALENESS_SKEW_MS = 5_000;
const ZONED_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/i;

function parseDeterministicTimestamp(value: string | null | undefined): number | null {
  if (!value || !ZONED_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyIncompleteEntry(
  file: AtlasIncompleteEntryInput,
  observation: AtlasIncompleteEntryObservation = {},
): readonly AtlasIncompleteEntryFinding[] {
  const findings: AtlasIncompleteEntryFinding[] = [];
  const identityMissing: string[] = [];
  const extractionProvider = file.extractionProvider?.trim() ?? '';

  if (!hasText(file.blurb)) identityMissing.push('blurb');
  if (!hasText(file.purpose)) identityMissing.push('purpose');
  if (!hasItems(file.tags)) identityMissing.push('tags');
  if (extractionProvider.length === 0 || extractionProvider.toLocaleLowerCase('en-US') === 'scaffold') {
    identityMissing.push('extraction (scaffold or none)');
  }

  if (identityMissing.length > 0) {
    findings.push({
      tier: 'identity',
      filePath: file.filePath,
      missing: identityMissing,
      evidence: [
        'tier: identity',
        `missing required fields: ${identityMissing.join(', ')}`,
      ],
      remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.identity,
      note: extractionProvider.length > 0
        ? `last extraction by ${extractionProvider}`
        : 'never extracted',
    });
  }

  if (observation.pathState === 'missing') {
    findings.push({
      tier: 'path_integrity',
      filePath: file.filePath,
      missing: ['current file'],
      evidence: [
        'tier: path_integrity',
        'indexed metadata exists but the host observed no file at the current path',
      ],
      remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.path_integrity,
    });
  }

  const crossReferences = file.crossReferences;
  const hasCrossReferenceSymbols = Object.keys(crossReferences?.symbols ?? {}).length > 0;
  if (!crossReferences || (!hasCrossReferenceSymbols && !hasText(crossReferences.generatedAt))) {
    findings.push({
      tier: 'crossref_freshness',
      filePath: file.filePath,
      missing: ['cross_references'],
      evidence: [
        'tier: crossref_freshness',
        'cross-references have not been generated for this record',
      ],
      remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.crossref_freshness,
    });
  } else {
    const crossReferencedAt = parseDeterministicTimestamp(crossReferences.generatedAt);
    const extractedAt = parseDeterministicTimestamp(file.extractedAt);
    if (crossReferencedAt === null) {
      findings.push({
        tier: 'crossref_freshness',
        filePath: file.filePath,
        missing: ['valid cross_reference timestamp'],
        evidence: [
          'tier: crossref_freshness',
          'cross-reference freshness cannot be verified from a zoned timestamp',
        ],
        remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.crossref_freshness,
      });
    } else if (extractedAt === null) {
      findings.push({
        tier: 'crossref_freshness',
        filePath: file.filePath,
        missing: ['valid extraction timestamp'],
        evidence: [
          'tier: crossref_freshness',
          'cross-reference freshness cannot be compared with the latest extraction',
        ],
        remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.crossref_freshness,
      });
    } else if (extractedAt - crossReferencedAt > CROSS_REFERENCE_STALENESS_SKEW_MS) {
      findings.push({
        tier: 'crossref_freshness',
        filePath: file.filePath,
        missing: ['fresh cross_references'],
        evidence: [
          'tier: crossref_freshness',
          `cross-references generated ${crossReferences.generatedAt} but file extracted ${file.extractedAt}`,
        ],
        remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.crossref_freshness,
      });
    }
  }

  const enrichmentMissing: string[] = [];
  if (!hasItems(file.hazards)) enrichmentMissing.push('hazards');
  if (!hasItems(file.conventions)) enrichmentMissing.push('conventions');
  if (!hasItems(file.keyTypes)) enrichmentMissing.push('key_types');
  if (!hasItems(file.dataFlows)) enrichmentMissing.push('data_flows');
  if (enrichmentMissing.length > 0) {
    findings.push({
      tier: 'enrichment',
      filePath: file.filePath,
      missing: enrichmentMissing,
      evidence: [
        'tier: enrichment',
        `empty optional fields: ${enrichmentMissing.join(', ')}`,
      ],
      remediation: ATLAS_INCOMPLETE_ENTRY_REMEDIATION.enrichment,
    });
  }

  return findings;
}

export function sortIncompleteEntryFindings(
  findings: readonly AtlasIncompleteEntryFinding[],
): readonly AtlasIncompleteEntryFinding[] {
  const rank = new Map(ATLAS_INCOMPLETE_ENTRY_TIER_ORDER.map((tier, index) => [tier, index]));
  return [...findings].sort((left, right) =>
    (rank.get(left.tier) ?? 99) - (rank.get(right.tier) ?? 99)
    || compareText(left.filePath, right.filePath));
}

export interface AtlasEnrichmentRollup {
  fileCount: number;
  fieldCounts: Readonly<Record<string, number>>;
  exampleFiles: readonly string[];
}

export function rollupEnrichmentFindings(
  findings: readonly AtlasIncompleteEntryFinding[],
  maxExamples = 5,
): AtlasEnrichmentRollup | null {
  const enrichment = findings.filter((finding) => finding.tier === 'enrichment');
  if (enrichment.length === 0) return null;

  const counts = new Map<string, number>();
  for (const finding of enrichment) {
    for (const field of finding.missing) counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const fieldCounts: Record<string, number> = {};
  for (const [field, count] of [...counts].sort(([left], [right]) => compareText(left, right))) {
    fieldCounts[field] = count;
  }

  return {
    fileCount: enrichment.length,
    fieldCounts,
    exampleFiles: enrichment
      .map((finding) => finding.filePath)
      .sort(compareText)
      .slice(0, boundedNonNegativeInteger(maxExamples, 5, 100)),
  };
}

export interface AtlasIncompleteEntryReport {
  totalFindings: number;
  actionableFindings: number;
  truncated: boolean;
  lines: readonly string[];
  enrichment: AtlasEnrichmentRollup | null;
}

export interface AtlasIncompleteEntryReportOptions {
  maxDetailPerTier?: number;
  maxEnrichmentExamples?: number;
}

export function buildIncompleteEntryReport(
  input: readonly AtlasIncompleteEntryFinding[],
  options: AtlasIncompleteEntryReportOptions = {},
): AtlasIncompleteEntryReport {
  const findings = sortIncompleteEntryFindings(input);
  const maxDetail = boundedNonNegativeInteger(options.maxDetailPerTier ?? 20, 20, 1_000);
  const enrichment = rollupEnrichmentFindings(
    findings,
    options.maxEnrichmentExamples ?? 5,
  );
  const lines: string[] = [];
  let truncated = false;

  for (const tier of ATLAS_INCOMPLETE_ENTRY_TIER_ORDER) {
    const tierFindings = findings.filter((finding) => finding.tier === tier);
    if (tierFindings.length === 0) continue;

    if (tier === 'enrichment') {
      if (!enrichment) continue;
      lines.push(`#### ${ATLAS_INCOMPLETE_ENTRY_TIER_LABELS.enrichment} (${enrichment.fileCount} files)`);
      const frequency = Object.entries(enrichment.fieldCounts)
        .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
        .map(([field, count]) => `${field}: ${count}`)
        .join(', ');
      lines.push(`- empty-field frequency — ${frequency}`);
      if (enrichment.exampleFiles.length > 0) {
        lines.push(`- examples: ${enrichment.exampleFiles.map((path) => `\`${path}\``).join(', ')}`);
      }
      lines.push(`- remediation: ${ATLAS_INCOMPLETE_ENTRY_REMEDIATION.enrichment}`);
      continue;
    }

    lines.push(`#### ${ATLAS_INCOMPLETE_ENTRY_TIER_LABELS[tier]} (${tierFindings.length})`);
    for (const finding of tierFindings.slice(0, maxDetail)) {
      const evidence = finding.evidence.filter((line) => !line.startsWith('tier:')).join(' | ');
      const note = finding.note ? ` (${finding.note})` : '';
      lines.push(`- \`${finding.filePath}\` — ${evidence}${note}`);
    }
    lines.push(`- remediation: ${ATLAS_INCOMPLETE_ENTRY_REMEDIATION[tier]}`);
    if (tierFindings.length > maxDetail) {
      truncated = true;
      lines.push(`- … and ${tierFindings.length - maxDetail} more; narrow the path or cluster scope`);
    }
  }

  return {
    totalFindings: findings.length,
    actionableFindings: findings.filter((finding) => finding.tier !== 'enrichment').length,
    truncated,
    lines,
    enrichment,
  };
}

export interface AtlasClusterOptions {
  /** Roots whose second segment is the useful domain boundary. */
  twoSegmentRoots?: readonly string[];
}

export function deriveClusterFromPath(
  filePath: string,
  options: AtlasClusterOptions = {},
): string {
  const normalized = filePath
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  if (normalized.length === 0) return 'root';

  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length <= 1) return 'root';
  const head = parts[0];
  if (!head) return 'root';
  const second = parts[1];
  if (second && parts.length >= 3 && new Set(options.twoSegmentRoots ?? []).has(head)) {
    return `${head}/${second}`;
  }
  return head;
}

const PATTERN_SHRAPNEL_MARKERS = [
  '<invoke',
  '</invoke',
  '<parameter',
  '</parameter',
  '<function',
  '</function',
  '<antml',
];
const XML_OPENER = /^<\/?[a-z][a-z0-9_-]*[\s>/=]/i;
const MAX_PATTERN_ENTRY_CODE_POINTS = 240;
const MAX_RAW_PATTERN_CODE_POINTS = 4_096;

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

export function sanitizePatternEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (exceedsCodePointLimit(value, MAX_RAW_PATTERN_CODE_POINTS)) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || exceedsCodePointLimit(collapsed, MAX_PATTERN_ENTRY_CODE_POINTS)) {
    return null;
  }

  const lower = collapsed.toLocaleLowerCase('en-US');
  if (PATTERN_SHRAPNEL_MARKERS.some((marker) => lower.includes(marker))) return null;
  return XML_OPENER.test(collapsed) ? null : collapsed;
}

export const DEFAULT_SUPPRESSED_HAZARD_FRAGMENTS: ReadonlySet<string> = new Set([
  'busy_timeout',
  'feature flag',
  'history sample counts',
  'lookup deadlines',
]);

export function shouldRenderHazardText(
  value: unknown,
  suppressed: ReadonlySet<string> = DEFAULT_SUPPRESSED_HAZARD_FRAGMENTS,
): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !suppressed.has(trimmed.toLocaleLowerCase('en-US'));
}

function expandEnglishContractions(value: string): string {
  return value
    .replace(/\b(can)['’]t\b/gi, '$1 not')
    .replace(/\b(won)['’]t\b/gi, 'will not')
    .replace(/\b(shan)['’]t\b/gi, 'shall not')
    .replace(/\b([a-z]+)n['’]t\b/gi, '$1 not');
}

const MAX_HAZARD_ENTRIES = 1_000;
const MAX_HAZARD_ENTRY_CODE_POINTS = 4_000;

export function normalizeHazardKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (exceedsCodePointLimit(value, MAX_HAZARD_ENTRY_CODE_POINTS)) {
    throw new RangeError(
      `Hazard entry exceeds the bounded maximum of ${MAX_HAZARD_ENTRY_CODE_POINTS} code points.`,
    );
  }
  return expandEnglishContractions(value)
    .toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const ATLAS_HAZARD_JACCARD_THRESHOLD = 0.85;

const HAZARD_NEGATION_MARKERS = new Set(['not', 'never', 'no', 'without', 'neither', 'nor']);
const HAZARD_MODAL_MARKERS = new Set([
  'allow',
  'allowed',
  'can',
  'disable',
  'disabled',
  'enable',
  'enabled',
  'forbid',
  'forbidden',
  'may',
  'must',
  'optional',
  'prohibit',
  'prohibited',
  'require',
  'required',
  'should',
]);
const HAZARD_RELATION_MARKERS = new Set([
  'above',
  'after',
  'at',
  'before',
  'below',
  'inside',
  'least',
  'most',
  'outside',
  'over',
  'under',
]);

function hazardTokenSet(key: string): Set<string> {
  return new Set(key.split(' ').filter((token) => token.length > 0));
}

function hazardSemanticSignature(tokens: Set<string>): string {
  const numeric = [...tokens].filter((token) => /\d/.test(token)).sort(compareText);
  const modal = [...tokens].filter((token) => HAZARD_MODAL_MARKERS.has(token)).sort(compareText);
  const relation = [...tokens]
    .filter((token) => HAZARD_RELATION_MARKERS.has(token))
    .sort(compareText);
  const negated = [...tokens].some((token) => HAZARD_NEGATION_MARKERS.has(token));
  return JSON.stringify({ negated, numeric, modal, relation });
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function dedupeHazardsFuzzy(entries: readonly unknown[]): readonly string[] {
  if (entries.length > MAX_HAZARD_ENTRIES) {
    throw new RangeError(`Hazard entry count exceeds the bounded maximum of ${MAX_HAZARD_ENTRIES}.`);
  }
  const kept: string[] = [];
  const exactKeys = new Set<string>();
  const comparisons: Array<{ tokens: Set<string>; signature: string }> = [];

  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (exceedsCodePointLimit(entry, MAX_HAZARD_ENTRY_CODE_POINTS)) {
      throw new RangeError(
        `Hazard entry exceeds the bounded maximum of ${MAX_HAZARD_ENTRY_CODE_POINTS} code points.`,
      );
    }
    const key = normalizeHazardKey(entry);
    if (key.length === 0) {
      kept.push(entry);
      continue;
    }
    if (exactKeys.has(key)) continue;

    const tokens = hazardTokenSet(key);
    const signature = hazardSemanticSignature(tokens);
    const isNearDuplicate = comparisons.some((candidate) =>
      candidate.signature === signature
      && jaccard(tokens, candidate.tokens) >= ATLAS_HAZARD_JACCARD_THRESHOLD);
    if (isNearDuplicate) continue;

    kept.push(entry);
    exactKeys.add(key);
    comparisons.push({ tokens, signature });
  }

  return kept;
}

export interface AtlasHazardFilterOptions {
  suppressed?: ReadonlySet<string>;
  deduplicate?: boolean;
}

export function filterHazards(
  entries: readonly unknown[],
  options: AtlasHazardFilterOptions = {},
): readonly string[] {
  if (entries.length > MAX_HAZARD_ENTRIES) {
    throw new RangeError(`Hazard entry count exceeds the bounded maximum of ${MAX_HAZARD_ENTRIES}.`);
  }
  const visible = entries.filter((entry): entry is string =>
    shouldRenderHazardText(entry, options.suppressed ?? DEFAULT_SUPPRESSED_HAZARD_FRAGMENTS));
  return options.deduplicate === false ? visible : dedupeHazardsFuzzy(visible);
}

const STRUCTURAL_SYMBOL = /^[A-Za-z_$][\w$]*$/;
const IMPORT_EXPORT_FILE = /\.[cm]?[jt]sx?$/i;

export function supportsStructuralImportExportAnalysis(filePath: string): boolean {
  return IMPORT_EXPORT_FILE.test(filePath.trim());
}

export function isStructuralSymbolName(symbol: string): boolean {
  return STRUCTURAL_SYMBOL.test(symbol.trim());
}

export function getStructuralSymbolRegex(symbol: string): RegExp | null {
  const normalized = symbol.trim();
  if (!isStructuralSymbolName(normalized)) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

export function includesStructuralSymbolByContext(candidate: string, symbol: string): boolean {
  const pattern = getStructuralSymbolRegex(symbol);
  return pattern ? pattern.test(candidate) : false;
}

export type AtlasIndexedRecordQuality =
  | 'current'
  | 'unverified'
  | 'stale_advisory'
  | 'historical';
export type AtlasIndexedRecordExclusionReason =
  | 'invalid_identity'
  | 'missing_current_source'
  | 'stale_hash'
  | 'duplicate_lower_quality';

export interface AtlasIndexedRecordCandidate<T> {
  identity: string;
  value: T;
  pathState: AtlasObservedPathState;
  indexedHash?: string | null;
  currentHash?: string | null;
  completeness?: number;
  indexedAt?: string | null;
}

export interface AtlasIndexedRecordSelection<T> {
  identity: string;
  quality: AtlasIndexedRecordQuality;
  candidate: AtlasIndexedRecordCandidate<T>;
}

export interface AtlasIndexedRecordExclusion<T> {
  identity: string;
  reason: AtlasIndexedRecordExclusionReason;
  candidate: AtlasIndexedRecordCandidate<T>;
}

export interface AtlasIndexedRecordSelectionResult<T> {
  selected: readonly AtlasIndexedRecordSelection<T>[];
  excluded: readonly AtlasIndexedRecordExclusion<T>[];
  duplicateCount: number;
  staleCount: number;
  missingCount: number;
}

export interface AtlasIndexedRecordSelectionOptions {
  includeHistorical?: boolean;
  includeStale?: boolean;
}

interface RankedRecord<T> {
  index: number;
  identity: string;
  quality: AtlasIndexedRecordQuality;
  candidate: AtlasIndexedRecordCandidate<T>;
}

function recordQuality<T>(candidate: AtlasIndexedRecordCandidate<T>): AtlasIndexedRecordQuality {
  if (candidate.pathState === 'missing') return 'historical';
  const hasComparableHashes = hasText(candidate.indexedHash) && hasText(candidate.currentHash);
  if (hasComparableHashes && candidate.indexedHash !== candidate.currentHash) return 'stale_advisory';
  if (candidate.pathState === 'current' && hasComparableHashes) return 'current';
  return 'unverified';
}

function rankRecord<T>(left: RankedRecord<T>, right: RankedRecord<T>): number {
  const qualityRank: Readonly<Record<AtlasIndexedRecordQuality, number>> = {
    current: 2,
    unverified: 1,
    stale_advisory: 0,
    historical: -1,
  };
  const quality = qualityRank[right.quality] - qualityRank[left.quality];
  if (quality !== 0) return quality;

  const pathRank: Readonly<Record<AtlasObservedPathState, number>> = {
    current: 2,
    unknown: 1,
    missing: 0,
  };
  const path = pathRank[right.candidate.pathState] - pathRank[left.candidate.pathState];
  if (path !== 0) return path;

  const completeness = boundedRate(right.candidate.completeness)
    - boundedRate(left.candidate.completeness);
  if (completeness !== 0) return completeness;

  const leftTime = parseDeterministicTimestamp(left.candidate.indexedAt) ?? -1;
  const rightTime = parseDeterministicTimestamp(right.candidate.indexedAt) ?? -1;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.index - right.index;
}

/**
 * Select at most one current record for each canonical identity. Exclusions
 * remain explicit so callers can report stale hashes, ghost paths, and
 * suppressed duplicates instead of presenting a deceptively clean result.
 */
export function selectIndexedRecords<T>(
  candidates: readonly AtlasIndexedRecordCandidate<T>[],
  options: AtlasIndexedRecordSelectionOptions = {},
): AtlasIndexedRecordSelectionResult<T> {
  if (candidates.length > 100_000) {
    throw new RangeError('Indexed record candidate count exceeds the bounded maximum of 100000.');
  }
  const groups = new Map<string, RankedRecord<T>[]>();
  const excluded: Array<AtlasIndexedRecordExclusion<T> & { index: number }> = [];

  candidates.forEach((candidate, index) => {
    const identity = candidate.identity.normalize('NFC').trim();
    if (identity.length === 0) {
      excluded.push({ identity, reason: 'invalid_identity', candidate, index });
      return;
    }
    if (candidate.pathState === 'missing' && options.includeHistorical !== true) {
      excluded.push({ identity, reason: 'missing_current_source', candidate, index });
      return;
    }

    const quality = recordQuality(candidate);
    if (quality === 'stale_advisory' && options.includeStale !== true) {
      excluded.push({ identity, reason: 'stale_hash', candidate, index });
      return;
    }
    const group = groups.get(identity) ?? [];
    group.push({ index, identity, quality, candidate });
    groups.set(identity, group);
  });

  const selected: AtlasIndexedRecordSelection<T>[] = [];
  for (const [identity, group] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    const ranked = [...group].sort(rankRecord);
    const winner = ranked[0];
    if (!winner) continue;
    selected.push({ identity, quality: winner.quality, candidate: winner.candidate });
    for (const duplicate of ranked.slice(1)) {
      excluded.push({
        identity,
        reason: 'duplicate_lower_quality',
        candidate: duplicate.candidate,
        index: duplicate.index,
      });
    }
  }

  const orderedExcluded = excluded.sort((left, right) => left.index - right.index);
  return {
    selected,
    excluded: orderedExcluded.map(({ index: _index, ...entry }) => entry),
    duplicateCount: orderedExcluded.filter((entry) => entry.reason === 'duplicate_lower_quality').length,
    staleCount: candidates.filter((candidate) => recordQuality(candidate) === 'stale_advisory').length,
    missingCount: candidates.filter((candidate) => candidate.pathState === 'missing').length,
  };
}
