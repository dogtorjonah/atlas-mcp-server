import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, upsertFileRecord } from '../db.js';
import type { AtlasFileRecord, AtlasProvider } from '../types.js';
import type { ScanFileInfo } from './scan.js';
import { readSourceFile, toFileUpsertInput } from './shared.js';

export interface SummarizeResult {
  blurbs: Record<string, string>;
}

export interface SummarizeOptions {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
  provider?: AtlasProvider;
  files?: AtlasFileRecord[];
  sourceTextLimit?: number;
}

type SummarizeFileInput = ScanFileInfo | AtlasFileRecord;

export async function runSummarize(files: SummarizeFileInput[]): Promise<SummarizeResult>;
export async function runSummarize(options: SummarizeOptions): Promise<SummarizeResult>;
export async function runSummarize(
  input: SummarizeFileInput[] | SummarizeOptions,
): Promise<SummarizeResult> {
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
