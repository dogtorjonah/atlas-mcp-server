import path from 'node:path';
import type { AtlasProviderName, AtlasServerConfig } from './types.js';

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

function normalizeProvider(value: string | undefined): AtlasProviderName {
  if (value === 'anthropic' || value === 'ollama' || value === 'gemini') {
    return value;
  }
  return 'openai';
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

  return {
    workspace,
    sourceRoot,
    dbPath,
    provider,
    openAiApiKey: readEnv('OPENAI_API_KEY') ?? '',
    anthropicApiKey: readEnv('ANTHROPIC_API_KEY') ?? '',
    geminiApiKey: readEnv('GEMINI_API_KEY') ?? '',
    voyageApiKey: readEnv('VOYAGE_API_KEY') ?? '',
    ollamaBaseUrl: readArgValue(argv, '--ollama-base-url') ?? readEnv('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434',
    sqliteVecExtension: readArgValue(argv, '--sqlite-vec-extension') ?? readEnv('ATLAS_SQLITE_VEC_EXTENSION') ?? '',
  };
}
