import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeRepositoryPath,
  canonicalizeWorkspaceName,
  type AtlasCanonicalPathResult,
  type AtlasPathAlias,
  type AtlasPathPlatform,
  type AtlasPathRedirect,
  type AtlasRepositoryPathContext,
} from '../core/paths.js';

interface FixtureContext {
  workspace: string;
  repository_root: string;
  platform: AtlasPathPlatform;
  case_sensitive?: boolean;
  symlinks?: AtlasPathAlias[];
  redirects?: AtlasPathRedirect[];
}

interface FixtureCase {
  name: string;
  context: string;
  input: string;
  expected: AtlasCanonicalPathResult;
}

interface PathFixture {
  schema_version: 1;
  contexts: Record<string, FixtureContext>;
  cases: FixtureCase[];
}

interface RepositoryFixtureManifest {
  workspace: string;
  symlinks: Array<{ path: string; target: string; kind: 'directory' }>;
  rename_sequence: Array<{ at: string; from: string; to: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePathFixture(value: unknown): PathFixture {
  assert.ok(isObject(value));
  assert.equal(value.schema_version, 1);
  assert.ok(isObject(value.contexts));
  assert.ok(Array.isArray(value.cases));
  return value as unknown as PathFixture;
}

function parseRepositoryFixture(value: unknown): RepositoryFixtureManifest {
  assert.ok(isObject(value));
  assert.equal(typeof value.workspace, 'string');
  assert.ok(Array.isArray(value.symlinks));
  assert.ok(Array.isArray(value.rename_sequence));
  return value as unknown as RepositoryFixtureManifest;
}

function toContext(value: FixtureContext): AtlasRepositoryPathContext {
  return {
    workspace: value.workspace,
    repositoryRoot: value.repository_root,
    platform: value.platform,
    caseSensitive: value.case_sensitive,
    symlinks: value.symlinks,
    redirects: value.redirects,
  };
}

const pathFixturePath = fileURLToPath(
  new URL('../../test/fixtures/contracts/path-canonicalization.json', import.meta.url),
);
const repositoryFixturePath = fileURLToPath(
  new URL('../../test/fixtures/repositories/small/fixture.json', import.meta.url),
);

test('cross-platform path fixtures resolve or reject deterministically', async () => {
  const fixture = parsePathFixture(JSON.parse(await readFile(pathFixturePath, 'utf8')) as unknown);

  for (const fixtureCase of fixture.cases) {
    const context = fixture.contexts[fixtureCase.context];
    assert.ok(context, `missing context ${fixtureCase.context}`);
    const first = canonicalizeRepositoryPath(fixtureCase.input, toContext(context));
    const second = canonicalizeRepositoryPath(fixtureCase.input, toContext(context));
    assert.deepEqual(first, fixtureCase.expected, fixtureCase.name);
    assert.deepEqual(second, first, `${fixtureCase.name} must be deterministic`);
  }
});

test('repository fixture symlink and rename aliases converge on current identities', async () => {
  const manifest = parseRepositoryFixture(
    JSON.parse(await readFile(repositoryFixturePath, 'utf8')) as unknown,
  );
  const context: AtlasRepositoryPathContext = {
    workspace: manifest.workspace,
    repositoryRoot: '/srv/atlas/fixture-small',
    platform: 'posix',
    symlinks: manifest.symlinks,
    redirects: manifest.rename_sequence.map((event) => ({
      from: event.from,
      to: event.to,
      kind: 'file',
    })),
  };

  const linked = canonicalizeRepositoryPath('src/linked-math/add.ts', context);
  const direct = canonicalizeRepositoryPath('src/math/add.ts', context);
  assert.equal(linked.ok && linked.identity, direct.ok && direct.identity);

  const renamed = canonicalizeRepositoryPath('src/rename/old-name.ts', context);
  const current = canonicalizeRepositoryPath('src/rename/new-name.ts', context);
  assert.equal(renamed.ok && renamed.identity, current.ok && current.identity);
});

test('workspace names have one stable public spelling', () => {
  assert.deepEqual(canonicalizeWorkspaceName(' Fixture-Small '), {
    ok: true,
    name: 'fixture-small',
  });
  assert.deepEqual(canonicalizeWorkspaceName('../fixture'), {
    ok: false,
    code: 'INVALID_WORKSPACE',
    message: 'Workspace must be a canonical non-empty slug.',
  });
});

test('path failure results do not echo rejected external paths', async () => {
  const fixture = parsePathFixture(JSON.parse(await readFile(pathFixturePath, 'utf8')) as unknown);
  for (const fixtureCase of fixture.cases) {
    if (fixtureCase.expected.ok) continue;
    assert.equal(
      fixtureCase.expected.message
        .toLocaleLowerCase('en-US')
        .includes(fixtureCase.input.toLocaleLowerCase('en-US')),
      false,
      `${fixtureCase.name} must not echo the rejected input`,
    );
  }
});
