import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasCrossRefSymbol, AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, listImportEdges } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

const GAP_TYPES = [
  'loaded_not_used',
  'exported_not_referenced',
  'imported_not_used',
  'installed_not_imported',
] as const;

type GapType =
  | 'loaded_not_used'
  | 'exported_not_referenced'
  | 'imported_not_used'
  | 'installed_not_imported';

interface GapFinding {
  gapType: GapType;
  filePath: string;
  subject: string;
  confidence: number;
  evidence: string[];
  note?: string;
}

interface WorkspaceRuntime {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
}

const DEFAULT_GAP_TYPES: GapType[] = [...GAP_TYPES];

const GAP_LABELS: Record<GapType, string> = {
  loaded_not_used: 'loaded_not_used',
  exported_not_referenced: 'exported_not_referenced',
  imported_not_used: 'imported_not_used',
  installed_not_imported: 'installed_not_imported',
};

function resolveWorkspace(runtime: AtlasRuntime, workspace?: string): WorkspaceRuntime | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return {
      db: runtime.db,
      sourceRoot: runtime.config.sourceRoot,
      workspace: runtime.config.workspace,
    };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((candidate) => candidate.workspace === workspace);
  if (!target) return null;
  return {
    db: target.db,
    sourceRoot: target.sourceRoot,
    workspace: target.workspace,
  };
}

function clampConfidence(value: number): number {
  return Math.max(0.1, Math.min(0.99, Number(value.toFixed(2))));
}

function getScopeFiles(
  db: AtlasDatabase,
  workspace: string,
  filePath?: string,
  cluster?: string,
): AtlasFileRecord[] {
  const files = listAtlasFiles(db, workspace);
  return files.filter((file) => {
    if (filePath && file.file_path !== filePath) return false;
    if (cluster && file.cluster !== cluster) return false;
    return true;
  });
}

function getWordRegex(symbol: string): RegExp {
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

function includesSymbolByContext(candidate: string, symbol: string): boolean {
  return getWordRegex(symbol).test(candidate);
}

function collectCrossRefTexts(row: AtlasFileRecord): string[] {
  if (!row.cross_refs?.symbols) return [];
  const texts: string[] = [];
  for (const info of Object.values(row.cross_refs.symbols)) {
    for (const site of info.call_sites ?? []) {
      if (site.context) texts.push(site.context);
    }
  }
  return texts;
}

function symbolUsedAnywhere(symbol: string, files: AtlasFileRecord[]): boolean {
  for (const file of files) {
    const symbols = file.cross_refs?.symbols;
    if (symbols?.[symbol] && symbols[symbol].total_usages > 0) {
      return true;
    }
    const contexts = collectCrossRefTexts(file);
    if (contexts.some((text) => includesSymbolByContext(text, symbol))) {
      return true;
    }
  }
  return false;
}

function symbolUsedInRow(symbol: string, row: AtlasFileRecord): boolean {
  const symbols = row.cross_refs?.symbols;
  if (symbols?.[symbol] && symbols[symbol].total_usages > 0) return true;
  const contexts = collectCrossRefTexts(row);
  return contexts.some((text) => includesSymbolByContext(text, symbol));
}

function getConsumersByFile(
  workspace: string,
  sourceFile: string,
  edges: Array<{ workspace: string; source_file: string; target_file: string }>,
): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.workspace !== workspace) continue;
    const bucket = reverse.get(edge.target_file) ?? [];
    bucket.push(edge.source_file);
    reverse.set(edge.target_file, bucket);
  }

  const seen = new Set<string>();
  const queue = [...(reverse.get(sourceFile) ?? [])];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const caller of reverse.get(file) ?? []) {
      if (!seen.has(caller)) queue.push(caller);
    }
  }
  return seen;
}

function extractLoadedSymbols(dataFlows: string[]): Array<{ symbol: string; flow: string; strong: boolean }> {
  const extracted: Array<{ symbol: string; flow: string; strong: boolean }> = [];
  const patterns = [
    /\b(?:derive|derives|derived|load|loads|loaded|fetch|fetches|fetched)\s+`?([A-Za-z_$][\w$]*)`?/gi,
    /\b`([A-Za-z_$][\w$]*)`\b/g,
  ];

  for (const flow of dataFlows) {
    if (!flow || typeof flow !== 'string') continue;
    for (const [index, pattern] of patterns.entries()) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(flow);
      while (match) {
        const symbol = (match[1] ?? '').trim();
        if (symbol.length >= 3) {
          extracted.push({
            symbol,
            flow,
            strong: index === 0,
          });
        }
        match = pattern.exec(flow);
      }
    }
  }

  const dedup = new Map<string, { symbol: string; flow: string; strong: boolean }>();
  for (const item of extracted) {
    const existing = dedup.get(item.symbol);
    if (!existing || (!existing.strong && item.strong)) {
      dedup.set(item.symbol, item);
    }
  }
  return [...dedup.values()];
}

