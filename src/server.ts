import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openAtlasDatabase } from './db.js';
import { loadAtlasConfig } from './config.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createOllamaProvider } from './providers/ollama.js';
import { runFullPipeline } from './pipeline/index.js';
import { registerFlushTool } from './tools/flush.js';
import { registerLookupTool } from './tools/lookup.js';
import { registerReindexTool } from './tools/reindex.js';
import { registerSearchTool } from './tools/search.js';
import { ATLAS_CONTEXT_RESOURCE_URI, generateContextResource } from './resources/context.js';
import type { AtlasRuntime } from './types.js';

function createProvider(runtime: AtlasRuntime) {
  switch (runtime.config.provider) {
    case 'anthropic':
      return createAnthropicProvider(runtime.config);
    case 'ollama':
      return createOllamaProvider(runtime.config);
    default:
      return createOpenAIProvider(runtime.config);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const isInit = argv[0] === 'init';
  const targetRoot = isInit ? path.resolve(argv[1] ?? process.cwd()) : process.cwd();
  const configArgs = isInit ? argv.slice(2) : argv;
  const config = loadAtlasConfig(configArgs, {
    sourceRoot: targetRoot,
    dbPath: path.join(targetRoot, '.atlas', 'atlas.sqlite'),
    workspace: path.basename(targetRoot).toLowerCase(),
  });

  if (isInit) {
    await runFullPipeline(targetRoot, {
      ...config,
      sourceRoot: targetRoot,
      dbPath: config.dbPath,
      migrationDir: fileURLToPath(new URL('../migrations/', import.meta.url)),
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
