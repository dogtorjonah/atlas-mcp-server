import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertFileRecord } from '../db.js';
import type { AtlasFileExtraction, AtlasFileRecord, AtlasProvider } from '../types.js';
import { readSourceFile, toFileUpsertInput } from './shared.js';
import type { Pass0FileInfo } from './pass0.js';

export interface Pass1Result {
  files: Record<string, AtlasFileExtraction>;
}

export interface Pass1Options {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
  sourceTextLimit?: number;
}

type Pass1FileInput = Pass0FileInfo | AtlasFileRecord;

export async function runPass1(files: Pass1FileInput[]): Promise<Pass1Result>;
export async function runPass1(options: Pass1Options): Promise<Pass1Result>;
export async function runPass1(
  input: Pass1FileInput[] | Pass1Options,
): Promise<Pass1Result> {
  if (Array.isArray(input)) {
    const result: Pass1Result['files'] = {};
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
  const result: Pass1Result['files'] = {};
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
