#!/usr/bin/env node
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

const PROVIDER_MODELS: Record<string, Array<{ value: string; label: string; default?: boolean }>> = {
  openai: [
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (fast, cheap)', default: true },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'o4-mini', label: 'o4-mini (reasoning)' },
  ],
  anthropic: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, cheap)', default: true },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  ],
  gemini: [
    { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash (fast, cheap)', default: true },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  ollama: [
    { value: 'llama3.2', label: 'Llama 3.2 (default)', default: true },
    { value: 'codellama', label: 'Code Llama' },
    { value: 'mistral', label: 'Mistral' },
  ],
};

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
    console.log('╔══════════════════════════════════════╗');
    console.log('║       Atlas — Setup Wizard           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    // 1. Codebase path
    const sourceRootAnswer = await rl.question(`  Codebase path [${config.sourceRoot}]: `);
    const sourceRoot = path.resolve(sourceRootAnswer.trim() || config.sourceRoot);

    // 2. Workspace name
    const workspaceDefault = path.basename(sourceRoot).toLowerCase();
    const workspaceAnswer = await rl.question(`  Workspace name [${workspaceDefault}]: `);
    const workspace = workspaceAnswer.trim() || workspaceDefault;

    // 3. Provider
    console.log('');
    console.log('  AI Provider (for blurbs + deep extraction):');
    console.log('    1) OpenAI       — gpt-5.4-mini');
    console.log('    2) Anthropic    — claude-haiku-4-5');
    console.log('    3) Gemini       — gemini-3.1-flash');
    console.log('    4) Ollama       — llama3.2 (local)');
    console.log('    5) None         — deterministic only (no API key needed)');
    console.log('');
    const providerAnswer = await rl.question(`  Choose provider [1-5] (default: ${config.provider}): `);
    let provider = config.provider;
    if (providerAnswer.trim() === '5' || providerAnswer.trim().toLowerCase() === 'none') {
      provider = 'openai'; // use openai as placeholder, but no key = scaffold mode
    } else if (providerAnswer.trim()) {
      provider = readInitProviderChoice(providerAnswer, config.provider);
    }
    const isNoneProvider = providerAnswer.trim() === '5' || providerAnswer.trim().toLowerCase() === 'none';

    // 4. Model selection
    let model = getAtlasDefaultModel(provider);
    if (!isNoneProvider) {
      const models = PROVIDER_MODELS[provider] ?? [];
      if (models.length > 0) {
        console.log('');
        console.log(`  Available ${provider} models:`);
        models.forEach((m, i) => {
          const marker = m.default ? ' (default)' : '';
          console.log(`    ${i + 1}) ${m.value} — ${m.label}${marker}`);
        });
        console.log('');
        const modelAnswer = await rl.question(`  Choose model [1-${models.length}] (default: 1): `);
        const modelIndex = Number.parseInt(modelAnswer.trim(), 10) - 1;
        if (modelIndex >= 0 && modelIndex < models.length) {
          model = models[modelIndex]!.value;
        } else if (modelAnswer.trim()) {
          // Allow typing a custom model string
          model = modelAnswer.trim();
        }
      }
    }

    // 5. Concurrency
    const concurrencyAnswer = await rl.question(`  Concurrency [${config.concurrency}]: `);
    const parsedConcurrency = Number.parseInt(concurrencyAnswer.trim(), 10);
    const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : config.concurrency;

    // 6. API key (only for the chosen provider)
    let openAiApiKey = config.openAiApiKey;
    let anthropicApiKey = config.anthropicApiKey;
    let geminiApiKey = config.geminiApiKey;
    let ollamaBaseUrl = config.ollamaBaseUrl;

    if (!isNoneProvider) {
      console.log('');
      if (provider === 'openai' && !config.openAiApiKey) {
        openAiApiKey = (await rl.question('  OpenAI API key (starts with sk-proj-...): ')).trim();
      }
      if (provider === 'anthropic' && !config.anthropicApiKey) {
        anthropicApiKey = (await rl.question('  Anthropic API key (starts with sk-ant-...): ')).trim();
      }
      if (provider === 'gemini' && !config.geminiApiKey) {
        geminiApiKey = (await rl.question('  Gemini API key: ')).trim();
      }
      if (provider === 'ollama') {
        const urlAnswer = await rl.question(`  Ollama base URL [${config.ollamaBaseUrl}]: `);
        ollamaBaseUrl = urlAnswer.trim() || config.ollamaBaseUrl;
      }
    }

    // Summary
    console.log('');
    console.log('  ─────────────────────────────────────');
    console.log(`  Codebase:    ${sourceRoot}`);
    console.log(`  Workspace:   ${workspace}`);
    console.log(`  Provider:    ${isNoneProvider ? 'none (deterministic only)' : provider}`);
    if (!isNoneProvider) console.log(`  Model:       ${model}`);
    console.log(`  Concurrency: ${concurrency}`);
    console.log('  ─────────────────────────────────────');
    console.log('');

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
  // atlas_graph:  impact, neighbors, trace, cycles, reachability, graph, cluster
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
