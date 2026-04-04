import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile } from '../db.js';
import type { AtlasProvider } from '../types.js';
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
  provider?: AtlasProvider;
  contextLines?: number;
  maxGrepHits?: number;
  /** Atlas DB for blurb lookups in tiered proximity context */
  db?: AtlasDatabase;
  /** Workspace name for DB lookups */
  workspace?: string;
}

// Proximity tiers for caller context
const SAME_DIR_HOPS = 0;
const NEAR_HOPS_MAX = 2;
const FULL_FILE_CHAR_LIMIT = 8000;   // ~200 lines — covers most TS files in full
const BATCH_PROMPT_CHAR_LIMIT = 40000; // well within gpt-5.4-mini's 128k token window

interface ExportedSymbol {
  name: string;
  type: string;
}

interface GrepMatchGroup {
  file: string;
  matchCount: number;
  lines: string[];
}

interface ProviderCrossRefSymbol {
  type?: string;
  call_sites?: Pass2CallSite[];
  total_usages?: number;
  blast_radius?: string;
}

const PASS2_PROMPT_TEMPLATE = fs.readFileSync(
  fileURLToPath(new URL('./prompts/pass2.txt', import.meta.url)),
  'utf8',
);

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

function evaluateBlastRadius(totalUsages: number, fileCount: number): string {
  if (totalUsages === 0) {
    return 'local';
  }
  if (fileCount <= 1 && totalUsages <= 2) {
    return 'narrow';
  }
  if (fileCount <= 3 && totalUsages <= 6) {
    return 'moderate';
  }
  return 'broad';
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
      if (name) {
        add(name, type);
      }
    }
  }

  for (const match of sourceText.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const entries = match[1]?.split(',') ?? [];
    for (const entry of entries) {
      const [sourceName, aliasName] = entry.split(/\s+as\s+/i).map((part) => part.trim());
      if (sourceName) {
        add(aliasName || sourceName, 're-export');
      }
    }
  }

  return [...discovered.values()];
}

function buildPass2Prompt(symbolName: string, symbolType: string, context: string): string {
  return PASS2_PROMPT_TEMPLATE
    .replaceAll('{{symbol_name}}', symbolName)
    .replaceAll('{{symbol_type}}', symbolType)
    .replaceAll('{{context}}', context);
}

