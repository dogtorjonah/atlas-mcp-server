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
  const workspace = readArgValue(argv, '--workspace') ?? readEnv('ATLAS_WORKSPACE') ?? defaults.workspace ?? path.basename(sourceRoot).toLowerCase();
  const dbPath = readArgValue(argv, '--db') ?? readEnv('ATLAS_DB_PATH') ?? defaults.dbPath ?? path.join(cwd, '.atlas', 'atlas.sqlite');
  const provider = normalizeProvider(readArgValue(argv, '--provider') ?? readEnv('ATLAS_PROVIDER'));
  const model = readArgValue(argv, '--model') ?? readEnv('ATLAS_MODEL') ?? defaults.model ?? '';
  const concurrency = readInt(readArgValue(argv, '--concurrency') ?? readEnv('ATLAS_CONCURRENCY'), 10);

  return {
    workspace,
    sourceRoot,
    dbPath,
    provider,
    model,
    openAiApiKey: readEnv('OPENAI_API_KEY') ?? '',
    anthropicApiKey: readEnv('ANTHROPIC_API_KEY') ?? '',
    geminiApiKey: readEnv('GEMINI_API_KEY') ?? '',
    voyageApiKey: readEnv('VOYAGE_API_KEY') ?? '',
    ollamaBaseUrl: readArgValue(argv, '--ollama-base-url') ?? readEnv('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434',
    concurrency,
    sqliteVecExtension: readArgValue(argv, '--sqlite-vec-extension') ?? readEnv('ATLAS_SQLITE_VEC_EXTENSION') ?? '',
  };
}
