/**
 * The release-versioning generated-output contract for the documentation
 * review ledger (docs/guides/documentation-review-ledger.md#generated-release-records-and-removed-notes).
 *
 * `npm run version-packages` (`changeset version`) consumes every pending
 * `.changeset/*.md` note and writes mechanical output: manifest version bumps,
 * workspace dependency ranges moved to the new versions, and a new
 * `## <version>` section at the top of each released package's
 * `CHANGELOG.md` assembled from the consumed notes.
 *
 * This module recognises exactly that output within one change unit (a PR's
 * merge base..HEAD, or one landing commit). The trigger is what
 * `changeset version` does: every note `@changesets/read` would read at the
 * unit's start is deleted, nothing else under `.changeset/` changes, every
 * note parses, and the expected releases come from changesets' own planner
 * (`@changesets/assemble-release-plan`) fed the starting tree's manifests,
 * workspace list and config, read from Git. Any other shape, including a
 * unit that edits this contract's owners, recognises nothing and keeps
 * needing review notes. It proves shape and provenance, not that the notes
 * are accurate or that anything was published.
 */
import { posix } from 'node:path';
import assembleReleasePlan from '@changesets/assemble-release-plan';
import { validateConfig } from '@changesets/config';
import { parseChangesetFile } from '@changesets/parse';
import { shouldSkipPackage } from '@changesets/should-skip-package';
import { parse as parseYaml } from 'yaml';
import { execFileSyncBounded } from './bounded-capture.mjs';
import { readGitObjects } from './review-git.mjs';

