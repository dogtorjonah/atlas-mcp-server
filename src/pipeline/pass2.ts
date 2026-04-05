import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { AtlasDatabase } from '../db.js';
import { replaceReferencesForFile } from '../db.js';
import type { Pass0FileInfo } from './pass0.js';

export interface Pass2CallSite {
  file: string;
  usage_type: string;
  count: number;
  context: string;
}

export interface Pass2SymbolCrossRef {
  type: string;
  call_sites: Pass2CallSite[];
  total_usages: number;
  blast_radius: string;
}

export interface Pass2CrossRef {
  symbols: Record<string, Pass2SymbolCrossRef>;
  total_exports_analyzed: number;
  total_cross_references: number;
  pass2_model?: string;
  pass2_timestamp?: string;
}

export interface Pass2Options {
  sourceRoot: string;
  // Compatibility only while orchestration lanes remove provider coupling.
  provider?: unknown;
  contextLines?: number;
  maxGrepHits?: number;
  db?: AtlasDatabase;
  workspace?: string;
}

interface ExportedSymbol {
  name: string;
  type: string;
}

interface GrepMatchGroup {
  file: string;
  matchCount: number;
  lines: string[];
}

interface ReferenceUsageRow {
  target_symbol_name: string;
  target_symbol_kind: string;
  source_file: string | null;
  edge_type: string | null;
  usage_count: number | null;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContextLines(lines: string[], maxLength = 240): string {
  const compact = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function inferUsageType(symbolName: string, lines: string[]): string {
  const joined = lines.join('\n');
  const symbol = escapeRegExp(symbolName);
  if (new RegExp(`\\bfrom\\s+['"][^'"]*['"]`).test(joined) && joined.includes(symbolName)) {
    return 'import';
  }
  if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`).test(joined)) {
    return 're-export';
  }
  if (new RegExp(`\\bnew\\s+${symbol}\\b`).test(joined) || new RegExp(`\\b${symbol}\\s*\\(`).test(joined)) {
    return 'call';
  }
  if (new RegExp(`\\btypeof\\s+${symbol}\\b`).test(joined) || new RegExp(`:\\s*${symbol}\\b`).test(joined)) {
    return 'type-reference';
  }
  return 'reference';
}

function evaluateBlastRadius(uniqueConsumerFiles: number): string {
  if (uniqueConsumerFiles <= 1) {
    return 'low';
  }
  if (uniqueConsumerFiles <= 5) {
    return 'medium';
  }
  if (uniqueConsumerFiles <= 15) {
    return 'high';
  }
  return 'critical';
}

export function extractExportedSymbols(sourceText: string): ExportedSymbol[] {
  const discovered = new Map<string, ExportedSymbol>();
  const add = (name: string, type: string): void => {
    const normalized = name.trim();
    if (!normalized || normalized === 'default') {
      return;
    }
    if (!discovered.has(normalized)) {
      discovered.set(normalized, { name: normalized, type });
    }
  };

  const patterns: Array<{ regex: RegExp; type: string }> = [
    { regex: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, type: 'function' },
    { regex: /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g, type: 'class' },
    { regex: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g, type: 'interface' },
    { regex: /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g, type: 'type' },
    { regex: /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/g, type: 'enum' },
    { regex: /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, type: 'value' },
    { regex: /\bexport\s+namespace\s+([A-Za-z_$][\w$]*)/g, type: 'namespace' },
  ];

  for (const { regex, type } of patterns) {
    for (const match of sourceText.matchAll(regex)) {
      const name = match[1];
      if (name) add(name, type);
    }
  }

  for (const match of sourceText.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const entries = match[1]?.split(',') ?? [];
    for (const entry of entries) {
      const [sourceName, aliasName] = entry.split(/\s+as\s+/i).map((part) => part.trim());
      if (sourceName) add(aliasName || sourceName, 're-export');
    }
  }

  return [...discovered.values()];
}

function getDeterministicExportedSymbols(
  file: Pass0FileInfo,
  sourceText: string,
  db?: AtlasDatabase,
  workspace?: string,
): ExportedSymbol[] {
  if (db && workspace) {
    const rows = db.prepare(
      `SELECT name, kind
       FROM symbols
       WHERE workspace = ? AND file_path = ? AND exported = 1
       ORDER BY name ASC`,
    ).all(workspace, file.filePath) as Array<{ name: string; kind: string }>;

    if (rows.length > 0) {
      const dedupe = new Map<string, ExportedSymbol>();
      for (const row of rows) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        if (!dedupe.has(name)) {
          dedupe.set(name, { name, type: String(row.kind ?? 'unknown') });
        }
      }
      return [...dedupe.values()];
    }
  }

  if (Array.isArray(file.exports) && file.exports.length > 0) {
    const dedupe = new Map<string, ExportedSymbol>();
    for (const entry of file.exports) {
      const name = String(entry.name ?? '').trim();
      if (!name) continue;
      if (!dedupe.has(name)) {
        dedupe.set(name, { name, type: String(entry.type ?? 'unknown') });
      }
    }
    if (dedupe.size > 0) {
      return [...dedupe.values()];
    }
  }

  return extractExportedSymbols(sourceText);
}

function runGrep(symbolName: string, sourceRoot: string, definingFile: string, contextLines: number): GrepMatchGroup[] {
  try {
    const output = execFileSync('rg', [
      '--json',
      '-n',
      '-w',
      '-F',
      '-C',
      String(contextLines),
      '--glob',
      '**/*.ts',
      '--glob',
      '**/*.tsx',
      '--glob',
      '**/*.mts',
      '--glob',
      '**/*.cts',
      '--glob',
      '!**/node_modules/**',
      '--glob',
      '!**/dist/**',
      '--glob',
      '!**/.git/**',
      '--glob',
      '!**/*.d.ts',
      '--glob',
      '!**/.next/**',
      '--glob',
      '!**/docs/**',
      '--glob',
      '!**/*.md',
      '--glob',
      '!**/*.json',
      '--glob',
      '!**/.atlas/**',
      '--glob',
      '!**/relay/scripts/codebase-atlas/**',
      symbolName,
      '.',
    ], {
      cwd: sourceRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
    });

    const groups = new Map<string, GrepMatchGroup>();
    const normalizedDefiningFile = normalizePath(definingFile);

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string } } };
      try {
        event = JSON.parse(trimmed) as typeof event;
      } catch {
        continue;
      }

      if (!event.type || !event.data?.path?.text || !event.data.lines?.text) {
        continue;
      }

      if (event.type !== 'match' && event.type !== 'context') {
        continue;
      }

      const file = normalizePath(event.data.path.text);
      if (file === normalizedDefiningFile) {
        continue;
      }

      const existing = groups.get(file) ?? { file, matchCount: 0, lines: [] };
      existing.lines.push(event.data.lines.text.trimEnd());
      if (event.type === 'match') {
        existing.matchCount += 1;
      }
      groups.set(file, existing);
    }

    return [...groups.values()].sort((left, right) => right.matchCount - left.matchCount || left.file.localeCompare(right.file));
  } catch (error) {
    const code = typeof error === 'object' && error && 'status' in error ? (error as { status?: number }).status : undefined;
    if (code === 1) {
      return [];
    }
    const syscall = typeof error === 'object' && error && 'syscall' in error ? (error as { syscall?: string }).syscall : undefined;
    const signal = typeof error === 'object' && error && 'signal' in error ? (error as { signal?: string }).signal : undefined;
    const errCode = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined;
    console.warn(
      `[atlas-pass2] rg lookup failed for symbol="${symbolName}" file="${definingFile}" `
      + `(status=${String(code ?? 'n/a')} code=${String(errCode ?? 'n/a')} signal=${String(signal ?? 'n/a')} syscall=${String(syscall ?? 'n/a')})`,
    );
    return [];
  }
}

function buildFallbackCallSites(symbolName: string, groups: GrepMatchGroup[], maxGrepHits: number): Pass2CallSite[] {
  return groups
    .slice(0, maxGrepHits)
    .map((group) => ({
      file: group.file,
      usage_type: inferUsageType(symbolName, group.lines),
      count: group.matchCount,
      context: normalizeContextLines(group.lines),
    }))
    .filter((site) => site.count > 0);
}

function listDeterministicUsages(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
): ReferenceUsageRow[] {
  return db.prepare(
    `SELECT
       s.name AS target_symbol_name,
       s.kind AS target_symbol_kind,
       r.source_file AS source_file,
       r.edge_type AS edge_type,
       SUM(r.usage_count) AS usage_count
     FROM symbols s
     LEFT JOIN "references" r
       ON r.workspace = s.workspace
      AND r.target_symbol_id = s.id
      AND r.edge_type IN ('CALLS', 'DATA_FLOWS_TO', 'PRODUCES', 'CONSUMES', 'TRIGGERS')
      AND r.source_file != s.file_path
     WHERE s.workspace = ?
       AND s.file_path = ?
       AND s.exported = 1
     GROUP BY s.id, r.source_file, r.edge_type
     ORDER BY s.name ASC, r.source_file ASC, r.edge_type ASC`,
  ).all(workspace, filePath) as ReferenceUsageRow[];
}

function groupUsagesBySymbol(rows: ReferenceUsageRow[]): Map<string, ReferenceUsageRow[]> {
  const grouped = new Map<string, ReferenceUsageRow[]>();
  for (const row of rows) {
    const symbolName = String(row.target_symbol_name ?? '').trim();
    if (!symbolName) continue;
    if (!grouped.has(symbolName)) grouped.set(symbolName, []);
    grouped.get(symbolName)!.push(row);
  }
  return grouped;
}

function mapEdgeTypeToUsageType(edgeType: string): string {
  switch (edgeType) {
    case 'CALLS':
      return 'call';
    case 'DATA_FLOWS_TO':
      return 'data-flow';
    case 'PRODUCES':
      return 'produces';
    case 'CONSUMES':
      return 'consumes';
    case 'TRIGGERS':
      return 'triggers';
    default:
      return 'reference';
  }
}

function buildDeterministicCallSites(
  rows: ReferenceUsageRow[],
  grepByFile: Map<string, GrepMatchGroup>,
): Pass2CallSite[] {
  const grouped = new Map<string, Pass2CallSite>();

  for (const row of rows) {
    const file = String(row.source_file ?? '').trim();
    const edgeType = String(row.edge_type ?? '').trim();
    if (!file || !edgeType) continue;

    const usageType = mapEdgeTypeToUsageType(edgeType);
    const key = `${file}\u0000${usageType}`;
    const existing = grouped.get(key) ?? {
      file,
      usage_type: usageType,
      count: 0,
      context: '',
    };
    const count = typeof row.usage_count === 'number' && Number.isFinite(row.usage_count)
      ? Math.max(1, Math.floor(row.usage_count))
      : 1;
    existing.count += count;
    grouped.set(key, existing);
  }

  const callSites = [...grouped.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  for (const site of callSites) {
    const grepGroup = grepByFile.get(site.file);
    site.context = grepGroup
      ? normalizeContextLines(grepGroup.lines)
      : `deterministic ${site.usage_type} reference`;
  }
  return callSites;
}

function buildHeuristicCrossRef(
  symbolName: string,
  symbolType: string,
  usageRows: ReferenceUsageRow[],
  grepGroups: GrepMatchGroup[],
  maxGrepHits: number,
): Pass2SymbolCrossRef {
  const grepByFile = new Map(grepGroups.map((group) => [group.file, group]));
  const deterministicCallSites = buildDeterministicCallSites(usageRows, grepByFile);

  const callSites = deterministicCallSites.length > 0
    ? deterministicCallSites
    : buildFallbackCallSites(symbolName, grepGroups, maxGrepHits);

  const uniqueConsumerFiles = new Set(callSites.map((site) => site.file)).size;
  const totalUsages = callSites.reduce((sum, site) => sum + site.count, 0);

  return {
    type: symbolType,
    call_sites: callSites,
    total_usages: totalUsages,
    blast_radius: evaluateBlastRadius(uniqueConsumerFiles),
  };
}

export function persistPass2CrossRefs(
  db: import('../db.js').AtlasDatabase,
  workspace: string,
  filePath: string,
  crossRefs: Pass2CrossRef,
): void {
  db.prepare(
    `UPDATE atlas_files
     SET cross_refs = ?, updated_at = CURRENT_TIMESTAMP
     WHERE workspace = ? AND file_path = ?`,
  ).run(JSON.stringify(crossRefs), workspace, filePath);
  replaceReferencesForFile(db, workspace, filePath, crossRefs);
}

export async function runPass2(
  files: Pass0FileInfo[],
  options: Pass2Options,
): Promise<Record<string, Pass2CrossRef>> {
  const result: Record<string, Pass2CrossRef> = {};
  const contextLines = options.contextLines ?? 2;
  const maxGrepHits = options.maxGrepHits ?? 10;

  for (const file of files) {
    const sourceText = await readFile(file.absolutePath, 'utf8');
    const exportedSymbols = getDeterministicExportedSymbols(file, sourceText, options.db, options.workspace);
    const usageRows = options.db && options.workspace
      ? listDeterministicUsages(options.db, options.workspace, file.filePath)
      : [];
    const usageRowsBySymbol = groupUsagesBySymbol(usageRows);
    const symbols: Record<string, Pass2SymbolCrossRef> = {};

    for (const exportedSymbol of exportedSymbols) {
      const grepGroups = runGrep(exportedSymbol.name, options.sourceRoot, file.filePath, contextLines);
      const symbolRows = usageRowsBySymbol.get(exportedSymbol.name) ?? [];
      symbols[exportedSymbol.name] = buildHeuristicCrossRef(
        exportedSymbol.name,
        exportedSymbol.type,
        symbolRows,
        grepGroups,
        maxGrepHits,
      );
    }

    const crossRefs: Pass2CrossRef = {
      symbols,
      total_exports_analyzed: exportedSymbols.length,
      total_cross_references: Object.values(symbols).reduce((sum, symbol) => sum + symbol.total_usages, 0),
      pass2_model: 'heuristic',
      pass2_timestamp: new Date().toISOString(),
    };

    result[file.filePath] = crossRefs;

  }

  return result;
}
