import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openAtlasDatabase } from './db.js';
import { getAtlasDefaultModel, loadAtlasConfig, writeAtlasEnvFile } from './config.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createOllamaProvider } from './providers/ollama.js';
import { runFullPipeline } from './pipeline/index.js';
import { startAtlasWatcher } from './watcher.js';
import { registerChangelogTools } from './tools/changelog.js';
import { registerCommitTool } from './tools/commit.js';
// Composite tools (21 → 5 consolidation — individual tools removed)
import { registerQueryTool } from './tools/query.js';
import { registerGraphCompositeTool } from './tools/graphComposite.js';
import { registerAuditTool } from './tools/audit.js';
import { registerAdminTool } from './tools/admin.js';
import { ATLAS_CONTEXT_RESOURCE_URI, generateContextResource } from './resources/context.js';
import type { AtlasRuntime, AtlasServerConfig } from './types.js';

function createProvider(runtime: AtlasRuntime) {
  switch (runtime.config.provider) {
    case 'anthropic':
      if (!runtime.config.anthropicApiKey) return undefined;
      return createAnthropicProvider(runtime.config);
    case 'ollama':
      return createOllamaProvider(runtime.config);
    case 'gemini':
      if (!runtime.config.geminiApiKey) return undefined;
      return createGeminiProvider(runtime.config);
    default:
      if (!runtime.config.openAiApiKey) return undefined;
      return createOpenAIProvider(runtime.config);
  }
}

