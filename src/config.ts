import fs from 'node:fs';
import path from 'node:path';
import type { AtlasServerConfig } from './types.js';

const DEFAULT_EMBEDDING_MODEL = 'onnx-community/bge-small-en-v1.5-ONNX';
const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export interface AtlasConfigDefaults {
  sourceRoot?: string;
  dbPath?: string;
  workspace?: string;
}

function readArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readAtlasEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1).replaceAll('\\n', '\n').replaceAll('\\"', '"').replaceAll("\\'", '\'');
    }

    result[key] = value;
  }

  return result;
}

function normalizeEnvValue(value: string | undefined): string {
  return value && value.trim() !== '' ? value.trim() : '';
}

export function writeAtlasEnvFile(filePath: string, values: Record<string, string | undefined | null>): void {
  const existing = readAtlasEnvFile(filePath);
  const merged: Record<string, string> = {
    ...existing,
  };

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      merged[key] = value;
    } else if (value == null) {
      merged[key] = '';
    }
  }

  const keys = Object.keys(merged).sort((left, right) => left.localeCompare(right));
  const content = keys.map((key) => `${key}=${JSON.stringify(merged[key] ?? '')}`).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

export function loadAtlasConfig(
  argv = process.argv.slice(2),
  defaults: AtlasConfigDefaults = {},
): AtlasServerConfig {
  const cwd = process.cwd();
  const sourceRoot = readArgValue(argv, '--source-root') ?? readEnv('ATLAS_SOURCE_ROOT') ?? defaults.sourceRoot ?? cwd;
  const atlasEnv = readAtlasEnvFile(path.join(sourceRoot, '.atlas', '.env'));
  const workspace = readArgValue(argv, '--workspace') ?? readEnv('ATLAS_WORKSPACE') ?? defaults.workspace ?? path.basename(sourceRoot).toLowerCase();
  const dbPath = readArgValue(argv, '--db') ?? readEnv('ATLAS_DB_PATH') ?? defaults.dbPath ?? path.join(cwd, '.atlas', 'atlas.sqlite');
  const concurrency = readInt(readArgValue(argv, '--concurrency') ?? readEnv('ATLAS_CONCURRENCY'), 10);
  const embeddingModel = readArgValue(argv, '--embedding-model')
    ?? readEnv('ATLAS_EMBEDDING_MODEL')
    ?? atlasEnv.ATLAS_EMBEDDING_MODEL
    ?? DEFAULT_EMBEDDING_MODEL;
  const embeddingDimensions = readInt(
    readArgValue(argv, '--embedding-dimensions')
      ?? readEnv('ATLAS_EMBEDDING_DIMENSIONS')
      ?? atlasEnv.ATLAS_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_DIMENSIONS,
  );

  return {
    workspace,
    sourceRoot,
    dbPath,
    concurrency,
    sqliteVecExtension: readArgValue(argv, '--sqlite-vec-extension') ?? readEnv('ATLAS_SQLITE_VEC_EXTENSION') ?? '',
    embeddingModel,
    embeddingDimensions,
  };
}
