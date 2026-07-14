export type AtlasPathPlatform = 'posix' | 'win32';
export type AtlasPathMappingKind = 'file' | 'directory';

export interface AtlasPathAlias {
  path: string;
  target: string;
  kind: AtlasPathMappingKind;
}

export interface AtlasPathRedirect {
  from: string;
  to: string | null;
  kind: AtlasPathMappingKind;
}

export interface AtlasRepositoryPathContext {
  workspace: string;
  repositoryRoot: string;
  platform: AtlasPathPlatform;
  caseSensitive?: boolean;
  symlinks?: readonly AtlasPathAlias[];
  redirects?: readonly AtlasPathRedirect[];
}

export type AtlasPathFailureCode =
  | 'INVALID_WORKSPACE'
  | 'EMPTY_PATH'
  | 'INVALID_PATH'
  | 'ROOT_NOT_ABSOLUTE'
  | 'PATH_OUTSIDE_REPOSITORY'
  | 'PATH_TRAVERSAL'
  | 'INVALID_MAPPING'
  | 'MAPPING_CYCLE';

export interface AtlasPathFailure {
  ok: false;
  code: AtlasPathFailureCode;
  message: string;
}

export interface AtlasCanonicalPath {
  ok: true;
  workspace: string;
  path: string;
  identity: string;
  state: 'current' | 'deleted';
  aliases: readonly string[];
  resolvedSymlink: boolean;
  redirected: boolean;
}

export type AtlasCanonicalPathResult = AtlasCanonicalPath | AtlasPathFailure;

export type AtlasWorkspaceNameResult =
  | { ok: true; name: string }
  | { ok: false; code: 'INVALID_WORKSPACE'; message: string };

interface NormalizedPath {
  value: string;
  escaped: boolean;
}

interface PreparedAlias {
  from: string;
  to: string;
  kind: AtlasPathMappingKind;
}

interface PreparedRedirect {
  from: string;
  to: string | null;
  kind: AtlasPathMappingKind;
}

const MESSAGES: Readonly<Record<AtlasPathFailureCode, string>> = {
  INVALID_WORKSPACE: 'Workspace must be a canonical non-empty slug.',
  EMPTY_PATH: 'Path must identify a repository-relative entry.',
  INVALID_PATH: 'Path contains unsupported or ambiguous syntax.',
  ROOT_NOT_ABSOLUTE: 'Repository root must be an absolute path for the selected platform.',
  PATH_OUTSIDE_REPOSITORY: 'Absolute path is outside the authorized repository root.',
  PATH_TRAVERSAL: 'Path traversal escapes the authorized repository root.',
  INVALID_MAPPING: 'Path aliases and redirects must be canonical repository-relative paths.',
  MAPPING_CYCLE: 'Path alias or redirect mappings contain a cycle.',
};

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:[^/]/;

function failure(code: AtlasPathFailureCode): AtlasPathFailure {
  return { ok: false, code, message: MESSAGES[code] };
}

function slashNormalize(value: string): string {
  return value.normalize('NFC').replaceAll('\\', '/');
}

function normalizeSegments(value: string, caseSensitive: boolean): NormalizedPath {
  const segments: string[] = [];
  let escaped = false;

  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) escaped = true;
      else segments.pop();
      continue;
    }
    segments.push(caseSensitive ? segment : segment.toLocaleLowerCase('en-US'));
  }

  return { value: segments.join('/'), escaped };
}

function isAbsoluteForPlatform(value: string, platform: AtlasPathPlatform): boolean {
  if (platform === 'posix') return value.startsWith('/') && !value.startsWith('//');
  return WINDOWS_DRIVE_ABSOLUTE.test(value) || value.startsWith('//');
}