function parseInitArgs(argv: string[]): {
  targetRoot: string;
  configArgs: string[];
  skipCostConfirmation: boolean;
  useWizard: boolean;
  force: boolean;
  phase?: 'pass2';
  files: string[];
} {
  const configArgs: string[] = [];
  const files: string[] = [];
  let skipCostConfirmation = false;
  let force = false;
  let wizardRequested = false;
  let phase: 'pass2' | undefined;
  let targetRoot = process.cwd();
  let targetAssigned = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === '--yes') {
      skipCostConfirmation = true;
      continue;
    }
    if (arg === '--wizard') {
      wizardRequested = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--phase') {
      const value = argv[index + 1];
      if (value === 'pass2') {
        phase = 'pass2';
      }
      if (value) {
        index += 1;
      }
      continue;
    }
    if (arg === '--file') {
      const value = argv[index + 1];
      if (value) {
        files.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      configArgs.push(arg);
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        configArgs.push(value);
        index += 1;
      }
      continue;
    }
    if (!targetAssigned) {
      targetRoot = path.resolve(arg);
      targetAssigned = true;
      continue;
    }
    configArgs.push(arg);
  }

  const useWizard = wizardRequested || (!skipCostConfirmation && argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY);
  return {
    targetRoot,
    configArgs,
    skipCostConfirmation,
    useWizard,
    force,
    phase,
    files,
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
    const sourceRootAnswer = await rl.question(`[atlas-init] Codebase path [${config.sourceRoot}]: `);
    const sourceRoot = path.resolve(sourceRootAnswer.trim() || config.sourceRoot);
    const workspaceDefault = path.basename(sourceRoot).toLowerCase();
    const workspaceAnswer = await rl.question(`[atlas-init] Workspace name [${workspaceDefault}]: `);
    const workspace = workspaceAnswer.trim() || workspaceDefault;
    const providerAnswer = await rl.question(`[atlas-init] Provider [1=openai, 2=anthropic, 3=gemini, 4=ollama] [${config.provider}]: `);
    const provider = providerAnswer.trim() ? readInitProviderChoice(providerAnswer, config.provider) : config.provider;
    const modelDefault = config.model || getAtlasDefaultModel(provider);
    const modelAnswer = await rl.question(`[atlas-init] Model [${modelDefault}]: `);
    const model = modelAnswer.trim() || modelDefault;
    const concurrencyAnswer = await rl.question(`[atlas-init] Concurrency [${config.concurrency}]: `);
    const parsedConcurrency = Number.parseInt(concurrencyAnswer.trim(), 10);
    const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : config.concurrency;

    const openAiApiKey = provider === 'openai'
      ? (config.openAiApiKey || (await rl.question('[atlas-init] OpenAI API key (blank for scaffold): ')).trim())
      : config.openAiApiKey;
    const anthropicApiKey = provider === 'anthropic'
      ? (config.anthropicApiKey || (await rl.question('[atlas-init] Anthropic API key (blank for scaffold): ')).trim())
      : config.anthropicApiKey;
    const geminiApiKey = provider === 'gemini'
      ? (config.geminiApiKey || (await rl.question('[atlas-init] Gemini API key (blank for scaffold): ')).trim())
      : config.geminiApiKey;
    const ollamaBaseUrl = provider === 'ollama'
      ? (await rl.question(`[atlas-init] Ollama base URL [${config.ollamaBaseUrl}]: `)).trim() || config.ollamaBaseUrl
      : config.ollamaBaseUrl;

    return {
      ...config,
      sourceRoot,
      workspace,
      dbPath: path.join(sourceRoot, '.atlas', 'atlas.sqlite'),
      provider,
      model,
      concurrency,
      openAiApiKey,
      anthropicApiKey,
      geminiApiKey,
      ollamaBaseUrl,
    };
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const isInit = argv[0] === 'init';
  const initArgs = isInit ? parseInitArgs(argv.slice(1)) : null;
  let targetRoot = isInit ? initArgs?.targetRoot ?? process.cwd() : process.cwd();
  const configArgs = isInit ? initArgs?.configArgs ?? [] : argv;
  const config = loadAtlasConfig(configArgs, {
    sourceRoot: targetRoot,
    dbPath: path.join(targetRoot, '.atlas', 'atlas.sqlite'),
    workspace: path.basename(targetRoot).toLowerCase(),
  });

  if (isInit) {
    const initConfig = initArgs?.useWizard ? await promptInitWizard(config) : config;
    targetRoot = initConfig.sourceRoot;
    if (initArgs?.force) {
      console.log('[atlas-init] --force supplied; database will be deleted and rebuilt from scratch');
    }
    writeAtlasEnvFile(path.join(targetRoot, '.atlas', '.env'), {
      ATLAS_PROVIDER: initConfig.provider,
      ATLAS_MODEL: initConfig.model,
      OPENAI_API_KEY: initConfig.openAiApiKey,
      ANTHROPIC_API_KEY: initConfig.anthropicApiKey,
      GEMINI_API_KEY: initConfig.geminiApiKey,
      VOYAGE_API_KEY: initConfig.voyageApiKey,
      OLLAMA_BASE_URL: initConfig.ollamaBaseUrl,
    });

    console.log('[atlas-init] starting init pipeline');
    await runFullPipeline(targetRoot, {
      ...initConfig,
      sourceRoot: targetRoot,
      dbPath: initConfig.dbPath,
      model: initConfig.model,
      concurrency: initConfig.concurrency,
      migrationDir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      skipCostConfirmation: initArgs?.skipCostConfirmation ?? false,
      force: initArgs?.force ?? false,
      phase: initArgs?.phase,
      files: initArgs?.files,
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

  // ── Standalone tools (not in any composite) ──
  registerChangelogTools(server, runtime);
  registerCommitTool(server, runtime);

  // ── Composite tools (21 → 5 consolidation) ──
  // atlas_query:  search, lookup, brief, snippet, similar, plan_context, cluster, patterns, history
  // atlas_graph:  impact, neighbors, trace, cycles, reachability, graph
  // atlas_audit:  gaps, smells, hotspots
  // atlas_admin:  reindex, bridge_list
  registerQueryTool(server, runtime);
  registerGraphCompositeTool(server, runtime);
  registerAuditTool(server, runtime);
  registerAdminTool(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const stopWatcher = startAtlasWatcher(runtime);
  const shutdown = (): void => {
    stopWatcher();
    try {
      db.close();
    } catch {
      // ignore close-on-shutdown races
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('close', shutdown);
}

const entrypoint = process.argv[1];

if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
