import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface FixtureLink {
  path: string;
  target: string;
  kind: 'directory';
}

interface RenameEvent {
  at: string;
  from: string;
  to: string;
}

interface FixtureManifest {
  schema_version: 1;
  name: string;
  workspace: string;
  clock: string;
  source_files: string[];
  symlinks: FixtureLink[];
  rename_sequence: RenameEvent[];
}

interface ExpectedEdge {
  from: string;
  to: string;
  kind: 'import' | 're-export';
}

interface ExpectedHistory {
  id: number;
  created_at: string;
  file_path: string;
  summary: string;
  breaking_changes: boolean;
}

interface ExpectedMetadata {
  file_path: string;
  hazards: string[];
  source_highlights: Array<{
    label: string;
    start_line: number;
    end_line: number;
  }>;
}

interface ExpectedFixture {
  files: string[];
  entrypoints: string[];
  edges: ExpectedEdge[];
  cycles: string[][];
  dead_files: string[];
  dead_exports: string[];
  malformed_files: Array<{ file_path: string; reason: string }>;
  migrations: string[];
  queries: Record<string, string[]>;
  history: ExpectedHistory[];
  metadata: ExpectedMetadata[];
}

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(testDirectory, '../../test/fixtures/repositories');
const fixtureNames = ['small', 'medium'] as const;
const forbiddenFixtureText = [
  /\/home\//i,
  /\/Users\//i,
  /voxxo-swarm/i,
  /relay\/src/i,
  /api[_-]?key/i,
  /authorization:\s*bearer/i,
];

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function assertSafeRelativePath(value: string): void {
  assert.ok(value.length > 0, 'fixture path must not be empty');
  assert.equal(path.posix.isAbsolute(value), false, `fixture path must be relative: ${value}`);
  assert.equal(value.includes('\\'), false, `fixture path must use POSIX separators: ${value}`);
  assert.equal(value.split('/').includes('..'), false, `fixture path must not escape its root: ${value}`);
  assert.equal(path.posix.normalize(value), value, `fixture path must already be canonical: ${value}`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function listRegularFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await listRegularFiles(root, child));
    else if (entry.isFile()) result.push(toPosix(child));
  }
  return result.sort();
}

function edgeKey(edge: ExpectedEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

async function extractDeclaredEdges(root: string, files: string[]): Promise<ExpectedEdge[]> {
  const edges: ExpectedEdge[] = [];
  for (const filePath of files.filter((candidate) => /\.(?:[cm]?ts|[cm]?js)$/.test(candidate))) {
    const content = await readFile(path.join(root, filePath), 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/(?:\bfrom\s+|^\s*import\s*)['"]([^'"]+)['"]/);
      const specifier = match?.[1];
      if (!specifier?.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(filePath),
        specifier.replace(/\.(?:[cm]?js)$/, '.ts'),
      ));
      edges.push({
        from: filePath,
        to: resolved,
        kind: /^\s*export\b/.test(line) ? 're-export' : 'import',
      });
    }
  }
  return edges.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}

async function snapshotMaterialized(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, child);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      result.push(`link:${toPosix(child)}`);
    } else if (stat.isDirectory()) {
      result.push(...await snapshotMaterialized(root, child));
    } else if (stat.isFile()) {
      const hash = createHash('sha256').update(await readFile(absolute)).digest('hex');
      result.push(`file:${toPosix(child)}:${hash}`);
    }
  }
  return result.sort();
}

async function materializeFixture(source: string, destination: string, links: FixtureLink[]): Promise<void> {
  await cp(source, destination, { recursive: true, force: false });
  for (const link of links) {
    const linkPath = path.join(destination, ...link.path.split('/'));
    const targetPath = path.join(destination, ...link.target.split('/'));
    await mkdir(path.dirname(linkPath), { recursive: true });
    const target = process.platform === 'win32'
      ? targetPath
      : path.relative(path.dirname(linkPath), targetPath);
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await realpath(linkPath), await realpath(targetPath));
  }
}