function normalizeAbsolute(
  raw: string,
  platform: AtlasPathPlatform,
  caseSensitive: boolean,
): NormalizedPath | null {
  const value = slashNormalize(raw);

  if (platform === 'posix') {
    if (!value.startsWith('/') || value.startsWith('//')) return null;
    const normalized = normalizeSegments(value.slice(1), caseSensitive);
    return { value: `/${normalized.value}`, escaped: normalized.escaped };
  }

  if (WINDOWS_DRIVE_ABSOLUTE.test(value)) {
    const drive = value.slice(0, 2).toLocaleLowerCase('en-US');
    const normalized = normalizeSegments(value.slice(3), caseSensitive);
    return {
      value: normalized.value.length > 0 ? `${drive}/${normalized.value}` : `${drive}/`,
      escaped: normalized.escaped,
    };
  }

  if (value.startsWith('//')) {
    const rawSegments = value.slice(2).split('/').filter((segment) => segment.length > 0);
    if (rawSegments.length < 2) return null;
    const authority = rawSegments.slice(0, 2)
      .map((segment) => caseSensitive ? segment : segment.toLocaleLowerCase('en-US'))
      .join('/');
    const normalized = normalizeSegments(rawSegments.slice(2).join('/'), caseSensitive);
    return {
      value: normalized.value.length > 0 ? `//${authority}/${normalized.value}` : `//${authority}`,
      escaped: normalized.escaped,
    };
  }

  return null;
}

function normalizeRelative(
  raw: string,
  platform: AtlasPathPlatform,
  caseSensitive: boolean,
): NormalizedPath | null {
  const value = slashNormalize(raw);
  if (
    value.length === 0
    || CONTROL_CHARACTER.test(value)
    || isAbsoluteForPlatform(value, platform)
    || WINDOWS_DRIVE_RELATIVE.test(value)
    || (URI_SCHEME.test(value) && !WINDOWS_DRIVE_ABSOLUTE.test(value))
  ) {
    return null;
  }
  return normalizeSegments(value, caseSensitive);
}

function isMappingMatch(path: string, from: string, kind: AtlasPathMappingKind): boolean {
  return path === from || (kind === 'directory' && path.startsWith(`${from}/`));
}

