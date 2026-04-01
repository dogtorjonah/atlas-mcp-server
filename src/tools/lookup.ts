import { execSync } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { getAtlasFile } from '../db.js';
import { trackQuery } from '../queryLog.js';

function currentGitBlobHash(sourceRoot: string, filePath: string): string | null {
  try {
    return execSync(`git rev-parse HEAD:${filePath}`, {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function registerLookupTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_lookup',
    {
      filePath: z.string().min(1),
      workspace: z.string().optional(),
    },
    async ({ filePath, workspace }: { filePath: string; workspace?: string }) => {
      const row = getAtlasFile(runtime.db, workspace ?? runtime.config.workspace, filePath);
      trackQuery(filePath, row ? [row.id] : [], row ? [row.file_path] : []);
      if (!row) {
        return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
      }

      const currentHash = currentGitBlobHash(runtime.config.sourceRoot, filePath);
      const stale = currentHash && row.file_hash && currentHash !== row.file_hash ? '\n\nSTALE: file hash differs from atlas row.' : '';
      return {
        content: [{
          type: 'text',
          text: `${row.file_path}\n${row.purpose || row.blurb}${stale}`,
        }],
      };
    },
  );
}
