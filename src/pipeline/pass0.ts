import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AtlasDatabase, AtlasImportEdgeRecord } from '../db.js';
import { replaceImportEdges, upsertFileRecord } from '../db.js';

export interface Pass0ExportEntry {
  name: string;
  type: 'function' | 'class' | 'type' | 'interface' | 'const' | 'enum' | 'default' | 'unknown';
}

export interface Pass0FileInfo {
  filePath: string;
  absolutePath: string;
  directory: string;
  cluster: string;
  loc: number;
  fileHash: string;
  imports: string[];
  exports: Pass0ExportEntry[];
}

export interface Pass0Result {
  workspace: string;
  rootDir: string;
  files: Pass0FileInfo[];
  importEdges: AtlasImportEdgeRecord[];
}

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '__tests__', 'tests', 'test',
  '.atlas', '.turbo', '.cache', 'coverage', 'build', 'out', '.vercel',
  '.svelte-kit', '.nuxt', '.output',
]);

function assignCluster(relativePath: string): string {
  if (relativePath.startsWith('src/pipeline/')) {
    return 'pipeline';
  }
  if (relativePath.startsWith('src/providers/')) {
    return 'providers';
  }
  if (relativePath.startsWith('src/tools/')) {
    return 'tools';
  }
  if (relativePath.startsWith('src/routes/')) {
    return 'routes';
  }
  if (relativePath.startsWith('src/')) {
    return 'core';
  }
  const parts = relativePath.split('/');
  return parts[0] ? `misc-${parts[0]}` : 'core';
}

async function discoverFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await discoverFiles(absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      continue;
    }

    files.push(absolutePath);
  }
  return files;
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  const regex = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath) {
      imports.add(importPath);
    }
  }
  return [...imports];
}

function extractExports(content: string): Pass0ExportEntry[] {
  const exports: Pass0ExportEntry[] = [];

  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'function' });
    }
  }
  for (const match of content.matchAll(/export\s+class\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'class' });
    }
  }
  for (const match of content.matchAll(/export\s+interface\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'interface' });
    }
  }
  for (const match of content.matchAll(/export\s+type\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'type' });
    }
  }
  for (const match of content.matchAll(/export\s+const\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'const' });
    }
  }
  for (const match of content.matchAll(/export\s+enum\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'enum' });
    }
  }
  if (/export\s+default/.test(content)) {
    exports.push({ name: 'default', type: 'default' });
  }

  return exports;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRelativeImport(filePath: string, importPath: string, projectRoot: string): Promise<string | null> {
  const fileDir = path.dirname(filePath);
  let resolved = path.resolve(fileDir, importPath);

  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ];

  if (resolved.endsWith('.js')) {
    candidates.unshift(resolved.replace(/\.js$/, '.ts'));
    candidates.unshift(resolved.replace(/\.js$/, '.tsx'));
  }

  for (const candidate of candidates) {
    if (candidate.startsWith(projectRoot) && await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export async function runPass0(
  sourceRoot: string,
  workspace: string,
  db: AtlasDatabase,
): Promise<Pass0Result> {
  const absoluteRoot = path.resolve(sourceRoot);
  const sourceFiles = await discoverFiles(absoluteRoot);
  const files: Pass0FileInfo[] = [];
  const importEdges: AtlasImportEdgeRecord[] = [];

  for (const absolutePath of sourceFiles) {
    const content = await fs.readFile(absolutePath, 'utf8');
    const relativePath = path.relative(absoluteRoot, absolutePath).replaceAll(path.sep, '/');
    const imports = extractImports(content);
    const exports = extractExports(content);
    const cluster = assignCluster(relativePath);
    const loc = content.split(/\r?\n/).length;
    const fileHash = hashContent(content);
    const resolvedImports: string[] = [];
    for (const importPath of imports) {
      const resolved = await resolveRelativeImport(absolutePath, importPath, absoluteRoot);
      if (!resolved) {
        continue;
      }
      resolvedImports.push(path.relative(absoluteRoot, resolved).replaceAll(path.sep, '/'));
    }

    for (const target_file of resolvedImports) {
      importEdges.push({
        workspace,
        source_file: relativePath,
        target_file,
      });
    }

    const fileInfo: Pass0FileInfo = {
      filePath: relativePath,
      absolutePath,
      directory: path.dirname(relativePath).replaceAll(path.sep, '/'),
      cluster,
      loc,
      fileHash,
      imports: resolvedImports,
      exports,
    };
    files.push(fileInfo);

    upsertFileRecord(db, {
      workspace,
      file_path: relativePath,
      file_hash: fileHash,
      cluster,
      loc,
      public_api: [],
      exports,
      patterns: [],
      dependencies: { imports: resolvedImports, imported_by: [] },
      data_flows: [],
      key_types: [],
      hazards: [],
      conventions: [],
      language: relativePath.endsWith('.tsx') ? 'tsx' : 'typescript',
      blurb: '',
      purpose: '',
      extraction_model: null,
      last_extracted: null,
      cross_refs: null,
    });
  }

  replaceImportEdges(db, workspace, importEdges);

  return {
    workspace,
    rootDir: absoluteRoot,
    files,
    importEdges,
  };
}
