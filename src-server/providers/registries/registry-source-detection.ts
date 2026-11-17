/**
 * What a registry source provides, decided by the structure of its content
 * (docs/decisions/registry-sources-detected-by-structure.md).
 *
 * A source is a location and an optional ref. Station reads its file tree, or
 * the one document it names, within fixed bounds, and runs detectors over it:
 *
 * 1. Index detectors read a declared file at the root (a Station manifest, a
 *    `.claude-plugin/marketplace.json`). An index decides every kind it
 *    declares, so a scan cannot add or hide items of that kind.
 * 2. Structure detectors scan the layout (`**\/SKILL.md`, plugin manifests,
 *    MCP definitions) for the kinds no index declared.
 *
 * A read past a bound is refused, never truncated: a partial scan could hide
 * an item or turn an ambiguous name into a first match.
 *
 * The detector lists are the extension point. A new format (for example a
 * Flow Kit `kit.json`) is one more index or structure detector here; the
 * source model and the source manager do not change.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  RegistrySourceDetectedKind,
  RegistrySourceKind,
} from '@kontourai/station-contracts/catalog';
import { readBoundedJson } from './catalog-http.js';
import {
  HARD_LINK_REFUSAL,
  LocalSourceConfinementError,
  LocalSourceFileTooLargeError,
  readBoundedFile,
  readConfinedFile,
} from './confined-local-read.js';
import { fetchRegistryResource, managedRegistryHop } from './registry-fetch.js';

export interface RegistrySourceScanLimits {
  /** Files and directories in the tree, `.git` excluded. */
  maxEntries: number;
  /** Directory nesting below the source root. */
  maxDepth: number;
  /** Bytes of one index or definition file, or of a single-document source. */
  maxFileBytes: number;
  /** Definition files read by structure detectors. */
  maxDefinitionReads: number;
  /** `SKILL.md` packages, the same budget the GitHub skill catalog enforces. */
  maxSkills: number;
}

export const REGISTRY_SOURCE_SCAN_LIMITS: Readonly<RegistrySourceScanLimits> =
  Object.freeze({
    maxEntries: 8192,
    maxDepth: 16,
    maxFileBytes: 1024 * 1024,
    maxDefinitionReads: 128,
    maxSkills: 512,
  });

/**
 * A read Station stopped at a bound instead of truncating, or refused because
 * a local path left the source folder (`confinement`).
 */
export class RegistrySourceScanRefusal extends Error {
  constructor(
    readonly bound: keyof RegistrySourceScanLimits | 'confinement',
    message: string,
  ) {
    super(message);
    this.name = 'RegistrySourceScanRefusal';
  }
}

export interface SourceTree {
  /** Commit for a repository; a digest of the scanned tree for a folder. */
  revision: string;
  /** Regular files, as `/`-separated paths relative to the source root. */
  files: readonly string[];
  /** Each listed file's size in bytes, where the listing states it. */
  sizes: ReadonlyMap<string, number>;
  /**
   * Listed files with more than one hard link (a local folder only). Read
   * files are refused when read; a file counted unread is refused by this.
   */
  multiplyLinked?: ReadonlySet<string>;
  read(path: string, limits: RegistrySourceScanLimits): Promise<Buffer>;
}

const IGNORED_DIRECTORIES = new Set(['.git']);

function refuseEntries(limits: RegistrySourceScanLimits): never {
  throw new RegistrySourceScanRefusal(
    'maxEntries',
    `Source has more than ${limits.maxEntries} files and folders. Point it at a smaller folder or repository.`,
  );
}

function refuseDepth(limits: RegistrySourceScanLimits): never {
  throw new RegistrySourceScanRefusal(
    'maxDepth',
    `Source nests folders more than ${limits.maxDepth} levels deep. Point it at a shallower folder or repository.`,
  );
}

function refuseFileBytes(
  path: string,
  limits: RegistrySourceScanLimits,
): never {
  throw new RegistrySourceScanRefusal(
    'maxFileBytes',
    `Source file ${path} is larger than ${limits.maxFileBytes} bytes.`,
  );
}

/**
 * A local folder's tree. Symlinks are counted but never followed, so a link
 * cannot pull files from outside the folder into its catalog.
 */
