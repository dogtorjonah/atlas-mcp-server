import fs from 'node:fs/promises';
import path from 'node:path';
import type { AtlasFileRecord } from '../types.js';
import type { AtlasFileUpsertInput } from '../db.js';

export async function readSourceFile(sourceRoot: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
  } catch {
    return null;
  }
}

export function toFileUpsertInput(
  file: AtlasFileRecord,
  patch: Partial<AtlasFileUpsertInput>,
): AtlasFileUpsertInput {
  return {
    workspace: file.workspace,
    file_path: file.file_path,
    file_hash: patch.file_hash ?? file.file_hash,
    cluster: patch.cluster ?? file.cluster,
    loc: patch.loc ?? file.loc,
    blurb: patch.blurb ?? file.blurb,
    purpose: patch.purpose ?? file.purpose,
    public_api: patch.public_api ?? file.public_api,
    exports: patch.exports ?? file.exports,
    patterns: patch.patterns ?? file.patterns,
    dependencies: patch.dependencies ?? file.dependencies,
    data_flows: patch.data_flows ?? file.data_flows,
    key_types: patch.key_types ?? file.key_types,
    hazards: patch.hazards ?? file.hazards,
    conventions: patch.conventions ?? file.conventions,
    cross_refs: patch.cross_refs ?? file.cross_refs,
    language: patch.language ?? file.language,
    extraction_model: patch.extraction_model ?? file.extraction_model,
    last_extracted: patch.last_extracted ?? file.last_extracted,
  };
}

export function buildEmbeddingInput(file: AtlasFileRecord): string {
  return [
    file.purpose,
    file.blurb,
    file.patterns.join(', '),
    file.hazards.join(', '),
  ].filter((part) => part.trim().length > 0).join('\n');
}
