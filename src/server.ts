#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type {
  AtlasAdminRequest,
  AtlasAuditRequest,
  AtlasCommitRequest,
  AtlasGraphRequest,
  AtlasQueryRequest,
  AtlasResult,
} from './core/types.js';
import { watchAtlasRepository } from './indexing/index.js';
import { createAtlasMcpServer } from './mcp/index.js';
import {
  initializeAtlasNodeLayout,
  openAtlasNodeHost,
  resolveAtlasNodeLayout,
  type AtlasDataMode,
  type OpenAtlasNodeHostOptions,
} from './node/index.js';

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
}

const GLOBAL_FLAGS = new Set([
  'source-root', 'workspace', 'config', 'format', 'db', 'data-mode', 'transport',
  'request', 'debounce-ms', 'no-index', 'full', 'no-backup', 'protected',
  'include-optional', 'include-unavailable', 'dry-run',
]);

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) {
      if (token) positionals.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    const inline = equal < 0 ? undefined : token.slice(equal + 1);
    const next = argv[index + 1];
    const value: string | boolean = inline ?? (next && !next.startsWith('--') ? next : true);
    if (inline == null && value === next) index += 1;
    const previous = flags.get(name);
    flags.set(name, previous == null ? value : Array.isArray(previous) ? [...previous, String(value)] : [String(previous), String(value)]);
  }
  return { positionals, flags };
}

function one(flags: ParsedArguments['flags'], name: string): string | undefined {
  const value = flags.get(name);
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

function present(flags: ParsedArguments['flags'], name: string): boolean {
  return flags.has(name);
}

function scalar(value: string | boolean | string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => scalar(entry));
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function camelKey(value: string): string {
  return value.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

async function stdinText(): Promise<string> {
  let result = '';
  for await (const chunk of process.stdin) result += String(chunk);
  return result;
}

async function explicitRequest(parsed: ParsedArguments): Promise<Record<string, unknown> | null> {
  const reference = one(parsed.flags, 'request');
  if (!reference) return null;
  const text = reference === '-' ? await stdinText()
    : reference.startsWith('@') ? await readFile(path.resolve(reference.slice(1)), 'utf8')
      : reference;
  const request = JSON.parse(text) as unknown;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('--request must resolve to a JSON object.');
  }
  const domainFlags = [...parsed.flags.keys()].filter((key) => !GLOBAL_FLAGS.has(key));
  if (domainFlags.length > 0) throw new Error('--request cannot be combined with domain request flags.');
  return request as Record<string, unknown>;
}

async function domainRequest(
  parsed: ParsedArguments,
  base: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const explicit = await explicitRequest(parsed);
  if (explicit) return { ...base, ...explicit };
  const request: Record<string, unknown> = { ...base };
  for (const [key, value] of parsed.flags) {
    if (GLOBAL_FLAGS.has(key)) continue;
    request[camelKey(key)] = scalar(value);
  }
  return request;
}

function nodeOptions(parsed: ParsedArguments, fallbackRoot = process.cwd()): OpenAtlasNodeHostOptions {
  const dataMode = one(parsed.flags, 'data-mode');
  if (dataMode && dataMode !== 'project' && dataMode !== 'user') throw new Error('--data-mode must be project or user.');
  return {
    sourceRoot: path.resolve(one(parsed.flags, 'source-root') ?? fallbackRoot),
    ...(one(parsed.flags, 'workspace') ? { workspace: one(parsed.flags, 'workspace') } : {}),
    ...(one(parsed.flags, 'db') ? { dbPath: one(parsed.flags, 'db') } : {}),
    ...(dataMode ? { dataMode: dataMode as AtlasDataMode } : {}),
  };
}

function render(result: unknown, format: string | undefined): void {
  process.stdout.write(`${format === 'json' ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`);
}

function resultExitCode(result: AtlasResult<unknown>): number {
  if (result.ok) return 0;
  if (result.error.code === 'ATLAS_INVALID_REQUEST' || result.error.code === 'ATLAS_UNSUPPORTED_ACTION') return 2;
  if (result.error.code === 'ATLAS_NOT_FOUND' || result.error.code === 'ATLAS_WORKSPACE_NOT_FOUND') return 3;
  if (['ATLAS_CAPABILITY_UNAVAILABLE', 'ATLAS_PERMISSION_DENIED', 'ATLAS_BUSY', 'ATLAS_STORE_LOCKED', 'ATLAS_DEADLINE_EXCEEDED', 'ATLAS_CANCELLED'].includes(result.error.code)) return 4;
  return 5;
}

async function runMcp(parsed: ParsedArguments): Promise<void> {
  const transport = one(parsed.flags, 'transport');
  if (transport && transport !== 'stdio') throw new Error('Only --transport stdio is supported.');
  const host = await openAtlasNodeHost(nodeOptions(parsed));
  const server = createAtlasMcpServer(host.service, { workspace: host.layout.workspace, version: '1.0.0' });
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void server.server.close().catch(() => undefined)
        .then(() => host.close().catch(() => undefined))
        .then(resolve);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.once('close', close);
  });
}