export async function readLocalSourceTree(
  root: string,
  limits: RegistrySourceScanLimits = REGISTRY_SOURCE_SCAN_LIMITS,
): Promise<SourceTree> {
  if (!(await stat(root)).isDirectory())
    throw new Error('Local source is not a folder.');
  const files: string[] = [];
  const sizes = new Map<string, number>();
  const multiplyLinked = new Set<string>();
  const digest = createHash('sha256');
  let entries = 0;
  const walk = async (directory: string, prefix: string, depth: number) => {
    const children = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const child of children) {
      if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
      entries += 1;
      if (entries > limits.maxEntries) refuseEntries(limits);
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (depth + 1 > limits.maxDepth) refuseDepth(limits);
        digest.update(`d\0${path}\n`);
        await walk(join(directory, child.name), path, depth + 1);
      } else if (child.isFile()) {
        const info = await lstat(join(directory, child.name));
        digest.update(`f\0${path}\0${info.size}\0${info.mtimeMs}\n`);
        files.push(path);
        sizes.set(path, info.size);
        if (info.nlink > 1) multiplyLinked.add(path);
      } else {
        digest.update(`o\0${path}\n`);
      }
    }
  };
  await walk(root, '', 0);
  return {
    revision: digest.digest('hex'),
    files,
    sizes,
    multiplyLinked,
    async read(path, readLimits) {
      // Confined by real path at the moment of the read: the tree was listed
      // earlier, and a directory in it may have become a link since.
      try {
        return await readConfinedFile(
          root,
          resolve(root, path),
          readLimits.maxFileBytes,
        );
      } catch (error) {
        if (error instanceof LocalSourceFileTooLargeError)
          refuseFileBytes(path, readLimits);
        if (error instanceof LocalSourceConfinementError)
          throw new RegistrySourceScanRefusal('confinement', error.message);
        throw error;
      }
    },
  };
}

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  mode: string;
  size?: number;
}

const GITHUB_TREE_MAX_BYTES = 16 * 1024 * 1024;

function assertGitObjectId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('GitHub returned an invalid object identity.');
}

async function githubJson(
  url: string,
  signal: AbortSignal,
  maxResponseBytes?: number,
): Promise<unknown> {
  const response = await fetchRegistryResource(
    url,
    {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'station',
      },
    },
    managedRegistryHop,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub API ${response.status}`);
  }
  return readBoundedJson(
    response,
    maxResponseBytes ? { maxResponseBytes } : undefined,
  );
}

/**
 * A GitHub repository's tree at the commit `ref` names right now. The commit
 * is resolved on every read, never from a local checkout or a cached tree, so
 * a moved branch is seen as a new revision.
 */
export async function readGitHubSourceTree(
  owner: string,
  repo: string,
  ref: string,
  limits: RegistrySourceScanLimits = REGISTRY_SOURCE_SCAN_LIMITS,
): Promise<SourceTree> {
  const signal = AbortSignal.timeout(60_000);
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const commit = (await githubJson(
    `${api}/commits/${encodeURIComponent(ref)}`,
    signal,
  )) as { sha?: unknown; commit?: { tree?: { sha?: unknown } } };
  assertGitObjectId(commit.sha);
  const treeSha = commit.commit?.tree?.sha;
  assertGitObjectId(treeSha);
  const tree = (await githubJson(
    `${api}/git/trees/${treeSha}?recursive=1`,
    signal,
    GITHUB_TREE_MAX_BYTES,
  )) as { sha?: unknown; truncated?: unknown; tree?: unknown };
  if (tree.sha !== treeSha || !Array.isArray(tree.tree))
    throw new Error('GitHub returned an incomplete tree.');
  // GitHub stops a recursive tree at its own limit and says so. That is the
  // same refusal as Station's bound: the listing is not the whole source.
  if (tree.truncated !== false) refuseEntries(limits);
  const entries = (tree.tree as GitHubTreeEntry[]).filter(
    (entry) =>
      !entry.path.split('/').some((part) => IGNORED_DIRECTORIES.has(part)),
  );
  if (entries.length > limits.maxEntries) refuseEntries(limits);
  const blobs = new Map<string, GitHubTreeEntry>();
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (
      parts.some((part) => !part || part === '.' || part === '..') ||
      entry.path.includes('\\')
    )
      throw new Error('GitHub tree contains an unsafe path.');
    const depth = entry.type === 'tree' ? parts.length : parts.length - 1;
    if (depth > limits.maxDepth) refuseDepth(limits);
    if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
      blobs.set(entry.path, entry);
      if (typeof entry.size === 'number') sizes.set(entry.path, entry.size);
    }
  }
  const commitSha = commit.sha;
  return {
    revision: commitSha,
    files: [...blobs.keys()],
    sizes,
    async read(path, readLimits) {
      const entry = blobs.get(path);
      if (!entry) throw new Error('Source file is not in the tree.');
      assertGitObjectId(entry.sha);
      if (entry.size !== undefined && entry.size > readLimits.maxFileBytes)
        refuseFileBytes(path, readLimits);
      const response = await fetchRegistryResource(
        `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`,
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          headers: { 'User-Agent': 'station' },
        },
        managedRegistryHop,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`GitHub file read failed: ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > readLimits.maxFileBytes)
        refuseFileBytes(path, readLimits);
      const digest = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (digest !== entry.sha)
        throw new Error('GitHub file does not match its tree entry.');
      return bytes;
    },
  };
}

