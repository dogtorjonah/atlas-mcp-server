import fs from 'node:fs';
import path from 'node:path';
import type { AtlasProviderName, AtlasServerConfig } from './types.js';

export interface AtlasConfigDefaults {
  sourceRoot?: string;
  dbPath?: string;
  workspace?: string;
  model?: string;
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

function normalizeProvider(value: string | undefined): AtlasProviderName {
  if (value === 'anthropic' || value === 'ollama' || value === 'gemini') {
    return value;
  }
  return 'openai';
}

export function getAtlasDefaultModel(provider: AtlasProviderName): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-haiku-4-5-20251001';
    case 'gemini':
      return 'gemini-3.1-flash';
    case 'ollama':
      return process.env.ATLAS_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL ?? 'llama3.2';
    case 'openai':
    default:
      return 'gpt-5.4-mini';
  }
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
  const provider = normalizeProvider(
    readArgValue(argv, '--provider')
      ?? readEnv('ATLAS_PROVIDER')
      ?? normalizeEnvValue(atlasEnv.ATLAS_PROVIDER),
  );
  const model = readArgValue(argv, '--model')
    ?? readEnv('ATLAS_MODEL')
    ?? normalizeEnvValue(atlasEnv.ATLAS_MODEL)
    ?? defaults.model
    ?? '';
  const concurrency = readInt(readArgValue(argv, '--concurrency') ?? readEnv('ATLAS_CONCURRENCY'), 10);
  const ollamaBaseUrl = readArgValue(argv, '--ollama-base-url') ?? readEnv('OLLAMA_BASE_URL') ?? normalizeEnvValue(atlasEnv.OLLAMA_BASE_URL);

  return {
    workspace,
    sourceRoot,
    dbPath,
    provider,
    model,
    openAiApiKey: readEnv('OPENAI_API_KEY') ?? normalizeEnvValue(atlasEnv.OPENAI_API_KEY),
    anthropicApiKey: readEnv('ANTHROPIC_API_KEY') ?? normalizeEnvValue(atlasEnv.ANTHROPIC_API_KEY),
    geminiApiKey: readEnv('GEMINI_API_KEY') ?? normalizeEnvValue(atlasEnv.GEMINI_API_KEY),
    voyageApiKey: readEnv('VOYAGE_API_KEY') ?? normalizeEnvValue(atlasEnv.VOYAGE_API_KEY),
    ollamaBaseUrl: ollamaBaseUrl || 'http://127.0.0.1:11434',
    concurrency,
    sqliteVecExtension: readArgValue(argv, '--sqlite-vec-extension') ?? readEnv('ATLAS_SQLITE_VEC_EXTENSION') ?? '',
  };
}