function scoreLoadedNotUsed(
  symbol: string,
  sourceRow: AtlasFileRecord,
  downstreamCount: number,
  strongExtraction: boolean,
): number {
  let score = 0.55;
  if (strongExtraction) score += 0.2;
  if (sourceRow.exports.some((entry) => entry.name === symbol)) score += 0.05;
  if (downstreamCount > 0) score += 0.1;
  return clampConfidence(score);
}

function scoreExportedNotReferenced(symbolData: AtlasCrossRefSymbol | undefined): number {
  if (!symbolData) return 0.6;
  if (symbolData.total_usages > 0) return 0.1;
  if ((symbolData.call_sites?.length ?? 0) > 0) return 0.4;
  return 0.8;
}

function scoreImportedNotUsed(symbolCandidates: string[], sideEffectLikely: boolean): number {
  let score = 0.62;
  if (symbolCandidates.length >= 3) score += 0.08;
  if (sideEffectLikely) score -= 0.2;
  return clampConfidence(score);
}

function normalizePackageName(specifier: string): string {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return '';
  if (specifier.startsWith('node:')) return '';
  if (specifier.startsWith('@')) {
    const [scope, pkg] = specifier.split('/');
    if (!scope || !pkg) return '';
    return `${scope}/${pkg}`;
  }
  const [pkg] = specifier.split('/');
  return pkg || '';
}

function stripImportAndRequireStatements(sourceText: string): string {
  return sourceText
    .replace(/^\s*import[\s\S]*?;?\s*$/gm, '')
    .replace(/^\s*const\s+[\w${}\s,]+\s*=\s*require\([^)]*\);?\s*$/gm, '');
}

interface ParsedImport {
  specifier: string;
  importedNames: string[];
  sideEffectOnly: boolean;
}

function parseImports(sourceText: string): ParsedImport[] {
  const parsed: ParsedImport[] = [];

  const staticImportRegex = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let staticMatch: RegExpExecArray | null = staticImportRegex.exec(sourceText);
  while (staticMatch) {
    const clause = (staticMatch[1] ?? '').trim();
    const specifier = (staticMatch[2] ?? '').trim();
    const importedNames: string[] = [];

    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch?.[1]) importedNames.push(namespaceMatch[1]);

    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultMatch?.[1] && !clause.startsWith('{') && !clause.startsWith('*')) {
      importedNames.push(defaultMatch[1]);
    }

    const namedMatch = clause.match(/\{([^}]+)\}/);
    if (namedMatch?.[1]) {
      const names = namedMatch[1]
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
          const aliasMatch = segment.match(/\s+as\s+([A-Za-z_$][\w$]*)$/);
          if (aliasMatch?.[1]) return aliasMatch[1];
          return segment.replace(/\s+/g, '');
        });
      importedNames.push(...names);
    }

    parsed.push({
      specifier,
      importedNames: [...new Set(importedNames)],
      sideEffectOnly: importedNames.length === 0,
    });
    staticMatch = staticImportRegex.exec(sourceText);
  }

  const sideEffectImportRegex = /import\s+['"]([^'"]+)['"]/g;
  let sideEffectMatch: RegExpExecArray | null = sideEffectImportRegex.exec(sourceText);
  while (sideEffectMatch) {
    parsed.push({
      specifier: (sideEffectMatch[1] ?? '').trim(),
      importedNames: [],
      sideEffectOnly: true,
    });
    sideEffectMatch = sideEffectImportRegex.exec(sourceText);
  }

  const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let requireMatch: RegExpExecArray | null = requireRegex.exec(sourceText);
  while (requireMatch) {
    parsed.push({
      specifier: (requireMatch[1] ?? '').trim(),
      importedNames: [],
      sideEffectOnly: true,
    });
    requireMatch = requireRegex.exec(sourceText);
  }

  return parsed;
}

function buildCandidateSpecifiers(sourceFilePath: string, targetFilePath: string): Set<string> {
  const sourceDir = path.posix.dirname(sourceFilePath.replace(/\\/g, '/'));
  const target = targetFilePath.replace(/\\/g, '/');
  let rel = path.posix.relative(sourceDir, target);
  if (!rel.startsWith('.')) rel = `./${rel}`;

  const withoutTsExt = rel.replace(/\.(tsx?|mts|cts)$/i, '');
  const withoutJsExt = withoutTsExt.replace(/\.(jsx?|mjs|cjs)$/i, '');

  const candidates = [
    rel,
    `${withoutJsExt}.js`,
    `${withoutJsExt}.ts`,
    withoutJsExt,
    `${withoutJsExt}/index`,
    `${withoutJsExt}/index.js`,
  ];

  return new Set(candidates);
}

