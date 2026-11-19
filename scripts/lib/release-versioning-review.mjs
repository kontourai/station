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
import { fileURLToPath } from 'node:url';
import assembleReleasePlan from '@changesets/assemble-release-plan';
import { validateConfig } from '@changesets/config';
import { parseChangesetFile } from '@changesets/parse';
import { shouldSkipPackage } from '@changesets/should-skip-package';
import semverSatisfies from 'semver/functions/satisfies.js';
import validRange from 'semver/ranges/valid.js';
import { parse as parseYaml } from 'yaml';
import { execFileSyncBounded } from './bounded-capture.mjs';
import { readGitObjects } from './review-git.mjs';

/** A unit that edits any of these recognises nothing (see the guide). */
const RELEASE_VERSIONING_OWNERS = Object.freeze([
  'scripts/lib/release-versioning-review.mjs',
  'scripts/lib/changeset-note-commits.mjs',
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
function readWorkspace(read, prefetch) {
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
  const relativeDirs = dirs.map((dir) =>
    posix.normalize(dir).replace(/\/$/, ''),
  );
  prefetch(
    'before',
    relativeDirs.map((dir) => `${dir}/package.json`),
  );
  for (const relativeDir of relativeDirs) {
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
function planRelease({ changes, read, listBefore, addedBy, prefetch }) {
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
  // @changesets/read lists the directory through libuv's sorted scandir;
  // that order is the order of the plan and of every changelog block.
  const pending = listed
    .filter(isPendingChangesetNote)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
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
  prefetch('before', [
    'pnpm-workspace.yaml',
    'package.json',
    '.changeset/config.json',
    ...pending,
  ]);
  const workspace = readWorkspace(read, prefetch);
  const configJson = parseJson(
    decode(read('before', '.changeset/config.json')),
  );
  if (!workspace || !configJson)
    return { refused: 'unreadable workspace or config' };
  const { config, errors } = validateConfig(configJson, workspace);
  // Only the dependency-update rules of this config are reproduced.
  if (
    !config ||
    errors?.length ||
    config.ignore.length ||
    config.updateInternalDependencies !== 'patch' ||
    config.bumpVersionsWithWorkspaceProtocolOnly ||
    config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
      ?.onlyUpdatePeerDependentsWhenOutOfRange !== false
  )
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
  // The commit each consumed note's changelog line names
  // (@changesets/git getCommitsThatAddFiles on the starting tree).
  const commits = new Map();
  for (const [file, commit] of addedBy(pending)) {
    if (commit === null)
      return { refused: 'a note’s adding commit cannot be resolved' };
    if (commit) commits.set(posix.basename(file).replace(/\.md$/, ''), commit);
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
  return { workspace, releases, notes, commits };
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

const BUMP_TYPES = ['none', 'patch', 'minor', 'major'];

/**
 * `shouldUpdateDependencyBasedOnConfig` from @changesets/assemble-release-plan
 * for the only supported config (`updateInternalDependencies: "patch"`,
 * `onlyUpdatePeerDependentsWhenOutOfRange: false`). Undefined means a
 * `workspace:` path range this port does not reproduce.
 */
function dependencyUpdates(release, range, depType) {
  if (release.newVersion == null) return false;
  let checked = range;
  if (checked.startsWith('workspace:')) {
    checked = checked.slice('workspace:'.length);
    if (checked === '*') return true;
    if (checked === '^' || checked === '~')
      checked = `${checked}${release.oldVersion}`;
    else if (!validRange(checked)) return undefined;
  }
  if (!semverSatisfies(release.newVersion, checked)) return true;
  if (depType === 'peerDependencies') return true;
  return BUMP_TYPES.indexOf(release.type) >= BUMP_TYPES.indexOf('patch');
}

/** `generateMarkdownForVersionType` from @changesets/apply-release-plan. */
function versionTypeBlock(type, lines) {
  const releaseLines = lines.filter((line) => line);
  if (!releaseLines.length) return undefined;
  let content = `### ${type[0].toUpperCase()}${type.slice(1)} Changes`;
  let newLines = 2;
  for (const line of releaseLines) {
    newLines += line.match(/^\n*/)?.[0].length ?? 0;
    content += '\n'.repeat(Math.min(Math.max(newLines, 1), 2)) + line.trim();
    newLines = line.match(/\n*$/)?.[0].length ?? 0;
  }
  return content;
}

/**
 * The section `changeset version` writes for one release (`getChangelogEntry`
 * with scripts/changeset-changelog.mjs). Every word comes from the planned
 * notes, the plan and the notes' adding commits, so a mismatch in this port
 * can only refuse output, never admit text that is not there.
 */
function expectedSection(release, { releases, notes, commits, packageJson }) {
  const lines = { major: [], minor: [], patch: [] };
  const short = (id) => commits.get(id)?.slice(0, 7);
  for (const [id, note] of notes) {
    const own = note.releases.find(({ name }) => name === release.name);
    if (!own || own.type === 'none') continue;
    const [first, ...rest] = note.summary.split('\n').map((l) => l.trimEnd());
    let line = `- ${short(id) ? `${short(id)}: ` : ''}${first}`;
    if (rest.length)
      line += `\n${rest.map((l) => `  ${l}`.trimEnd()).join('\n')}`;
    lines[own.type].push(line);
  }
  const dependents = [];
  for (const dependency of releases.values()) {
    const range =
      packageJson.dependencies?.[dependency.name] ||
      packageJson.peerDependencies?.[dependency.name];
    if (
      !range ||
      (!range.startsWith('workspace:') && validRange(range) == null)
    )
      continue;
    const updates = dependencyUpdates(
      dependency,
      range,
      packageJson.dependencies?.[dependency.name]
        ? 'dependencies'
        : 'peerDependencies',
    );
    if (updates === undefined) return undefined;
    if (updates) dependents.push(dependency);
  }
  if (dependents.length) {
    const relevant = new Set(
      dependents.flatMap(({ changesets }) => changesets),
    );
    lines.patch.push(
      [
        ...[...notes.keys()]
          .filter((id) => relevant.has(id))
          .map(
            (id) =>
              `- Updated dependencies${short(id) ? ` [${short(id)}]` : ''}`,
          ),
        ...dependents.map(
          ({ name, newVersion }) => `  - ${name}@${newVersion}`,
        ),
      ].join('\n'),
    );
  }
  const rendered = [
    `## ${release.newVersion}`,
    ...RELEASE_TYPES.map((type) => versionTypeBlock(type, lines[type])),
  ].filter((line) => line);
  if (rendered.length === 1) rendered.push('No changes in this release.');
  return rendered.join('\n\n');
}

// Trailing whitespace is tolerated only because version PRs generated before
// scripts/changeset-changelog.mjs carry upstream's indented blank lines.
const withoutTrailingWhitespace = (text) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

/**
 * Whether `after` is `before` with exactly the expected section prepended
 * above its first version heading, as `updateChangelog` writes it.
 */
function isGeneratedChangelog(before, after, expected) {
  if (before === undefined || after === undefined) return false;
  const start = before.search(/^#{1,6}\s+\d+\.\d+/m);
  if (start < 0) return false;
  const prefix = before.slice(0, start);
  const tail = before.slice(start);
  if (
    after.length <= before.length ||
    !after.startsWith(prefix) ||
    !after.endsWith(tail)
  )
    return false;
  const section = after.slice(start, after.length - tail.length);
  return withoutTrailingWhitespace(section) === `${expected}\n\n`;
}

/**
 * Files whose change in one unit is exactly the release-versioning output.
 * @param {{
 *   changes: { status: string, file: string }[],
 *   read: (side: 'before' | 'after', file: string) => Buffer | string | undefined,
 *   listBefore: (dir: string) => string[],
 *   addedBy: (files: string[]) => [string, string | undefined | null][],
 *   prefetch?: (side: 'before' | 'after', files: string[]) => void,
 * }} unit `listBefore` lists tracked files under a directory at the start;
 * `addedBy` gives the full hash of the commit that added a note (undefined
 * when none, null when it cannot be resolved as the CLI would).
 * @returns {{ manifests: Set<string>, changelogs: Set<string>, refused?: string }}
 */
export function releaseVersioningOutputs({
  changes,
  read,
  listBefore,
  addedBy,
  prefetch = () => {},
}) {
  if (
    !changes.some(
      ({ status, file }) => status === 'D' && isPendingChangesetNote(file),
    )
  )
    return NOTHING_CONSUMED;
  const planned = planRelease({ changes, read, listBefore, addedBy, prefetch });
  if (planned.refused) return { ...EMPTY, refused: planned.refused };
  const { workspace, releases, notes, commits } = planned;
  const byDir = new Map(
    workspace.packages.map((pkg) => [pkg.relativeDir, pkg.packageJson.name]),
  );
  const manifests = new Set();
  const changelogs = new Set();
  const outputs = changes
    .filter(({ status, file }) => {
      if (status !== 'M') return false;
      const release = releases.get(byDir.get(posix.dirname(file)));
      return (
        file === 'package.json' ||
        (posix.basename(file) === 'package.json' && release) ||
        (posix.basename(file) === 'CHANGELOG.md' &&
          release &&
          release.type !== 'none')
      );
    })
    .map(({ file }) => file);
  prefetch('before', outputs);
  prefetch('after', outputs);
  for (const file of outputs) {
    const dir = posix.dirname(file);
    const base = posix.basename(file);
    if (base === 'package.json') {
      const name = file === 'package.json' ? undefined : byDir.get(dir);
      const release = name && releases.get(name);
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
      const expected = expectedSection(release, {
        releases,
        notes,
        commits,
        packageJson: workspace.packages.find(
          (pkg) => pkg.packageJson.name === release.name,
        ).packageJson,
      });
      if (
        expected !== undefined &&
        isGeneratedChangelog(
          decode(read('before', file)),
          decode(read('after', file)),
          expected,
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
  const objectSpec = (side, file) =>
    `${side === 'before' ? before : after}:${file}`;
  const prefetch = (side, files) => {
    const specs = [
      ...new Set(files.map((file) => objectSpec(side, file))),
    ].filter((spec) => !cache.has(spec));
    const objects = readGitObjects(root, specs);
    for (const [index, spec] of specs.entries())
      cache.set(spec, objects[index]);
  };
  const read = (side, file) => {
    prefetch(side, [file]);
    return cache.get(objectSpec(side, file));
  };
  const listBefore = (dir) =>
    execFileSyncBounded(
      'git',
      ['ls-tree', '-r', '-z', '--name-only', before, '--', dir],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .split('\0')
      .filter(Boolean);
  const git = (args) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // The CLI deepens a shallow clone to find a root-less adding commit; a
  // shallow checkout here cannot, so such a note is unresolvable.
  const shallow =
    git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const addedBy = (files) => {
    const results = JSON.parse(
      execFileSyncBounded(
        process.execPath,
        [
          fileURLToPath(
            new URL('./changeset-note-commits.mjs', import.meta.url),
          ),
        ],
        {
          cwd: root,
          input: JSON.stringify({ before, files }),
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
    return files.map((file, index) => {
      const [commit, parent] = results[index].split(':');
      return [file, commit ? (!parent && shallow ? null : commit) : undefined];
    });
  };
  return releaseVersioningOutputs({
    changes,
    read,
    listBefore,
    addedBy,
    prefetch,
  });
}