function replaceMappingPrefix(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

function sortMappings<T extends { from: string; kind: AtlasPathMappingKind }>(values: T[]): T[] {
  return values.sort((left, right) =>
    right.from.length - left.from.length
    || left.from.localeCompare(right.from, 'en')
    || left.kind.localeCompare(right.kind, 'en'));
}

function prepareMappings(
  context: AtlasRepositoryPathContext,
  caseSensitive: boolean,
): { aliases: PreparedAlias[]; redirects: PreparedRedirect[] } | null {
  const normalize = (value: string): string | null => {
    const result = normalizeRelative(value, context.platform, caseSensitive);
    if (!result || result.escaped || result.value.length === 0 || result.value !== slashNormalize(value)) {
      return null;
    }
    return result.value;
  };

  const aliases: PreparedAlias[] = [];
  const redirects: PreparedRedirect[] = [];
  const sources = new Set<string>();

  for (const alias of context.symlinks ?? []) {
    const from = normalize(alias.path);
    const to = normalize(alias.target);
    if (!from || !to || from === to || sources.has(from)) return null;
    sources.add(from);
    aliases.push({ from, to, kind: alias.kind });
  }

  for (const redirect of context.redirects ?? []) {
    const from = normalize(redirect.from);
    const to = redirect.to === null ? null : normalize(redirect.to);
    if (!from || (redirect.to !== null && !to) || from === to || sources.has(from)) return null;
    sources.add(from);
    redirects.push({ from, to, kind: redirect.kind });
  }

  return {
    aliases: sortMappings(aliases),
    redirects: sortMappings(redirects),
  };
}

export function canonicalizeWorkspaceName(input: string): AtlasWorkspaceNameResult {
  const name = input.normalize('NFC').trim().toLocaleLowerCase('en-US');
  if (
    name.length === 0
    || name.length > 128
    || !/^[a-z0-9][a-z0-9._-]*$/.test(name)
    || CONTROL_CHARACTER.test(name)
  ) {
    return { ok: false, code: 'INVALID_WORKSPACE', message: MESSAGES.INVALID_WORKSPACE };
  }
  return { ok: true, name };
}

/**
 * Canonicalize one path into a workspace-qualified, repository-relative POSIX
 * identity without filesystem access. Symlink and rename knowledge is explicit
 * input so identical records produce identical output on every host.
 */
export function canonicalizeRepositoryPath(
  input: string,
  context: AtlasRepositoryPathContext,
): AtlasCanonicalPathResult {
  const workspace = canonicalizeWorkspaceName(context.workspace);
  if (!workspace.ok) return failure('INVALID_WORKSPACE');
  if (input.length === 0) return failure('EMPTY_PATH');
  if (CONTROL_CHARACTER.test(input)) return failure('INVALID_PATH');

  const caseSensitive = context.caseSensitive ?? context.platform === 'posix';
  const root = normalizeAbsolute(context.repositoryRoot, context.platform, caseSensitive);
  if (!root || root.escaped) return failure('ROOT_NOT_ABSOLUTE');

  const normalizedInput = slashNormalize(input);
  const inputLooksAbsolute = normalizedInput.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE.test(normalizedInput);
  let relative: NormalizedPath | null;

  if (inputLooksAbsolute) {
    const absolute = normalizeAbsolute(normalizedInput, context.platform, caseSensitive);
    if (!absolute || absolute.escaped) return failure('PATH_OUTSIDE_REPOSITORY');
    if (absolute.value === root.value) return failure('EMPTY_PATH');
    if (!absolute.value.startsWith(`${root.value.replace(/\/$/, '')}/`)) {
      return failure('PATH_OUTSIDE_REPOSITORY');
    }
    relative = { value: absolute.value.slice(root.value.replace(/\/$/, '').length + 1), escaped: false };
  } else {
    relative = normalizeRelative(normalizedInput, context.platform, caseSensitive);
    if (!relative) return failure('INVALID_PATH');
    if (relative.escaped) return failure('PATH_TRAVERSAL');
  }

  if (relative.value.length === 0) return failure('EMPTY_PATH');
  const mappings = prepareMappings(context, caseSensitive);
  if (!mappings) return failure('INVALID_MAPPING');

  let current = relative.value;
  let resolvedSymlink = false;
  let redirected = false;
  const aliases: string[] = [];
  const seen = new Set<string>([current]);
  const remember = (value: string): void => {
    if (value !== current && !aliases.includes(value)) aliases.push(value);
  };
  const iterationLimit = Math.max(1, (mappings.aliases.length + mappings.redirects.length) * 2 + 1);

  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    let changed = false;
    const alias = mappings.aliases.find((candidate) => isMappingMatch(current, candidate.from, candidate.kind));
    if (alias) {
      const previous = current;
      current = replaceMappingPrefix(current, alias.from, alias.to);
      remember(previous);
      resolvedSymlink = true;
      changed = true;
      if (seen.has(current)) return failure('MAPPING_CYCLE');
      seen.add(current);
    }

    const redirect = mappings.redirects.find((candidate) =>
      isMappingMatch(current, candidate.from, candidate.kind));
    if (redirect) {
      redirected = true;
      if (redirect.to === null) {
        return {
          ok: true,
          workspace: workspace.name,
          path: current,
          identity: `${workspace.name}:${current}`,
          state: 'deleted',
          aliases,
          resolvedSymlink,
          redirected,
        };
      }
      const previous = current;
      current = replaceMappingPrefix(current, redirect.from, redirect.to);
      remember(previous);
      changed = true;
      if (seen.has(current)) return failure('MAPPING_CYCLE');
      seen.add(current);
    }

    if (!changed) {
      return {
        ok: true,
        workspace: workspace.name,
        path: current,
        identity: `${workspace.name}:${current}`,
        state: 'current',
        aliases,
        resolvedSymlink,
        redirected,
      };
    }
  }

  return failure('MAPPING_CYCLE');
}
