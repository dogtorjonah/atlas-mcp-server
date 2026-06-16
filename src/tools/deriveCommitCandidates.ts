/**
 * Deterministic, no-LLM candidate derivation for atlas_commit identity fields.
 *
 * When the identity gate rejects a commit (missing purpose/blurb/tags/source_highlights),
 * the handler uses these helpers to scaffold candidate values so the retry is
 * "accept/refine" rather than "author from nothing". The gate itself is unchanged —
 * these are SUGGESTIONS embedded in the rejection, never auto-applied.
 *
 * Heuristics are ported from the atlas-densify forge server (provenance
 * "scaffold-deterministic-v1"). Quality is uneven by construction:
 *  - tags + source_highlights are strong (path/export structure is ground truth),
 *  - purpose/blurb are structural FRAMES only and must be refined, not pasted.
 *
 * Every export here is pure (string in → candidates out). The single source read
 * for highlight ranges happens in the caller (commit.ts) so this module stays
 * I/O-free and trivially unit-testable.
 */

import type { AtlasFileRecord } from '../types.ts';
import type { AtlasCommitRequiredMetadataField } from './commitIdentityValidation.ts';

const AREA_MAP: Record<string, string> = {
  relay: 'relay', app: 'app', 'app-solid': 'app-solid', packages: 'package',
  shared: 'shared', terminal: 'terminal', sop: 'sop', scripts: 'scripts',
  goated: 'goated', docs: 'docs',
};

const GENERIC_STEMS = new Set([
  'index', 'types', 'type', 'route', 'page', 'server', 'client', 'utils', 'util',
  'helpers', 'helper', 'constants', 'config', 'main', 'app', 'mod', 'schema', 'shared',
]);

const CLUSTER_STOP = new Set([
  'dir', 'relay', 'src', 'app', 'app-solid', 'packages', 'shared', 'components',
  'component', 'hooks', 'tools', 'lib', 'root', 'misc', 'test', 'tests', 'stores',
  'store', 'common', 'core', 'utils', 'helpers',
]);

const MAX_HIGHLIGHTS = 6;
const HIGHLIGHT_WINDOW = 60;

export interface DerivedSourceHighlight {
  label: string;
  start_line: number;
  end_line: number;
}

export interface DerivedCommitCandidates {
  tags?: string[];
  purpose?: string;
  blurb?: string;
  source_highlights?: DerivedSourceHighlight[];
}

interface RetryFieldGuide {
  expectedType: string;
  minimum?: string;
  note: string;
}

const RETRY_FIELD_GUIDE: Record<AtlasCommitRequiredMetadataField, RetryFieldGuide> = {
  purpose: {
    expectedType: 'string',
    minimum: '30 characters',
    note: 'Timeless description of what the file does and why it exists.',
  },
  blurb: {
    expectedType: 'string',
    minimum: '20 characters',
    note: 'Tweet-length file identity used in compact Atlas listings.',
  },
  tags: {
    expectedType: 'string[]',
    minimum: '1 tag',
    note: 'Canonical kebab-case file labels; prefer what the file does over where it lives.',
  },
  source_highlights: {
    expectedType: '{ label?: string; startLine: number; endLine: number }[]',
    minimum: '1 usable range; 3-6 is preferred for non-trivial files',
    note: 'Important source regions. content is optional; atlas_commit hydrates it from disk.',
  },
};

export function kebab(value: string): string {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function languageFromPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'py': return 'python';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'swift': return 'swift';
    case 'sql': return 'sql';
    case 'md': return 'markdown';
    default: return null;
  }
}

export function clusterFeature(cluster: string | null | undefined): string {
  if (!cluster) return '';
  const raw = String(cluster);
  const segs = raw.startsWith('dir/') ? raw.slice(4).split('-') : raw.split('/');
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = kebab(segs[i]);
    if (seg && seg.length >= 3 && !CLUSTER_STOP.has(seg)) return seg;
  }
  return '';
}

