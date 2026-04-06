/**
 * Legacy: LLM deep extraction phase.
 *
 * This module is retained for optional future use with an LLM provider, but is
 * no longer called during the default heuristic-only pipeline. In heuristic-only
 * mode, semantic fields (purpose, public_api, patterns, hazards, conventions,
 * key_types, data_flows, dependencies) start empty and are populated organically
 * by agents via `atlas_commit` as they work with the codebase. The working agent
 * has maximum context — it just wrote or reviewed the code — so its extraction
 * is higher-quality than a cold pass by a cheaper model.
 */
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertFileRecord } from '../db.js';
import type { AtlasFileExtraction, AtlasFileRecord, AtlasProvider } from '../types.js';
import { readSourceFile, toFileUpsertInput } from './shared.js';
import type { ScanFileInfo } from './scan.js';

export interface ExtractResult {
  files: Record<string, AtlasFileExtraction>;
}

export interface ExtractOptions {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
  sourceTextLimit?: number;
}

type ExtractFileInput = ScanFileInfo | AtlasFileRecord;

export async function runExtract(files: ExtractFileInput[]): Promise<ExtractResult>;
export async function runExtract(options: ExtractOptions): Promise<ExtractResult>;
export async function runExtract(
  input: ExtractFileInput[] | ExtractOptions,
): Promise<ExtractResult> {
  if (Array.isArray(input)) {
    const result: ExtractResult['files'] = {};
    for (const file of input) {
      const filePath = 'file_path' in file ? file.file_path : file.filePath;
      const fileExports = file.exports ?? [];
      result[filePath] = {
        purpose: `Scaffold extraction for ${filePath}.`,
        public_api: fileExports.map((entry) => ({
          name: entry.name,
          type: entry.type,
        })),
        exports: fileExports.map((entry) => ({
          name: entry.name,
          type: entry.type,
        })),
        patterns: [],
        dependencies: {},
        data_flows: [],
        key_types: [],
        hazards: [],
        conventions: [],
      };
    }
    return { files: result };
  }

  const files = input.files ?? listAtlasFiles(input.db, input.workspace);
  const result: ExtractResult['files'] = {};
  const now = new Date().toISOString();

  for (const file of files) {
    const sourceText = await readSourceFile(input.sourceRoot, file.file_path);
    if (!sourceText) {
      continue;
    }

    const limitedSourceText = typeof input.sourceTextLimit === 'number' && input.sourceTextLimit > 0
      ? sourceText.slice(0, input.sourceTextLimit)
      : sourceText;

    const extraction = input.provider
      ? await input.provider.extractFile({
          filePath: file.file_path,
          sourceText: limitedSourceText,
          blurb: file.blurb,
        })
      : {
          purpose: `Scaffold extraction for ${file.file_path}.`,
          public_api: [],
          exports: [],
          patterns: [],
          dependencies: {},
          data_flows: [],
          key_types: [],
          hazards: [],
          conventions: [],
        };

    const publicApi = extraction.public_api ?? [];
    const exports = extraction.exports ?? publicApi.map((entry) => ({
      name: entry.name,
      type: entry.type,
    }));

    const normalized: AtlasFileExtraction = {
      purpose: extraction.purpose,
      public_api: publicApi,
      exports,
      patterns: extraction.patterns ?? [],
      dependencies: extraction.dependencies ?? {},
      data_flows: extraction.data_flows ?? [],
      key_types: extraction.key_types ?? [],
      hazards: extraction.hazards ?? [],
      conventions: extraction.conventions ?? [],
    };

    result[file.file_path] = normalized;

    upsertFileRecord(input.db, toFileUpsertInput(file, {
      purpose: normalized.purpose,
      public_api: normalized.public_api,
      exports: normalized.exports,
      patterns: normalized.patterns,
      dependencies: normalized.dependencies,
      data_flows: normalized.data_flows,
      key_types: normalized.key_types,
      hazards: normalized.hazards,
      conventions: normalized.conventions,
      extraction_model: input.provider?.kind ?? 'scaffold',
      last_extracted: now,
    }));
  }

  return { files: result };
}