/** A unit that edits any of these recognises nothing (see the guide). */
const RELEASE_VERSIONING_OWNERS = Object.freeze([
  'scripts/lib/release-versioning-review.mjs',
  'scripts/changeset-changelog.mjs',
  '.changeset/config.json',
]);
const CHANGESET_DIR = '.changeset/';
// @changesets/read 1.x: `.md` files in `.changeset/` and `.changeset/pre/`,
// skipping dotfiles and these names.
const UNREAD_NOTES = [/^README\.md$/i, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const VERSION_LINE = /^( {2})"version": "([^"\\]*)"(,?)$/;
const DEPENDENCY_LINE_TEXT = /^( {4})"([^"\\]+)": "([^"\\]*)"(,?)$/;
const RANGE = /^([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const RELEASE_TYPES = ['major', 'minor', 'patch'];
const RELEASE_HEADER = /^### (Major|Minor|Patch) Changes$/;
const DEPENDENCY_LINE = /^Updated dependencies(?: \[[0-9a-f]{7}\])?$/;
const DEPENDENCY_ITEM = /^- (.+)@([^@\s]+)$/;
const COMMIT_PREFIX = /^[0-9a-f]{7}: /;
const EMPTY = Object.freeze({ manifests: new Set(), changelogs: new Set() });
const NOTHING_CONSUMED = Object.freeze({
  ...EMPTY,
  refused: 'the change consumes no pending note',
});
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function decode(bytes) {
  if (bytes === undefined) return undefined;
  try {
    return typeof bytes === 'string' ? bytes : utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text) {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `@changesets/read` reads this tracked path as a pending note. */
function isPendingChangesetNote(file) {
  if (!file.startsWith(CHANGESET_DIR)) return false;
  const rest = file.slice(CHANGESET_DIR.length);
  const parts = rest.split('/');
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'pre'))
    return false;
  const name = parts.at(-1);
  return (
    !name.startsWith('.') &&
    name.endsWith('.md') &&
    !UNREAD_NOTES.some((pattern) =>
      typeof pattern === 'string' ? pattern === name : pattern.test(name),
    )
  );
}

/** The workspace as `@manypkg/get-packages` sees it, from the starting tree. */
function readWorkspace(read) {
  let listed;
  try {
    listed = parseYaml(decode(read('before', 'pnpm-workspace.yaml')) ?? '');
  } catch {
    return undefined;
  }
  const dirs = listed?.packages;
  // Only exact directories are reproduced; a glob or negation recognises nothing.
  if (
    !Array.isArray(dirs) ||
    dirs.some((dir) => typeof dir !== 'string' || /[*?![\]{}]/.test(dir))
  )
    return undefined;
  const rootJson = parseJson(decode(read('before', 'package.json')));
  if (!rootJson) return undefined;
  const ROOT = '/workspace';
  const packages = [];
  for (const dir of dirs) {
    const relativeDir = posix.normalize(dir).replace(/\/$/, '');
    const packageJson = parseJson(
      decode(read('before', `${relativeDir}/package.json`)),
    );
    if (!packageJson || typeof packageJson.name !== 'string') return undefined;
    packages.push({ dir: `${ROOT}/${relativeDir}`, relativeDir, packageJson });
  }
  return {
    rootDir: ROOT,
    tool: 'pnpm',
    rootPackage: { dir: ROOT, relativeDir: '.', packageJson: rootJson },
    packages,
  };
}

/**
 * The release plan `changeset version` would apply at the unit's start, or
 * undefined when this unit is not exactly that operation.
 */
function planRelease({ changes, read, listBefore }) {
  if (
    changes.some(({ file }) => RELEASE_VERSIONING_OWNERS.includes(file)) ||
    changes.some(
      ({ status, file }) =>
        file.startsWith(CHANGESET_DIR) &&
        !(status === 'D' && isPendingChangesetNote(file)),
    )
  )
    return {
      refused:
        'the change edits a contract owner or a non-note .changeset file',
    };
  const listed = listBefore(CHANGESET_DIR);
  const pending = listed.filter(isPendingChangesetNote);
  const deleted = new Set(
    changes.filter(({ status }) => status === 'D').map(({ file }) => file),
  );
  // Pre mode keeps consumed notes; this contract reproduces only normal mode.
  if (
    !pending.length ||
    listed.some(
      (file) =>
        file === '.changeset/pre.json' || file.startsWith('.changeset/pre/'),
    )
  )
    return { refused: 'no pending notes, or pre mode' };
  const workspace = readWorkspace(read);
  const configJson = parseJson(
    decode(read('before', '.changeset/config.json')),
  );
  if (!workspace || !configJson)
    return { refused: 'unreadable workspace or config' };
  const { config, errors } = validateConfig(configJson, workspace);
  if (!config || errors?.length || config.ignore.length)
    return { refused: 'unsupported changesets config' };
  const byName = new Map(
    workspace.packages.map((pkg) => [pkg.packageJson.name, pkg]),
  );
  const skipped = (name) =>
    shouldSkipPackage(byName.get(name), {
      ignore: config.ignore,
      allowPrivatePackages: config.privatePackages.version,
    });
  const notes = new Map();
  for (const file of pending) {
    let note;
    try {
      note = parseChangesetFile(decode(read('before', file)) ?? '');
    } catch {
      return { refused: 'a pending note does not parse' };
    }
    if (note.releases.some(({ name }) => !byName.has(name)))
      return { refused: 'a note names a package outside the workspace' };
    // apply-release-plan deletes exactly the notes naming no skipped
    // (private or ignored) package and keeps the rest untouched.
    if (deleted.has(file) === note.releases.some(({ name }) => skipped(name)))
      return {
        refused: 'the deleted notes are not the set changeset version deletes',
      };
    notes.set(posix.basename(file).replace(/\.md$/, ''), note);
  }
  let plan;
  try {
    plan = assembleReleasePlan(
      [...notes].map(([id, note]) => ({ ...note, id })),
      workspace,
      config,
      undefined,
    );
  } catch {
    return { refused: 'the release planner refused the notes' };
  }
  const releases = new Map(
    plan.releases.map((release) => [release.name, release]),
  );
  if (![...releases.values()].some(({ type }) => type !== 'none'))
    return { refused: 'the plan versions nothing' };
  return { workspace, releases, notes };
}

/**
 * Whether the manifest's only edits are its planned version and dependency
 * ranges moved to planned versions, line for line: no other byte changes.
 */
function isPlannedManifest(beforeText, afterText, { release, releases }) {
  const before = parseJson(beforeText);
  const after = parseJson(afterText);
  if (!before || !after || before.name !== after.name) return false;
  const versioned = (name) => {
    const planned = releases.get(name);
    return planned && planned.type !== 'none' ? planned : undefined;
  };
  const target = release && release.type !== 'none' ? release : undefined;
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  if (a.length !== b.length) return false;
  const expected = structuredClone(before);
  let edits = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    const version = [VERSION_LINE.exec(a[index]), VERSION_LINE.exec(b[index])];
    if (version[0] && version[1]) {
      if (
        !target ||
        version[0][3] !== version[1][3] ||
        version[0][2] !== target.oldVersion ||
        version[1][2] !== target.newVersion
      )
        return false;
      expected.version = target.newVersion;
      edits += 1;
      continue;
    }
    const range = [
      DEPENDENCY_LINE_TEXT.exec(a[index]),
      DEPENDENCY_LINE_TEXT.exec(b[index]),
    ];
    const dependency = range[0] && versioned(range[0][2]);
    const from = range[0] && RANGE.exec(range[0][3]);
    if (
      !range[1] ||
      !dependency ||
      !from ||
      range[0][2] !== range[1][2] ||
      range[0][4] !== range[1][4] ||
      range[1][3] !== `${from[1]}${dependency.newVersion}`
    )
      return false;
    for (const field of DEPENDENCY_FIELDS)
      if (expected[field]?.[range[0][2]] === range[0][3])
        expected[field][range[0][2]] = range[1][3];
    edits += 1;
  }
  // A planned version must actually be written.
  if (target && expected.version !== target.newVersion) return false;
  return edits > 0 && JSON.stringify(expected) === JSON.stringify(after);
}

/** Parse a generated release section into its typed blocks of entries. */
function parseReleaseSection(body, version) {
  const lines = body.split('\n');
  if (lines[0] !== `## ${version}` || lines[1] !== '') return undefined;
  if (lines.length === 3 && lines[2] === 'No changes in this release.')
    return new Map();
  const blocks = new Map();
  let rank = -1;
  let entries;
  let entry;
  for (let index = 2; index < lines.length; index += 1) {
    const line = lines[index];
    const header = RELEASE_HEADER.exec(line);
    if (header) {
      const type = header[1].toLowerCase();
      const next = RELEASE_TYPES.indexOf(type);
      if (next <= rank || lines[index + 1] !== '') return undefined;
      if (index > 2) {
        // Blocks are separated by exactly one blank line.
        if (entry?.rest.at(-1) !== '') return undefined;
        entry.rest.pop();
      }
      rank = next;
      entries = [];
      blocks.set(type, entries);
      entry = undefined;
      index += 1;
      continue;
    }
    if (!entries) return undefined;
    if (line.startsWith('- ')) {
      entry = { first: line.slice(2).trimEnd(), rest: [] };
      entries.push(entry);
    } else if (!entry) return undefined;
    else if (!line.trim()) entry.rest.push('');
    else if (line.startsWith('  ')) entry.rest.push(line.slice(2).trimEnd());
    else return undefined;
  }
  for (const block of blocks.values()) if (!block.length) return undefined;
  if (entry && entry.rest.at(-1) === '') return undefined;
  return blocks;
}

const sameLines = (a, b) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * Whether `after` is `before` with one new section for the planned version
 * prepended above its first version heading, and every entry in it is either
 * a planned note's summary for this package at its bump type or a
 * dependency-update line naming planned packages at their new versions.
 */
function isGeneratedChangelog(before, after, { release, releases, notes }) {
  if (before === undefined || after === undefined) return false;
  const start = before.search(/^#{1,6}\s+\d+\.\d+/m);
  if (start < 0) return false;
  const prefix = before.slice(0, start);
  const tail = before.slice(start);
  if (
    after.length <= before.length ||
    !after.startsWith(prefix) ||
    !after.endsWith(tail) ||
    prefix.trim() !== `# ${release.name}`
  )
    return false;
  const section = after.slice(start, after.length - tail.length);
  if (!section.endsWith('\n\n')) return false;
  const blocks = parseReleaseSection(section.slice(0, -2), release.newVersion);
  if (!blocks) return false;
  const expected = release.changesets
    .map((id) => notes.get(id))
    .map((note) => ({
      type: note?.releases.find(({ name }) => name === release.name)?.type,
      summary: (note?.summary ?? '').split('\n').map((line) => line.trimEnd()),
    }))
    .filter(({ type }) => RELEASE_TYPES.includes(type));
  const used = new Set();
  for (const [type, entries] of blocks)
    for (const entry of entries) {
      const index = expected.findIndex(
        (candidate, position) =>
          !used.has(position) &&
          candidate.type === type &&
          [entry.first, entry.first.replace(COMMIT_PREFIX, '')].some((first) =>
            sameLines(candidate.summary, [first, ...entry.rest]),
          ),
      );
      if (index >= 0) {
        used.add(index);
        continue;
      }
      if (type !== 'patch') return false;
      // With no dependency notes upstream writes only the list, and the
      // block's trim takes the first item's indent.
      const items = DEPENDENCY_LINE.test(entry.first)
        ? entry.rest
        : [`- ${entry.first}`, ...entry.rest];
      for (const item of items) {
        const dependency = DEPENDENCY_ITEM.exec(item);
        if (
          !dependency ||
          releases.get(dependency[1])?.newVersion !== dependency[2]
        )
          return false;
      }
    }
  return used.size === expected.length;
}

/**
 * Files whose change in one unit is exactly the release-versioning output.
 * @param {{
 *   changes: { status: string, file: string }[],
 *   read: (side: 'before' | 'after', file: string) => Buffer | string | undefined,
 *   listBefore: (dir: string) => string[],
 * }} unit `listBefore` lists tracked files under a directory at the start.
 * @returns {{ manifests: Set<string>, changelogs: Set<string>, refused?: string }}
 */
export function releaseVersioningOutputs({ changes, read, listBefore }) {
  if (
    !changes.some(
      ({ status, file }) => status === 'D' && isPendingChangesetNote(file),
    )
  )
    return NOTHING_CONSUMED;
  const planned = planRelease({ changes, read, listBefore });
  if (planned.refused) return { ...EMPTY, refused: planned.refused };
  const { workspace, releases, notes } = planned;
  const byDir = new Map(
    workspace.packages.map((pkg) => [pkg.relativeDir, pkg.packageJson.name]),
  );
  const manifests = new Set();
  const changelogs = new Set();
  for (const { status, file } of changes) {
    if (status !== 'M') continue;
    const dir = posix.dirname(file);
    const base = posix.basename(file);
    if (base === 'package.json') {
      const name = file === 'package.json' ? undefined : byDir.get(dir);
      const release = name && releases.get(name);
      // Root ranges move too; any other manifest must be a planned package.
      if (file !== 'package.json' && !release) continue;
      if (
        isPlannedManifest(
          decode(read('before', file)),
          decode(read('after', file)),
          { release, releases },
        )
      )
        manifests.add(file);
    } else if (base === 'CHANGELOG.md') {
      const release = releases.get(byDir.get(dir));
      if (!release || release.type === 'none') continue;
      if (
        isGeneratedChangelog(
          decode(read('before', file)),
          decode(read('after', file)),
          { release, releases, notes },
        )
      )
        changelogs.add(file);
    }
  }
  // All or nothing: a unit that holds only part of the planned output, or
  // edits it, is not `changeset version` output.
  const dirs = new Map([...byDir].map(([dir, name]) => [name, dir]));
  for (const release of releases.values())
    if (
      release.type !== 'none' &&
      (!manifests.has(`${dirs.get(release.name)}/package.json`) ||
        !changelogs.has(`${dirs.get(release.name)}/CHANGELOG.md`))
    )
      return {
        ...EMPTY,
        refused: `${release.name} is missing its exact planned manifest or changelog`,
      };
  return { manifests, changelogs };
}

/** {@link releaseVersioningOutputs} for the change between two Git revisions. */
export function releaseVersioningOutputsBetween(root, before, after, changes) {
  if (
    !changes.some(
      ({ status, file }) => status === 'D' && isPendingChangesetNote(file),
    )
  )
    return NOTHING_CONSUMED;
  const cache = new Map();
  const read = (side, file) => {
    const spec = `${side === 'before' ? before : after}:${file}`;
    if (!cache.has(spec)) cache.set(spec, readGitObjects(root, [spec])[0]);
    return cache.get(spec);
  };
  const listBefore = (dir) =>
    execFileSyncBounded(
      'git',
      ['ls-tree', '-r', '-z', '--name-only', before, '--', dir],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .split('\0')
      .filter(Boolean);
  return releaseVersioningOutputs({ changes, read, listBefore });
}