/** A source that is one document: a local file or an HTTPS URL. */
export async function readSourceDocument(
  location: string,
  limits: RegistrySourceScanLimits = REGISTRY_SOURCE_SCAN_LIMITS,
): Promise<{ value: unknown; revision: string }> {
  let value: unknown;
  if (isAbsolute(location)) {
    const info = await lstat(location);
    if (!info.isFile()) throw new Error('Source file is not a regular file.');
    if (info.size > limits.maxFileBytes) refuseFileBytes(location, limits);
    try {
      value = JSON.parse(
        (await readBoundedFile(location, limits.maxFileBytes)).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof LocalSourceFileTooLargeError)
        refuseFileBytes(location, limits);
      throw error;
    }
  } else {
    const response = await fetchRegistryResource(
      location,
      { signal: AbortSignal.timeout(20_000) },
      managedRegistryHop,
    );
    try {
      value = await readBoundedJson(response, {
        maxResponseBytes: limits.maxFileBytes,
      });
    } catch (error) {
      if (error instanceof Error && /byte limit/.test(error.message))
        refuseFileBytes(location, limits);
      throw error;
    }
  }
  return {
    value,
    revision: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
}

type DetectedKind = Omit<RegistrySourceDetectedKind, 'via' | 'managedDenial'>;

/** Reads a declared root file. Its kinds win over any structural scan. */
export interface RegistrySourceIndexDetector {
  id: string;
  /** Root-relative paths this index may live at, in preference order. */
  paths: readonly string[];
  /** The kinds the parsed document declares, or null when it is not this format. */
  parse(value: unknown): DetectedKind[] | null;
}

/** Scans the layout for kinds no index declared. */
export interface RegistrySourceStructureDetector {
  id: string;
  /** Kinds it can report; it is skipped, unread, when an index declared them all. */
  provides: readonly RegistrySourceKind[];
  detect(
    tree: SourceTree,
    limits: RegistrySourceScanLimits,
    budget: { reads: number },
  ): Promise<{ kinds: DetectedKind[]; skillRoots?: string[] } | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Station's own manifest: `{ version, plugins: [{ id, source, type? }], tools? }`. */
const stationManifestDetector: RegistrySourceIndexDetector = {
  id: 'station-manifest',
  paths: ['registry.json', 'manifest.json'],
  parse(value) {
    if (
      !isRecord(value) ||
      typeof value.version !== 'number' ||
      !Array.isArray(value.plugins) ||
      !value.plugins.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.id === 'string' &&
          typeof entry.source === 'string',
      )
    )
      return null;
    const entries = value.plugins as Array<Record<string, unknown>>;
    const agents = entries.filter((entry) => entry.type === 'agent').length;
    const tools = Array.isArray(value.tools) ? value.tools.length : 0;
    return [
      { kind: 'plugins', count: entries.length - agents, installable: true },
      { kind: 'agents', count: agents, installable: true },
      {
        kind: 'integrations',
        count: tools,
        installable: false,
        note: 'Tool servers from an added source are recognized but not yet listed for installation.',
      },
    ];
  },
};

/** A Claude Code marketplace: `{ name, plugins: [{ name, source }] }`. */
const claudeMarketplaceDetector: RegistrySourceIndexDetector = {
  id: 'claude-marketplace',
  paths: ['.claude-plugin/marketplace.json'],
  parse(value) {
    if (
      !isRecord(value) ||
      typeof value.name !== 'string' ||
      !Array.isArray(value.plugins) ||
      !value.plugins.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.name === 'string' &&
          (typeof entry.source === 'string' || isRecord(entry.source)),
      )
    )
      return null;
    return [
      {
        kind: 'plugins',
        count: value.plugins.length,
        installable: false,
        note: 'Claude Code plugin packages are recognized but are not a format Station installs. Skills inside them are listed as skills.',
      },
    ];
  },
};

