/**
 * The release-versioning generated-output contract for the documentation
 * review ledger (docs/guides/documentation-review-ledger.md#generated-release-records-and-removed-notes).
 *
 * `npm run version-packages` (`changeset version`) consumes `.changeset/*.md`
 * notes and writes two kinds of mechanical output: package manifest version
 * bumps, with workspace dependency ranges moved to the new versions, and a
 * new `## <version>` section at the top of each released package's
 * `CHANGELOG.md` assembled from the consumed notes. Neither changes a claim a
 * reviewer has not already reviewed: the version is not a documented claim
 * unless a record cites it by value (`package.json#/version`), and the
 * changelog prose is the consumed notes' own text.
 *
 * This module recognises exactly that output within one change unit (a PR's
 * merge base..HEAD, or one landing commit) and nothing else. A unit that
 * consumes no changeset, a manifest with any other edit, or a changelog
 * section with any text not traceable to a consumed note, a different
 * version, or an edited older tail is not recognised and keeps needing a
 * review note. It proves shape and provenance, not that the notes are
 * accurate or that anything was published.
 */
import { posix } from 'node:path';
import { readGitObjects } from './review-git.mjs';

const CHANGESET_NOTE = /^\.changeset\/[^/]+\.md$/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^([\^~]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const RELEASE_TYPES = ['major', 'minor', 'patch'];
const RELEASE_HEADER = /^### (Major|Minor|Patch) Changes$/;
const DEPENDENCY_LINE = /^Updated dependencies(?: \[[0-9a-f]{7}\])?$/;
const DEPENDENCY_ITEM = /^- (.+)@([^@\s]+)$/;
const COMMIT_PREFIX = /^[0-9a-f]{7}: /;
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

function parseJson(bytes) {
  const text = decode(bytes);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A consumed note's releases and summary, or undefined when unreadable. */
function parseChangesetNote(bytes) {
  const text = decode(bytes);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end < 0) return undefined;
  const releases = new Map();
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const match =
      /^\s*(?:"([^"]+)"|'([^']+)'|([^\s"':][^:]*?))\s*:\s*(major|minor|patch|none)\s*$/.exec(
        line,
      );
    if (!match) return undefined;
    const name = match[1] ?? match[2] ?? match[3];
    if (releases.has(name)) return undefined;
    releases.set(name, match[4]);
  }
  const summary = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  return { releases, summary: summary.split('\n').map((l) => l.trimEnd()) };
}

/**
 * Whether `after` is `before` with only its version bumped and workspace
 * dependency ranges moved to bumped packages' new versions.
 */