function coerceProviderSymbol(value: unknown): ProviderCrossRefSymbol | null {
  if (typeof value === 'string') {
    try {
      return coerceProviderSymbol(JSON.parse(value));
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if ('symbols' in candidate && candidate.symbols && typeof candidate.symbols === 'object' && !Array.isArray(candidate.symbols)) {
    const first = Object.values(candidate.symbols as Record<string, unknown>)[0];
    return coerceProviderSymbol(first);
  }

  const callSites = candidate.call_sites;
  if (Array.isArray(callSites)) {
    return {
      type: typeof candidate.type === 'string' ? candidate.type : undefined,
      call_sites: callSites.filter((entry): entry is Pass2CallSite => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        const row = entry as Record<string, unknown>;
        return typeof row.file === 'string'
          && typeof row.usage_type === 'string'
          && typeof row.context === 'string'
          && typeof row.count === 'number';
      }),
      total_usages: typeof candidate.total_usages === 'number' ? candidate.total_usages : undefined,
      blast_radius: typeof candidate.blast_radius === 'string' ? candidate.blast_radius : undefined,
    };
  }

  return null;
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
      if (!trimmed) {
        continue;
      }

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

function coerceCrossRefSymbol(
  symbolName: string,
  symbolType: string,
  groups: GrepMatchGroup[],
  providerResult: ProviderCrossRefSymbol | null,
  maxGrepHits: number,
): Pass2SymbolCrossRef {
  const fallbackCallSites = buildFallbackCallSites(symbolName, groups, maxGrepHits);
  const providerCallSites = providerResult?.call_sites?.filter((site) => typeof site.file === 'string' && typeof site.usage_type === 'string' && typeof site.context === 'string' && typeof site.count === 'number') ?? [];
  const callSites = providerCallSites.length > 0 ? providerCallSites : fallbackCallSites;
  // Only trust provider totals/radius when provider contributed real usage signal.
  const providerHasUsageSignal = providerCallSites.length > 0 || (providerResult?.total_usages ?? 0) > 0;
  const derivedUsages = callSites.reduce((sum, site) => sum + site.count, 0);
  const totalUsages = providerHasUsageSignal
    ? (providerResult?.total_usages ?? derivedUsages)
    : derivedUsages;
  const blastRadius = providerHasUsageSignal
    ? (providerResult?.blast_radius ?? evaluateBlastRadius(totalUsages, callSites.length))
    : evaluateBlastRadius(totalUsages, callSites.length);

  return {
    type: providerResult?.type ?? symbolType,
    call_sites: callSites,
    total_usages: totalUsages,
    blast_radius: blastRadius,
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
}

function countDirectoryHops(sourceFile: string, callerFile: string): number {
  const sourceDir = path.dirname(sourceFile);
  const callerDir = path.dirname(callerFile);
  const rel = path.relative(sourceDir, callerDir);
  if (rel === '') return SAME_DIR_HOPS;
  return rel.split('/').filter((part) => part !== '').length;
}

async function buildCallerEntry(
  callerFile: string,
  snippet: string,
  hops: number,
  sourceRoot: string,
  db?: AtlasDatabase,
  workspace?: string,
): Promise<string> {
  if (hops === SAME_DIR_HOPS) {
    try {
      const content = await readFile(path.join(sourceRoot, callerFile), 'utf8');
      return `[SAME DIR] ${callerFile}\n${content.slice(0, FULL_FILE_CHAR_LIMIT)}`;
    } catch {
      return `[SAME DIR] ${callerFile}\n${snippet}`;
    }
  }
  if (hops <= NEAR_HOPS_MAX && db && workspace) {
    const record = getAtlasFile(db, workspace, callerFile);
    const blurb = record?.blurb || record?.purpose || '';
    return `[NEAR ${hops}hop] ${callerFile}${blurb ? `\nPurpose: ${blurb}` : ''}\nUsage: ${snippet}`;
  }
  return `[FAR] ${callerFile}\nUsage: ${snippet}`;
}

async function buildFileBatchPrompt(
  file: Pass0FileInfo,
  symbolGroups: Array<{ symbol: ExportedSymbol; groups: GrepMatchGroup[] }>,
  options: Pass2Options,
): Promise<string> {
  const parts: string[] = [
    `File: ${file.filePath}`,
    '',
    'EXPORTED SYMBOLS AND THEIR CALLERS:',
    '=====================================',
  ];

  let totalChars = parts.join('\n').length;

  for (const { symbol, groups } of symbolGroups) {
    if (groups.length === 0) {
      parts.push(`\nSymbol: ${symbol.name} (${symbol.type})\nNo callers found.`);
      continue;
    }

    const symbolHeader = `\nSymbol: ${symbol.name} (${symbol.type})\nCallers (${groups.length}):`;
    parts.push(symbolHeader);
    totalChars += symbolHeader.length;

    // Sort: same dir first, then by hop count
    const sortedGroups = [...groups].sort((a, b) => {
      const hopsA = countDirectoryHops(file.filePath, a.file);
      const hopsB = countDirectoryHops(file.filePath, b.file);
      return hopsA - hopsB || b.matchCount - a.matchCount;
    });

    for (const group of sortedGroups) {
      if (totalChars >= BATCH_PROMPT_CHAR_LIMIT) {
        parts.push(`  ... (${groups.length - sortedGroups.indexOf(group)} more callers truncated)`);
        break;
      }
      const hops = countDirectoryHops(file.filePath, group.file);
      const snippet = normalizeContextLines(group.lines, 400);
      const entry = await buildCallerEntry(group.file, snippet, hops, options.sourceRoot, options.db, options.workspace);
      parts.push(entry);
      totalChars += entry.length;
    }
  }

  parts.push(
    '',
    'Return JSON with one key per symbol name:',
    '{ "<symbolName>": { "type": string, "call_sites": [{ "file": string, "usage_type": string, "count": number, "context": string }], "total_usages": number, "blast_radius": "local"|"narrow"|"moderate"|"broad" } }',
  );

  return parts.join('\n');
}

function parseFileBatchResult(
  result: unknown,
  symbolNames: string[],
): Record<string, ProviderCrossRefSymbol | null> {
  const out: Record<string, ProviderCrossRefSymbol | null> = {};
  for (const name of symbolNames) {
    out[name] = null;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return out;
  const record = result as Record<string, unknown>;
  for (const name of symbolNames) {
    if (name in record) {
      out[name] = coerceProviderSymbol(record[name]);
    }
  }
  return out;
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
    const exportedSymbols = extractExportedSymbols(sourceText);
    const symbols: Record<string, Pass2SymbolCrossRef> = {};

    // Collect grep results for all symbols up front
    const symbolGroups: Array<{ symbol: ExportedSymbol; groups: GrepMatchGroup[] }> = [];
    for (const exportedSymbol of exportedSymbols) {
      const groups = runGrep(exportedSymbol.name, options.sourceRoot, file.filePath, contextLines);
      symbolGroups.push({ symbol: exportedSymbol, groups });
    }

    // One AI call per file (batch all symbols), with tiered proximity context
    let batchResult: Record<string, ProviderCrossRefSymbol | null> = {};
    if (options.provider && exportedSymbols.length > 0) {
      try {
        const prompt = await buildFileBatchPrompt(file, symbolGroups, options);
        const raw = await options.provider.extractCrossRefs({
          filePath: file.filePath,
          sourceText: prompt,
        });
        batchResult = parseFileBatchResult(raw, exportedSymbols.map((s) => s.name));
      } catch {
        // Fall through to heuristic for all symbols
      }
    }

    for (const { symbol: exportedSymbol, groups } of symbolGroups) {
      const providerResult = batchResult[exportedSymbol.name] ?? null;
      symbols[exportedSymbol.name] = coerceCrossRefSymbol(
        exportedSymbol.name,
        exportedSymbol.type,
        groups,
        providerResult,
        maxGrepHits,
      );
    }

    const crossRefs: Pass2CrossRef = {
      symbols,
      total_exports_analyzed: exportedSymbols.length,
      total_cross_references: Object.values(symbols).reduce((sum, symbol) => sum + symbol.total_usages, 0),
      pass2_model: options.provider?.kind ?? 'heuristic',
      pass2_timestamp: new Date().toISOString(),
    };

    result[file.filePath] = crossRefs;
  }

  return result;
}