/** `<dir>/SKILL.md` anywhere below the root; a root `SKILL.md` is not a library. */
const skillDocumentDetector: RegistrySourceStructureDetector = {
  id: 'skill-md',
  provides: ['skills'],
  async detect(tree, limits) {
    const skills = tree.files.filter((path) => path.endsWith('/SKILL.md'));
    if (skills.length === 0) return null;
    if (skills.length > limits.maxSkills)
      throw new RegistrySourceScanRefusal(
        'maxSkills',
        `Source has more than ${limits.maxSkills} skills. Point it at a smaller folder or repository.`,
      );
    // Every SKILL.md is read when its catalog is listed, so the read bound
    // applies to each one here, before any of them is read.
    for (const path of skills) {
      const size = tree.sizes.get(path);
      if (size === undefined || size > limits.maxFileBytes)
        refuseFileBytes(path, limits);
      // Counted without being read, so the read's hard-link refusal would
      // come too late: the same refusal applies here, naming the file.
      if (tree.multiplyLinked?.has(path))
        throw new RegistrySourceScanRefusal(
          'confinement',
          `${path}: ${HARD_LINK_REFUSAL}`,
        );
    }
    const roots = new Set(
      skills.map((path) => {
        const parts = path.split('/');
        return parts.slice(0, -2).join('/');
      }),
    );
    return {
      kinds: [{ kind: 'skills', count: skills.length, installable: true }],
      skillRoots: [...roots].sort(),
    };
  },
};

async function readDefinition(
  tree: SourceTree,
  path: string,
  limits: RegistrySourceScanLimits,
  budget: { reads: number },
): Promise<unknown> {
  budget.reads += 1;
  if (budget.reads > limits.maxDefinitionReads)
    throw new RegistrySourceScanRefusal(
      'maxDefinitionReads',
      `Source has more than ${limits.maxDefinitionReads} definition files to read. Point it at a smaller folder or repository.`,
    );
  try {
    return JSON.parse((await tree.read(path, limits)).toString('utf8'));
  } catch (error) {
    if (error instanceof RegistrySourceScanRefusal) throw error;
    return undefined;
  }
}

/** Agent Plugins `plugin.json` packages and `.claude-plugin/plugin.json`. */
const pluginManifestDetector: RegistrySourceStructureDetector = {
  id: 'plugin-manifest',
  provides: ['plugins'],
  async detect(tree, limits, budget) {
    let count = 0;
    for (const path of tree.files) {
      const name = path.split('/').at(-1);
      if (name !== 'plugin.json') continue;
      const value = await readDefinition(tree, path, limits, budget);
      if (isRecord(value) && typeof value.name === 'string') count += 1;
    }
    return count === 0
      ? null
      : {
          kinds: [
            {
              kind: 'plugins',
              count,
              installable: false,
              note: 'Plugin packages without a Station manifest are recognized but install only through a manifest that lists them.',
            },
          ],
        };
  },
};

/** `mcp.json` / `.mcp.json` with an `mcpServers` object. */
const mcpDefinitionDetector: RegistrySourceStructureDetector = {
  id: 'mcp-definitions',
  provides: ['integrations'],
  async detect(tree, limits, budget) {
    let count = 0;
    for (const path of tree.files) {
      const name = path.split('/').at(-1);
      if (name !== 'mcp.json' && name !== '.mcp.json') continue;
      const value = await readDefinition(tree, path, limits, budget);
      if (isRecord(value) && isRecord(value.mcpServers))
        count += Object.keys(value.mcpServers).length;
    }
    return count === 0
      ? null
      : {
          kinds: [
            {
              kind: 'integrations',
              count,
              installable: false,
              note: 'MCP server definitions are recognized but not yet listed for installation from an added source.',
            },
          ],
        };
  },
};