async function runWatch(parsed: ParsedArguments): Promise<void> {
  const host = await openAtlasNodeHost(nodeOptions(parsed));
  const debounceMs = Number(one(parsed.flags, 'debounce-ms') ?? 250);
  if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error('--debounce-ms must be a finite non-negative number.');
  const selected = parsed.positionals.slice(1);
  const watcher = await watchAtlasRepository({
    sourceRoot: host.layout.sourceRoot,
    debounceMs,
    onBatch: async (changes) => {
      const paths = changes.map((change) => change.filePath)
        .filter((filePath) => selected.length === 0 || selected.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`)));
      if (paths.length === 0) return;
      const result = await host.service.admin({ action: 'index', paths });
      if (!result.ok) process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    },
  });
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      void watcher.close().catch(() => undefined).then(() => host.close()).then(resolve);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function runServiceCommand(parsed: ParsedArguments): Promise<number> {
  const command = parsed.positionals[0];
  const host = await openAtlasNodeHost(nodeOptions(parsed));
  try {
    let result: AtlasResult<unknown>;
    if (command === 'query') {
      result = await host.service.query(await domainRequest(parsed, { action: parsed.positionals[1] }) as unknown as AtlasQueryRequest);
    } else if (command === 'graph') {
      result = await host.service.graph(await domainRequest(parsed, { action: parsed.positionals[1] }) as unknown as AtlasGraphRequest);
    } else if (command === 'audit') {
      result = await host.service.audit(await domainRequest(parsed, { action: parsed.positionals[1] }) as unknown as AtlasAuditRequest);
    } else if (command === 'commit') {
      const request = await explicitRequest(parsed);
      if (!request) throw new Error('atlas commit requires --request <json|@file|->.');
      result = await host.service.commit(request as unknown as AtlasCommitRequest);
    } else if (command === 'diff' || command === 'snapshot') {
      result = await host.service.query(await domainRequest(parsed, { action: command }) as unknown as AtlasQueryRequest);
    } else {
      const action = command === 'index' ? 'index'
        : command === 'migrate' ? 'migrate'
          : command === 'backup' ? 'backup'
            : command === 'doctor' ? 'doctor'
              : parsed.positionals[0] === 'workspace' && parsed.positionals[1] === 'list' ? 'workspace_list'
                : null;
      if (!action) throw new Error(`Unknown Atlas command: ${parsed.positionals.join(' ')}`);
      const base: Record<string, unknown> = { action };
      if (action === 'index') {
        const paths = parsed.positionals.slice(1);
        if (paths.length > 0) base.paths = paths;
        if (present(parsed.flags, 'full')) base.full = true;
      }
      if (action === 'migrate') {
        if (present(parsed.flags, 'dry-run')) base.dryRun = true;
        if (present(parsed.flags, 'no-backup')) base.backup = false;
      }
      if (action === 'backup' && present(parsed.flags, 'protected')) base.protected = true;
      if (action === 'doctor' && present(parsed.flags, 'include-optional')) base.includeOptional = true;
      if (action === 'workspace_list' && present(parsed.flags, 'include-unavailable')) base.includeUnavailable = true;
      result = await host.service.admin(await domainRequest(parsed, base) as unknown as AtlasAdminRequest);
    }
    render(result, one(parsed.flags, 'format'));
    return resultExitCode(result);
  } finally {
    await host.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  let command = parsed.positionals[0];
  if (!command) {
    process.stderr.write('atlas without a command is deprecated; use `atlas mcp`.\n');
    command = 'mcp';
    parsed.positionals.unshift(command);
  }
  if (command === 'mcp') return runMcp(parsed);
  if (command === 'watch') return runWatch(parsed);
  if (command === 'init') {
    const repository = parsed.positionals[1] ?? process.cwd();
    const options = nodeOptions(parsed, repository);
    const layout = await initializeAtlasNodeLayout(options);
    let index: AtlasResult<unknown> | undefined;
    if (!present(parsed.flags, 'no-index')) {
      const host = await openAtlasNodeHost(options);
      try {
        index = await host.service.admin({ action: 'index', full: true });
      } finally {
        await host.close();
      }
    }
    render({ layout, ...(index ? { index } : {}) }, one(parsed.flags, 'format'));
    if (index && !index.ok) process.exitCode = resultExitCode(index);
    return;
  }
  if (command === 'config' && parsed.positionals[1] === 'show') {
    const layout = await resolveAtlasNodeLayout(nodeOptions(parsed));
    render({ sourceRoot: layout.sourceRoot, workspace: layout.workspace, dataMode: layout.dataMode, dbPath: layout.dbPath }, one(parsed.flags, 'format'));
    return;
  }
  if (command === 'worktree') {
    render({ protocol_version: '1', ok: false, error: { code: 'ATLAS_CAPABILITY_UNAVAILABLE', message: 'Worktree commands require an optional repository lifecycle adapter.', retryable: false } }, one(parsed.flags, 'format'));
    process.exitCode = 4;
    return;
  }
  process.exitCode = await runServiceCommand(parsed);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