function isManifestBump(before, after, bumped) {
  if (!before || !after || before.name !== after.name) return false;
  const expected = structuredClone(before);
  let edits = 0;
  if (before.version !== after.version) {
    if (bumped.get(after.name)?.to !== after.version) return false;
    expected.version = after.version;
    edits += 1;
  }
  for (const field of DEPENDENCY_FIELDS) {
    if (!isObject(before[field]) || !isObject(after[field])) continue;
    for (const name of Object.keys(before[field])) {
      const from = before[field][name];
      const to = after[field][name];
      if (from === to) continue;
      const range = typeof from === 'string' ? RANGE.exec(from) : null;
      const target = bumped.get(name)?.to;
      if (!range || !target || to !== `${range[1]}${target}`) return false;
      expected[field][name] = to;
      edits += 1;
    }
  }
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
 * Whether `after` is `before` with one new section for `version` prepended
 * above its first version heading, and every entry in that section is either
 * a consumed note's summary for this package at its bump type or a
 * dependency-update line naming bumped packages at their new versions.
 */
function isGeneratedChangelog(before, after, { name, version, notes, bumped }) {
  if (before === undefined || after === undefined) return false;
  const start = before.search(/^#{1,6}\s+\d+\.\d+/m);
  if (start < 0) return false;
  const prefix = before.slice(0, start);
  const tail = before.slice(start);
  if (
    after.length <= before.length ||
    !after.startsWith(prefix) ||
    !after.endsWith(tail) ||
    prefix.trim() !== `# ${name}`
  )
    return false;
  const section = after.slice(start, after.length - tail.length);
  if (!section.endsWith('\n\n')) return false;
  const blocks = parseReleaseSection(section.slice(0, -2), version);
  if (!blocks) return false;
  const expected = notes
    .map((note) => ({ type: note.releases.get(name), summary: note.summary }))
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
      if (type !== 'patch' || !DEPENDENCY_LINE.test(entry.first)) return false;
      for (const item of entry.rest) {
        const dependency = DEPENDENCY_ITEM.exec(item);
        if (!dependency || bumped.get(dependency[1])?.to !== dependency[2])
          return false;
      }
    }
  return used.size === expected.length;
}

/**
 * Files whose change in one unit is exactly the release-versioning output.
 * @param {{ changes: { status: string, file: string }[], read: (side: 'before' | 'after', file: string) => Buffer | string | undefined }} unit
 * @returns {{ manifests: Set<string>, changelogs: Set<string> }}
 */
export function releaseVersioningOutputs({ changes, read }) {
  const manifests = new Set();
  const changelogs = new Set();
  const consumed = changes.filter(
    ({ status, file }) => status === 'D' && CHANGESET_NOTE.test(file),
  );
  if (!consumed.length) return { manifests, changelogs };
  const notes = consumed.map(({ file }) =>
    parseChangesetNote(read('before', file)),
  );
  // An unreadable consumed note makes every changelog untraceable.
  const readable = notes.every(Boolean);
  const modified = changes.filter(({ status }) => status === 'M');
  const manifestFiles = modified
    .map(({ file }) => file)
    .filter((file) => posix.basename(file) === 'package.json');
  const parsed = new Map(
    manifestFiles.map((file) => [
      file,
      {
        before: parseJson(read('before', file)),
        after: parseJson(read('after', file)),
      },
    ]),
  );
  const bumped = new Map();
  for (const { before, after } of parsed.values())
    if (
      before &&
      after &&
      typeof after.name === 'string' &&
      before.name === after.name &&
      VERSION.test(String(before.version)) &&
      VERSION.test(String(after.version)) &&
      before.version !== after.version
    )
      bumped.set(after.name, { from: before.version, to: after.version });
  for (const [file, { before, after }] of parsed)
    if (isManifestBump(before, after, bumped)) manifests.add(file);
  if (!readable) return { manifests, changelogs };
  for (const { file } of modified) {
    if (posix.basename(file) !== 'CHANGELOG.md') continue;
    const manifest = parsed.get(
      posix.join(posix.dirname(file), 'package.json'),
    );
    const release = manifest?.after && bumped.get(manifest.after.name);
    if (!release || release.to !== manifest.after.version) continue;
    if (
      isGeneratedChangelog(
        decode(read('before', file)),
        decode(read('after', file)),
        { name: manifest.after.name, version: release.to, notes, bumped },
      )
    )
      changelogs.add(file);
  }
  return { manifests, changelogs };
}

/** {@link releaseVersioningOutputs} for the change between two Git revisions. */
export function releaseVersioningOutputsBetween(root, before, after, changes) {
  const wanted = changes.filter(
    ({ status, file }) =>
      (status === 'D' && CHANGESET_NOTE.test(file)) ||
      (status === 'M' &&
        ['package.json', 'CHANGELOG.md'].includes(posix.basename(file))),
  );
  if (!wanted.some(({ status }) => status === 'D'))
    return { manifests: new Set(), changelogs: new Set() };
  const specs = wanted.flatMap(({ status, file }) =>
    status === 'D'
      ? [`${before}:${file}`]
      : [`${before}:${file}`, `${after}:${file}`],
  );
  const objects = new Map(
    readGitObjects(root, specs).map((bytes, index) => [specs[index], bytes]),
  );
  return releaseVersioningOutputs({
    changes: wanted,
    read: (side, file) =>
      objects.get(`${side === 'before' ? before : after}:${file}`),
  });
}