export function deriveTags(
  filePath: string,
  cluster: string | null | undefined,
  language: string | null | undefined,
): string[] {
  const tags = new Set<string>();
  const parts = filePath.split('/');
  const top = parts[0];
  tags.add(AREA_MAP[top] || top);
  const p = filePath;
  if (/^relay\/src\/atlas\/tools\//.test(p)) tags.add('atlas-tool');
  else if (/^relay\/src\/atlas\//.test(p)) tags.add('atlas');
  if (/^relay\/src\/routes\//.test(p)) { tags.add('route'); tags.add('http'); }
  if (/^relay\/src\/workerPool\//.test(p)) tags.add('worker');
  if (/^relay\/src\/instanceManager\//.test(p)) tags.add('instance-mgmt');
  if (/^relay\/src\/(mcpForge|crossInstanceTools)\//.test(p) || /mcp-forge/.test(p)) tags.add('mcp');
  if (/^relay\/src\/persistence\//.test(p)) tags.add('persistence');
  if (/^relay\/src\/session/i.test(p)) tags.add('session');
  if (/(^|\/)stores?\//.test(p)) tags.add('state-store');
  if (/\/components\//.test(p)) tags.add('react-component');
  if (/\/api\//.test(p)) tags.add('api-route');
  if (/-sidecar(\/|$)/.test(p)) tags.add('sidecar');
  if (/\/hooks\//.test(p)) tags.add('react-hook');
  const base = parts[parts.length - 1];
  if (/\.test\.tsx?$/.test(base)) tags.add('test');
  if (/\.sql$/.test(base) || /migrations?\//.test(p)) tags.add('migration');
  if (base === 'route.ts' || base === 'route.tsx') tags.add('route');
  if (base === 'page.tsx') tags.add('page');
  if (/types?\.ts$/i.test(base)) tags.add('types');
  if (/Store\.tsx?$/.test(base)) tags.add('state-store');
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs|sql|md|go|py|java|swift)$/i, '');
  const kstem = kebab(stem);
  if (kstem && kstem.length >= 3 && !GENERIC_STEMS.has(kstem) && kstem.split('-').length <= 3) {
    tags.add(kstem);
  }
  const cf = clusterFeature(cluster);
  if (cf && !GENERIC_STEMS.has(cf)) tags.add(cf);
  if (language) tags.add(String(language));
  return Array.from(tags).slice(0, 7);
}

function roleForPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  if (/\.test\.tsx?$/.test(base)) return 'test module';
  if (base === 'route.ts') return 'API route handler';
  if (base === 'page.tsx') return 'page component';
  if (/\/components\//.test(filePath)) return 'React component';
  if (/(^|\/)stores?\//.test(filePath)) return 'state store';
  if (/\.sql$/.test(base)) return 'SQL migration';
  return 'module';
}

export function deriveIdentityHints(
  filePath: string,
  cluster: string | null | undefined,
  language: string | null | undefined,
  exportNames: string[],
): { purpose: string; blurb: string } {
  const base = filePath.split('/').pop() ?? filePath;
  const names = exportNames.filter((n) => typeof n === 'string' && n.trim()).slice(0, 5).join(', ');
  const role = roleForPath(filePath);
  const purpose = `${language || 'source'} ${role} at ${filePath}`
    + `${cluster ? ` (cluster ${cluster})` : ''}`
    + `${names ? `; exports ${names}` : ''}.`;
  const blurb = `${base} — ${role}${names ? ` exporting ${names}` : ''}.`;
  return { purpose, blurb };
}

const EXPORT_DECL = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

interface ExportSite { name: string; line: number; }

export function findExportSites(source: string): ExportSite[] {
  const lines = source.split('\n');
  const sites: ExportSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EXPORT_DECL.exec(lines[i]);
    if (m) sites.push({ name: m[2], line: i + 1 });
  }
  return sites;
}

export function deriveSourceHighlightRanges(source: string): DerivedSourceHighlight[] {
  if (!source) return [];
  const totalLines = source.split('\n').length;
  const sites = findExportSites(source);
  if (sites.length === 0) return [];
  const ranges: DerivedSourceHighlight[] = [];
  for (let i = 0; i < sites.length; i++) {
    const start = sites[i].line;
    const nextStart = i + 1 < sites.length ? sites[i + 1].line - 1 : totalLines;
    const end = Math.min(nextStart, start + HIGHLIGHT_WINDOW, totalLines);
    if (end >= start) {
      ranges.push({ label: sites[i].name, start_line: start, end_line: end });
    }
  }
  return ranges.slice(0, MAX_HIGHLIGHTS);
}

export function deriveCommitCandidates(opts: {
  filePath: string;
  missingFields: readonly AtlasCommitRequiredMetadataField[];
  existing?: Pick<AtlasFileRecord, 'cluster' | 'language' | 'exports'> | null;
  source?: string | null;
}): DerivedCommitCandidates {
  const { filePath, missingFields, existing, source } = opts;
  const missing = new Set(missingFields);
  const cluster = existing?.cluster ?? null;
  const language = existing?.language || languageFromPath(filePath);
  const sourceSites = source ? findExportSites(source) : [];
  const recordNames = Array.isArray(existing?.exports)
    ? existing!.exports.map((e) => e?.name).filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : [];
  const exportNames = recordNames.length > 0 ? recordNames : sourceSites.map((s) => s.name);

  const candidates: DerivedCommitCandidates = {};
  if (missing.has('tags')) {
    candidates.tags = deriveTags(filePath, cluster, language);
  }
  if (missing.has('purpose') || missing.has('blurb')) {
    const hints = deriveIdentityHints(filePath, cluster, language, exportNames);
    if (missing.has('purpose')) candidates.purpose = hints.purpose;
    if (missing.has('blurb')) candidates.blurb = hints.blurb;
  }
  if (missing.has('source_highlights') && source) {
    const ranges = deriveSourceHighlightRanges(source);
    if (ranges.length > 0) candidates.source_highlights = ranges;
  }
  return candidates;
}

export function formatDerivedCandidates(candidates: DerivedCommitCandidates): string {
  const inferredFields: AtlasCommitRequiredMetadataField[] = [];
  if (candidates.tags && candidates.tags.length > 0) inferredFields.push('tags');
  if (candidates.source_highlights && candidates.source_highlights.length > 0) inferredFields.push('source_highlights');
  if (candidates.purpose) inferredFields.push('purpose');
  if (candidates.blurb) inferredFields.push('blurb');
  return formatMissingMetadataRetryTemplate(candidates, inferredFields);
}

function candidateValueForField(
  field: AtlasCommitRequiredMetadataField,
  candidates: DerivedCommitCandidates,
): unknown {
  switch (field) {
    case 'purpose':
      return candidates.purpose ?? '<write a real timeless purpose, 30+ chars>';
    case 'blurb':
      return candidates.blurb ?? '<write a compact file identity, 20+ chars>';
    case 'tags':
      return candidates.tags && candidates.tags.length > 0
        ? candidates.tags
        : ['<canonical-kebab-tag>'];
    case 'source_highlights':
      return candidates.source_highlights && candidates.source_highlights.length > 0
        ? candidates.source_highlights.map((highlight) => ({
            label: highlight.label,
            startLine: highlight.start_line,
            endLine: highlight.end_line,
          }))
        : [{ label: '<important region>', startLine: 1, endLine: 1 }];
  }
}

export function formatMissingMetadataRetryTemplate(
  candidates: DerivedCommitCandidates,
  missingFields: readonly AtlasCommitRequiredMetadataField[],
): string {
  if (missingFields.length === 0) return '';
  const lines: string[] = [];
  const retryPayload: Record<string, unknown> = {};

  for (const field of missingFields) {
    const guide = RETRY_FIELD_GUIDE[field];
    retryPayload[field] = candidateValueForField(field, candidates);
    lines.push(
      `- ${field}: expected ${guide.expectedType}`
      + `${guide.minimum ? `, minimum ${guide.minimum}` : ''}; `
      + 'payload is absent, empty, or invalid after normalization; existing Atlas record is also empty. '
      + guide.note,
    );
  }

  const scaffoldNotes: string[] = [];
  if (missingFields.includes('tags') && candidates.tags && candidates.tags.length > 0) {
    scaffoldNotes.push('tags are path-derived and usually safe to accept after pruning obvious noise.');
  }
  if (missingFields.includes('source_highlights') && candidates.source_highlights && candidates.source_highlights.length > 0) {
    scaffoldNotes.push('source_highlights are export/declaration ranges; verify they cover the regions you changed.');
  }
  if (missingFields.includes('purpose') && candidates.purpose) {
    scaffoldNotes.push('purpose is SCAFFOLD ONLY; rewrite with real semantics before retrying.');
  }
  if (missingFields.includes('blurb') && candidates.blurb) {
    scaffoldNotes.push('blurb is SCAFFOLD ONLY; rewrite with real semantics before retrying.');
  }

  return [
    '',
    '',
    '-- atlas_commit retry template --',
    'Missing metadata fields:',
    ...lines,
    '',
    'JSON-native payload additions:',
    JSON.stringify(retryPayload, null, 2),
    ...(scaffoldNotes.length > 0 ? ['', 'Candidate notes:', ...scaffoldNotes.map((note) => `- ${note}`)] : []),
  ].join('\n');
}