async function readSourceText(sourceRoot: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
  } catch {
    return null;
  }
}

async function collectImportedPackages(sourceRoot: string, files: AtlasFileRecord[]): Promise<Set<string>> {
  const imported = new Set<string>();
  const importRegexes = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  await Promise.all(files.map(async (file) => {
    try {
      const absolute = path.join(sourceRoot, file.file_path);
      const source = await fs.readFile(absolute, 'utf8');
      for (const pattern of importRegexes) {
        let match: RegExpExecArray | null = pattern.exec(source);
        while (match) {
          const pkg = normalizePackageName(match[1] ?? '');
          if (pkg) imported.add(pkg);
          match = pattern.exec(source);
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }));

  return imported;
}

function formatFinding(finding: GapFinding): string {
  const evidence = finding.evidence.join(' | ');
  const note = finding.note ? ` | Note: ${finding.note}` : '';
  return `- \`${finding.subject}\` — ${evidence}\n  Confidence: ${finding.confidence}${note}`;
}

export function registerGapsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_gaps',
    'Detect structural gaps in the codebase: dead exports no one imports, unused imports, loaded-but-unused data, installed-but-never-imported packages. Can scope to a single file or cluster. Returns findings with confidence scores. Use during cleanup or before refactoring.',
    {
      filePath: z.string().min(1).optional(),
      cluster: z.string().min(1).optional(),
      workspace: z.string().optional(),
      gapTypes: z.array(z.enum(GAP_TYPES)).optional(),
    },
    async (input: unknown) => {
      const {
        filePath,
        cluster,
        workspace,
        gapTypes,
      } = input as {
        filePath?: string;
        cluster?: string;
        workspace?: string;
        gapTypes?: GapType[];
      };
      const target = resolveWorkspace(runtime, workspace);
      if (!target) {
        return {
          content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }],
        };
      }

      const types = gapTypes && gapTypes.length > 0 ? gapTypes : DEFAULT_GAP_TYPES;
      const scopedFiles = getScopeFiles(target.db, target.workspace, filePath, cluster);
      if (scopedFiles.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No files matched the requested scope.',
          }],
        };
      }

      const allFiles = listAtlasFiles(target.db, target.workspace);
      const fileMap = new Map(allFiles.map((file) => [file.file_path, file]));
      const scopedSet = new Set(scopedFiles.map((file) => file.file_path));
      const edges = listImportEdges(target.db, target.workspace);
      const findings: GapFinding[] = [];
      const sourceCache = new Map<string, string | null>();

      if (types.includes('loaded_not_used')) {
        for (const file of scopedFiles) {
          const loadedSymbols = extractLoadedSymbols(file.data_flows ?? []);
          if (loadedSymbols.length === 0) continue;

          const downstream = getConsumersByFile(target.workspace, file.file_path, edges);
          const downstreamRows = [...downstream]
            .map((name) => fileMap.get(name))
            .filter((row): row is AtlasFileRecord => Boolean(row));

          for (const symbolEntry of loadedSymbols) {
            const symbol = symbolEntry.symbol;
            const usedInSource = symbolUsedInRow(symbol, file);
            const usedDownstream = symbolUsedAnywhere(symbol, downstreamRows);
            if (usedInSource || usedDownstream) continue;

            findings.push({
              gapType: 'loaded_not_used',
              filePath: file.file_path,
              subject: symbol,
              confidence: scoreLoadedNotUsed(symbol, file, downstreamRows.length, symbolEntry.strong),
              evidence: [
                `data_flows mentions "${symbolEntry.flow}"`,
                `0 references across ${downstreamRows.length} downstream files`,
              ],
            });
          }
        }
      }

      if (types.includes('exported_not_referenced')) {
        for (const file of scopedFiles) {
          const exports = file.exports ?? [];
          const symbols = file.cross_refs?.symbols ?? {};
          for (const exported of exports) {
            const symbol = exported.name;
            const direct = symbols[symbol];
            const globallyUsed = symbolUsedAnywhere(symbol, allFiles);
            const totalUsages = direct?.total_usages ?? 0;
            if (totalUsages > 0 || globallyUsed) continue;
            findings.push({
              gapType: 'exported_not_referenced',
              filePath: file.file_path,
              subject: symbol,
              confidence: clampConfidence(scoreExportedNotReferenced(direct)),
              evidence: [
                `export "${symbol}" has 0 call_sites`,
                'symbol not found in workspace cross_refs contexts',
              ],
              note: 'May be intentionally internal or future-facing.',
            });
          }
        }
      }

      if (types.includes('imported_not_used')) {
        for (const edge of edges) {
          if (!scopedSet.has(edge.source_file)) continue;
          const source = fileMap.get(edge.source_file);
          const targetFile = fileMap.get(edge.target_file);
          if (!source || !targetFile) continue;

          const symbolCandidates = new Set<string>();
          for (const exp of targetFile.exports ?? []) symbolCandidates.add(exp.name);
          for (const keyType of targetFile.key_types ?? []) {
            if (typeof keyType === 'object' && keyType && 'name' in keyType && typeof keyType.name === 'string') {
              symbolCandidates.add(keyType.name);
            }
          }

          if (!sourceCache.has(edge.source_file)) {
            sourceCache.set(edge.source_file, await readSourceText(target.sourceRoot, edge.source_file));
          }
          const sourceText = sourceCache.get(edge.source_file);
          if (!sourceText) {
            continue;
          }

          const imports = parseImports(sourceText);
          const candidateSpecifiers = buildCandidateSpecifiers(edge.source_file, edge.target_file);
          const relevantImports = imports.filter((entry) => candidateSpecifiers.has(entry.specifier));
          if (relevantImports.length === 0) continue;

          const bodyWithoutImports = stripImportAndRequireStatements(sourceText);
          const importedIdentifiers = new Set<string>();
          let sideEffectImportOnly = false;
          for (const entry of relevantImports) {
            if (entry.sideEffectOnly) {
              sideEffectImportOnly = true;
              continue;
            }
            for (const name of entry.importedNames) {
              importedIdentifiers.add(name);
            }
          }

          const usedAnyIdentifier = [...importedIdentifiers].some((name) =>
            includesSymbolByContext(bodyWithoutImports, name));
          const usedAnyTargetSymbol = [...symbolCandidates].some((symbol) =>
            includesSymbolByContext(bodyWithoutImports, symbol));
          const usedAny = usedAnyIdentifier || usedAnyTargetSymbol;

          if (usedAny) continue;

          const sideEffectLikely = sideEffectImportOnly || symbolCandidates.size === 0;
          const confidence = sideEffectLikely
            ? clampConfidence(scoreImportedNotUsed([...symbolCandidates], sideEffectLikely) - 0.22)
            : scoreImportedNotUsed([...symbolCandidates], sideEffectLikely);
          findings.push({
            gapType: 'imported_not_used',
            filePath: edge.source_file,
            subject: edge.target_file,
            confidence,
            evidence: [
              `import edge exists: ${edge.source_file} -> ${edge.target_file}`,
              `import bindings found but no local usage in source body`,
            ],
            note: sideEffectLikely
              ? 'suspected: may be intentional side-effect import'
              : undefined,
          });
        }
      }

      if (types.includes('installed_not_imported')) {
        try {
          const packageJsonPath = path.join(target.sourceRoot, 'package.json');
          const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
          const packageJson = JSON.parse(packageJsonRaw) as {
            dependencies?: Record<string, string>;
          };
          const declared = new Set(Object.keys(packageJson.dependencies ?? {}));
          const importedPackages = await collectImportedPackages(target.sourceRoot, allFiles);

          for (const dependency of declared) {
            if (importedPackages.has(dependency)) continue;
            findings.push({
              gapType: 'installed_not_imported',
              filePath: 'package.json',
              subject: dependency,
              confidence: 0.9,
              evidence: [
                'dependency declared in package.json',
                'no import/require usage found across atlas-indexed source files',
              ],
            });
          }
        } catch {
          findings.push({
            gapType: 'installed_not_imported',
            filePath: 'package.json',
            subject: '(unreadable package.json)',
            confidence: 0.2,
            evidence: ['failed to parse package.json; skipped dependency gap check'],
          });
        }
      }

      const scopeLabel = filePath ?? cluster ?? `${scopedFiles.length} scoped files`;
      const lines: string[] = [];
      lines.push(`## Structural Gaps: ${scopeLabel}`);
      lines.push('');

      for (const type of types) {
        const typeFindings = findings.filter((finding) => finding.gapType === type);
        lines.push(`### ${GAP_LABELS[type]} (${typeFindings.length} found)`);
        if (typeFindings.length === 0) {
          lines.push('- none');
        } else {
          for (const finding of typeFindings) {
            lines.push(`File: ${finding.filePath}`);
            lines.push(formatFinding(finding));
          }
        }
        lines.push('');
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n').trim(),
        }],
      };
    },
  );
}
