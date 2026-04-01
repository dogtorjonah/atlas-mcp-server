import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertFileRecord } from '../db.js';
import type { AtlasFileRecord, AtlasProvider } from '../types.js';
import type { Pass0FileInfo } from './pass0.js';
import { readSourceFile, toFileUpsertInput } from './shared.js';

export interface Pass05Result {
  blurbs: Record<string, string>;
}

export interface Pass05Options {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
  sourceTextLimit?: number;
}

type Pass05FileInput = Pass0FileInfo | AtlasFileRecord;

export async function runPass05(files: Pass05FileInput[]): Promise<Pass05Result>;
export async function runPass05(options: Pass05Options): Promise<Pass05Result>;
export async function runPass05(
  input: Pass05FileInput[] | Pass05Options,
): Promise<Pass05Result> {
  if (Array.isArray(input)) {
    const blurbs: Record<string, string> = {};
    for (const file of input) {
      const filePath = 'file_path' in file ? file.file_path : file.filePath;
      const baseName = filePath.split('/').pop() ?? filePath;
      blurbs[filePath] = `Scaffold blurb for ${baseName}.`;
    }
    return { blurbs };
  }

  const files = input.files ?? listAtlasFiles(input.db, input.workspace);
  const blurbs: Record<string, string> = {};

  for (const file of files) {
    const sourceText = await readSourceFile(input.sourceRoot, file.file_path);
    if (!sourceText) {
      continue;
    }

    const limitedSourceText = typeof input.sourceTextLimit === 'number' && input.sourceTextLimit > 0
      ? sourceText.slice(0, input.sourceTextLimit)
      : sourceText;

    const blurb = input.provider
      ? await input.provider.generateBlurb({
          filePath: file.file_path,
          sourceText: limitedSourceText,
        })
      : `Scaffold blurb for ${file.file_path.split('/').pop() ?? file.file_path}.`;
    blurbs[file.file_path] = blurb;

    upsertFileRecord(input.db, toFileUpsertInput(file, {
      blurb,
      extraction_model: input.provider?.kind ?? 'scaffold',
      last_extracted: new Date().toISOString(),
    }));
  }

  return { blurbs };
}