const REGISTRY_SOURCE_INDEX_DETECTORS: readonly RegistrySourceIndexDetector[] =
  [stationManifestDetector, claudeMarketplaceDetector];
const REGISTRY_SOURCE_STRUCTURE_DETECTORS: readonly RegistrySourceStructureDetector[] =
  [skillDocumentDetector, pluginManifestDetector, mcpDefinitionDetector];

export interface RegistrySourceDetectionResult {
  revision: string;
  kinds: RegistrySourceDetectedKind[];
  /** `<detector>:<path>` of each index that decided kinds. */
  indexes: string[];
  /** Root-relative path of a Station manifest, `''` for a document source. */
  stationManifestPath?: string;
  /** Root-relative folders whose children are skill packages. */
  skillRoots: string[];
}

const KIND_ORDER: readonly RegistrySourceKind[] = [
  'skills',
  'plugins',
  'agents',
  'integrations',
];

function finish(
  revision: string,
  found: RegistrySourceDetectedKind[],
  indexes: string[],
  skillRoots: string[],
  stationManifestPath?: string,
): RegistrySourceDetectionResult {
  return {
    revision,
    kinds: found
      .filter((kind) => kind.count > 0)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
    indexes,
    skillRoots,
    ...(stationManifestPath === undefined ? {} : { stationManifestPath }),
  };
}

/** Detects a folder or repository tree. */
export async function detectRegistrySourceTree(
  tree: SourceTree,
  options: {
    limits?: RegistrySourceScanLimits;
    indexDetectors?: readonly RegistrySourceIndexDetector[];
    structureDetectors?: readonly RegistrySourceStructureDetector[];
  } = {},
): Promise<RegistrySourceDetectionResult> {
  const limits = options.limits ?? REGISTRY_SOURCE_SCAN_LIMITS;
  const files = new Set(tree.files);
  const claimed = new Set<RegistrySourceKind>();
  const found: RegistrySourceDetectedKind[] = [];
  const indexes: string[] = [];
  const budget = { reads: 0 };
  let stationManifestPath: string | undefined;
  for (const detector of options.indexDetectors ??
    REGISTRY_SOURCE_INDEX_DETECTORS) {
    for (const path of detector.paths) {
      if (!files.has(path)) continue;
      const kinds = detector.parse(
        await readDefinition(tree, path, limits, budget),
      );
      if (!kinds) continue;
      // An index claims every kind its format can declare, a declared zero
      // included: the packages it lists are not counted again by a scan.
      const declared = kinds.filter((kind) => !claimed.has(kind.kind));
      if (declared.length === 0) break;
      indexes.push(`${detector.id}:${path}`);
      if (detector === stationManifestDetector) stationManifestPath = path;
      for (const kind of declared) {
        claimed.add(kind.kind);
        found.push({ ...kind, via: detector.id });
      }
      break;
    }
  }
  let skillRoots: string[] = [];
  for (const detector of options.structureDetectors ??
    REGISTRY_SOURCE_STRUCTURE_DETECTORS) {
    if (detector.provides.every((kind) => claimed.has(kind))) continue;
    const result = await detector.detect(tree, limits, budget);
    if (!result) continue;
    const kinds = result.kinds.filter((kind) => !claimed.has(kind.kind));
    if (kinds.length === 0) continue;
    if (kinds.some((kind) => kind.kind === 'skills'))
      skillRoots = result.skillRoots ?? [];
    for (const kind of kinds) {
      claimed.add(kind.kind);
      found.push({ ...kind, via: detector.id });
    }
  }
  return finish(tree.revision, found, indexes, skillRoots, stationManifestPath);
}

/** Detects a single-document source: only an index format can describe it. */
export function detectRegistrySourceDocument(
  document: { value: unknown; revision: string },
  indexDetectors: readonly RegistrySourceIndexDetector[] = REGISTRY_SOURCE_INDEX_DETECTORS,
): RegistrySourceDetectionResult {
  for (const detector of indexDetectors) {
    const kinds = detector.parse(document.value);
    if (!kinds) continue;
    return finish(
      document.revision,
      kinds.map((kind) => ({ ...kind, via: detector.id })),
      [`${detector.id}:`],
      [],
      detector === stationManifestDetector ? '' : undefined,
    );
  }
  return finish(document.revision, [], [], []);
}