for (const fixtureName of fixtureNames) {
  test(`${fixtureName} repository fixture is explicit, public, and internally consistent`, async () => {
    const root = path.join(fixtureRoot, fixtureName);
    const manifest = await readJson<FixtureManifest>(path.join(root, 'fixture.json'));
    const expected = await readJson<ExpectedFixture>(path.join(root, 'expected.json'));

    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.name, fixtureName);
    assert.match(manifest.workspace, /^fixture-/);
    assert.equal(new Date(manifest.clock).toISOString(), manifest.clock);
    assert.deepEqual(manifest.source_files, [...manifest.source_files].sort());
    assert.deepEqual(expected.files, manifest.source_files);

    const diskFiles = (await listRegularFiles(root))
      .filter((filePath) => filePath !== 'fixture.json' && filePath !== 'expected.json');
    assert.deepEqual(diskFiles, expected.files);

    for (const filePath of expected.files) assertSafeRelativePath(filePath);
    for (const filePath of expected.entrypoints) assert.ok(expected.files.includes(filePath));
    for (const edge of expected.edges) {
      assert.ok(expected.files.includes(edge.from), `edge source is missing: ${edge.from}`);
      assert.ok(expected.files.includes(edge.to), `edge target is missing: ${edge.to}`);
    }
    assert.deepEqual(
      await extractDeclaredEdges(root, expected.files),
      [...expected.edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
      'the explicit edge oracle must match every relative import and re-export in fixture source',
    );
    for (const cycle of expected.cycles) {
      assert.ok(cycle.length >= 2);
      cycle.forEach((from, index) => {
        const to = cycle[(index + 1) % cycle.length];
        assert.ok(expected.edges.some((edge) => edge.from === from && edge.to === to), `cycle edge is missing: ${from} -> ${to}`);
      });
    }
    for (const filePath of expected.dead_files) assert.ok(expected.files.includes(filePath));
    for (const deadExport of expected.dead_exports) {
      const [filePath, symbol] = deadExport.split('#');
      assert.ok(filePath && expected.files.includes(filePath));
      assert.ok(symbol);
    }
    for (const malformed of expected.malformed_files) {
      assert.ok(expected.files.includes(malformed.file_path));
      assert.ok(malformed.reason.length > 0);
    }

    const migrationFiles = expected.files
      .filter((filePath) => filePath.startsWith('migrations/'))
      .map((filePath) => path.posix.basename(filePath));
    assert.deepEqual(migrationFiles, expected.migrations);

    for (const [query, paths] of Object.entries(expected.queries)) {
      assert.ok(query.trim().length > 0);
      assert.ok(paths.length > 0);
      paths.forEach((filePath) => assert.ok(expected.files.includes(filePath)));
    }

    assert.equal(new Set(expected.history.map((entry) => entry.id)).size, expected.history.length);
    const sortedHistoryTimes = expected.history.map((entry) => entry.created_at).sort();
    assert.deepEqual(expected.history.map((entry) => entry.created_at), sortedHistoryTimes);
    const historicalPaths = new Set([
      ...expected.files,
      ...manifest.rename_sequence.flatMap((event) => [event.from, event.to]),
    ]);
    for (const entry of expected.history) {
      assert.equal(new Date(entry.created_at).toISOString(), entry.created_at);
      assert.ok(historicalPaths.has(entry.file_path));
      assert.ok(entry.summary.length >= 10);
    }

    for (const event of manifest.rename_sequence) {
      assertSafeRelativePath(event.from);
      assertSafeRelativePath(event.to);
      assert.equal(new Date(event.at).toISOString(), event.at);
      assert.equal(expected.files.includes(event.from), false);
      assert.equal(expected.files.includes(event.to), true);
    }

    for (const metadata of expected.metadata) {
      assert.ok(expected.files.includes(metadata.file_path));
      const lineCount = (await readFile(path.join(root, metadata.file_path), 'utf8')).split('\n').length;
      for (const highlight of metadata.source_highlights) {
        assert.ok(highlight.label.length > 0);
        assert.ok(highlight.start_line >= 1);
        assert.ok(highlight.start_line <= highlight.end_line);
        assert.ok(highlight.end_line <= lineCount);
      }
      metadata.hazards.forEach((hazard) => assert.ok(hazard.length >= 10));
    }

    for (const link of manifest.symlinks) {
      assertSafeRelativePath(link.path);
      assertSafeRelativePath(link.target);
      assert.equal(expected.files.some((filePath) => filePath === link.path || filePath.startsWith(`${link.path}/`)), false);
      assert.ok(expected.files.some((filePath) => filePath.startsWith(`${link.target}/`)));
    }

    for (const filePath of ['fixture.json', 'expected.json', ...expected.files]) {
      const content = await readFile(path.join(root, filePath), 'utf8');
      for (const forbidden of forbiddenFixtureText) {
        assert.doesNotMatch(content, forbidden, `${fixtureName}/${filePath} contains private fixture text`);
      }
    }
  });

  test(`${fixtureName} repository materializes byte-deterministically with its symlink aliases`, async () => {
    const root = path.join(fixtureRoot, fixtureName);
    const manifest = await readJson<FixtureManifest>(path.join(root, 'fixture.json'));
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `atlas-${fixtureName}-fixture-`));
    try {
      const first = path.join(tempRoot, 'first');
      const second = path.join(tempRoot, 'second');
      await materializeFixture(root, first, manifest.symlinks);
      await materializeFixture(root, second, manifest.symlinks);
      assert.deepEqual(await snapshotMaterialized(first), await snapshotMaterialized(second));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}
