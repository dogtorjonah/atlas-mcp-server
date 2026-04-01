import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openAtlasDatabase } from './db.js';
import { loadAtlasConfig } from './config.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createOllamaProvider } from './providers/ollama.js';
import { runFullPipeline } from './pipeline/index.js';
import { registerFlushTool } from './tools/flush.js';
import { registerLookupTool } from './tools/lookup.js';
import { registerReindexTool } from './tools/reindex.js';
import { registerSearchTool } from './tools/search.js';
import { ATLAS_CONTEXT_RESOURCE_URI, generateContextResource } from './resources/context.js';
import type { AtlasRuntime, AtlasServerConfig } from './types.js';

function createProvider(runtime: AtlasRuntime) {
  switch (runtime.config.provider) {
    case 'anthropic':
      return createAnthropicProvider(runtime.config);
    case 'ollama':
      return createOllamaProvider(runtime.config);
    case 'gemini':
      return createGeminiProvider(runtime.config);
    default:
      return createOpenAIProvider(runtime.config);
  }
}

function parseInitArgs(argv: string[]): { targetRoot: string; configArgs: string[]; skipCostConfirmation: boolean } {
  const filtered = argv.filter((arg) => arg !== '--yes');
  const targetIndex = filtered.findIndex((arg) => !arg.startsWith('--'));

  if (targetIndex < 0) {
    return {
      targetRoot: process.cwd(),
      configArgs: filtered,
      skipCostConfirmation: argv.includes('--yes'),
    };
  }

  const targetArg = filtered[targetIndex];
  if (!targetArg) {
    return {
      targetRoot: process.cwd(),
      configArgs: filtered,
      skipCostConfirmation: argv.includes('--yes'),
    };
  }

  return {
    targetRoot: path.resolve(targetArg!),
    configArgs: filtered.filter((_, index) => index !== targetIndex),
    skipCostConfirmation: argv.includes('--yes'),
  };
}

function readInitProviderChoice(answer: string, fallback: AtlasServerConfig['provider']): AtlasServerConfig['provider'] {
  const normalized = answer.trim().toLowerCase();
  switch (normalized) {
    case '1':
    case 'openai':
      return 'openai';
    case '2':
    case 'anthropic':
      return 'anthropic';
    case '3':
    case 'gemini':
      return 'gemini';
    case '4':
    case 'ollama':
      return 'ollama';
    default:
      return fallback;
  }
}

async function promptInitWizard(config: AtlasServerConfig): Promise<AtlasServerConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return config;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('[atlas-init] setup wizard');
    console.log(`[atlas-init] workspace: ${config.workspace}`);
    console.log(`[atlas-init] source root: ${config.sourceRoot}`);
    console.log('[atlas-init] detected settings:');
    console.log(`  provider=${config.provider}`);
    console.log(`  openai key=${config.openAiApiKey ? 'yes' : 'no'}`);
    console.log(`  anthropic key=${config.anthropicApiKey ? 'yes' : 'no'}`);
    console.log(`  gemini key=${config.geminiApiKey ? 'yes' : 'no'}`);
    console.log(`  ollama base url=${config.ollamaBaseUrl}`);
    console.log(`  concurrency=${config.concurrency}`);

    const useDefaults = (await rl.question('[atlas-init] Use detected settings? [Y/n] ')).trim().toLowerCase();
    if (useDefaults === 'n' || useDefaults === 'no') {
      const providerAnswer = await rl.question('[atlas-init] Provider [1=openai, 2=anthropic, 3=gemini, 4=ollama] (default current): ');
      const concurrencyAnswer = await rl.question(`[atlas-init] Concurrency [${config.concurrency}]: `);
      const parsedConcurrency = Number.parseInt(concurrencyAnswer.trim(), 10);

      return {
        ...config,
        provider: readInitProviderChoice(providerAnswer, config.provider),
        concurrency: Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : config.concurrency,
      };
    }

    return config;
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const isInit = argv[0] === 'init';
  const initArgs = isInit ? parseInitArgs(argv.slice(1)) : null;
  const targetRoot = isInit ? initArgs?.targetRoot ?? process.cwd() : process.cwd();
  const configArgs = isInit ? initArgs?.configArgs ?? [] : argv;
  const config = loadAtlasConfig(configArgs, {
    sourceRoot: targetRoot,
    dbPath: path.join(targetRoot, '.atlas', 'atlas.sqlite'),
    workspace: path.basename(targetRoot).toLowerCase(),
  });

  if (isInit) {
    const initConfig = initArgs?.skipCostConfirmation
      ? config
      : await promptInitWizard(config);

    console.log('[atlas-init] starting init pipeline');
    await runFullPipeline(targetRoot, {
      ...initConfig,
      sourceRoot: targetRoot,
      dbPath: initConfig.dbPath,
      concurrency: initConfig.concurrency,
      migrationDir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      skipCostConfirmation: initArgs?.skipCostConfirmation ?? false,
    });
    return;
  }

  const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const db = openAtlasDatabase({
    dbPath: config.dbPath,
    migrationDir,
    sqliteVecExtension: config.sqliteVecExtension,
  });

  const runtime: AtlasRuntime = { config, db };
  runtime.provider = createProvider(runtime);

  const server = new McpServer({
    name: '@voxxo/atlas',
    version: '0.1.0',
  });
  runtime.server = server;

  server.resource(
    'Atlas Codebase Context',
    ATLAS_CONTEXT_RESOURCE_URI,
    {
      description: 'Auto-updated codebase context. Subscribe for automatic injection of relevant file knowledge on every change.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{
        uri: ATLAS_CONTEXT_RESOURCE_URI,
        mimeType: 'text/markdown',
        text: generateContextResource(db, runtime.config.workspace),
      }],
    }),
  );

  registerSearchTool(server, runtime);
  registerLookupTool(server, runtime);
  registerFlushTool(server, runtime);
  registerReindexTool(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stdin.on('close', () => {
    db.close();
  });
}

const entrypoint = process.argv[1];

if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
