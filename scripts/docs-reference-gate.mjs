/**
 * Docs reference gate — every repo path a live document names must exist.
 *
 * Docs drift silently: a file gets renamed and the guide that points at it
 * keeps looking authoritative. This pass found docs/guides/testing.md
 * documenting two test-utility modules that did not exist (with code samples
 * importing them), and docs/guides/agents.md prescribing a `scripts/test-layout.sh`
 * that had been deleted — while also contradicting the repo's own rule to drive
 * everything through `./station`.
 *
 * Scope is *live* documentation only. Dogfood reports, strategy records, plans
 * and delivery bundles describe the tree as it was at the time; they are
 * history, and rewriting them would be falsifying a record.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';

const ROOT = process.cwd();

/** Live docs. Everything else under docs/ is a historical record. */
export const LIVE_DOC_DIRECTORIES = [
  'docs/guides',
  'docs/reference',
  'docs/architecture',
  'docs/patterns',
  'docs/design',
  'docs/contexts',
  'docs/adr',
];

export const LIVE_DOC_FILES = [
  'docs/architecture.md',
  'docs/glossary.md',
  'docs/README.md',
  'README.md',
  'AGENTS.md',
  'CONTEXT.md',
  'CONTEXT-MAP.md',
  'SECURITY.md',
];

export function describeLiveDocScope() {
  return (
    `${LIVE_DOC_DIRECTORIES.length} recursive tracked directory scope(s) ` +
    `(${LIVE_DOC_DIRECTORIES.join(', ')}); ${LIVE_DOC_FILES.length} named file scope(s) ` +
    `(${LIVE_DOC_FILES.join(', ')})`
  );
}

/** Directories whose paths look repo-local but are not. */
const SOURCE_ROOTS =
  /^(src-server|src-ui|packages|scripts|tests|examples|kits|schemas|src-desktop|src-shared)\//;
// Live-doc inventory: :line, :start-end, and comma-separated combinations of
// those spans (for example :106,151-163). No line:column form is currently
// documented, so accepting one would silently widen the contract.
const SOURCE_LOCATION_SUFFIX =
  /:([1-9][0-9]*(?:-[1-9][0-9]*)?(?:,[1-9][0-9]*(?:-[1-9][0-9]*)?)*)$/;

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function isGlobPath(path) {
  return ['?', '*', '[', ']', '{', '}'].some((character) =>
    path.includes(character),
  );
}

/**
 * Paths that legitimately do not exist, each with the reason. An entry here is
 * a claim that the reference is correct as written — not a way to silence a
 * broken link.
 */
export const ALLOWED_MISSING = new Map([
  [
    'src-server/services/flow/producer-pin.ts',
    'retired by the 2026-08-26 supersession (#4414): Flow 5.1 enforces the producer pin natively; ADR-0011 names the file as history',
  ],
  [
    'tests/screenshots.baseline/<name>.png',
    'placeholder path pattern in the screenshot-baseline guide, not a literal file',
  ],
  [
    'packages/cli/dist',
    'gitignored CLI bundle output — absent in fresh checkouts (bare-directory reference in cli.md)',
  ],
  [
    'packages/cli/dist/',
    'gitignored CLI bundle output — test-full creates it, so it is absent in fresh checkouts',
  ],
  [
    'packages/cli/dist/station.mjs',
    'gitignored CLI bundle output (#948) — built by the packaging step, absent in fresh checkouts',
  ],
  [
    'packages/connect/dist',
    'gitignored Connect package output — rebuilt by prepush and static verification lanes, absent in fresh checkouts',
  ],
  [
    'kits/knowledge/docs/store-contract.md',
    'ships inside the installed @kontourai/flow-agents package, not this repo',
  ],
  [
    'schemas/backlog-provider-settings.schema.json',
    'published by @kontourai/flow-agents, not this repo',
  ],
  [
    'src-server/providers/types.ts',
    'referenced only in statements that it was removed during convergence',
  ],
  [
    'examples/meeting-notes/src/api.ts',
    'referenced only in the record of its own deletion in a Wave 3 cleanup',
  ],
  [
    'src-desktop/gen/android/app/build/outputs/apk/universal/debug/',
    'Android build output, absent until built',
  ],
  ['src-desktop/target/', 'Cargo build output, absent until built'],
]);

/**
 * Normalizes an in-repo path optionally followed by the documented :line or
 * :line-line location suffix. Any other colon-bearing source-root reference is
 * a malformed path-like claim, not something to silently ignore.
 */
export function normalizeReferencedPath(reference) {
  const path = reference.replace(/[.,)]+$/, '');
  if (!SOURCE_ROOTS.test(path)) return null;
  // A glob names a class of paths, not one repo path that this gate can check
  // with existsSync. Treat its syntax explicitly instead of mistaking it for a
  // broken concrete reference; malformed concrete colon suffixes still throw.
  if (isGlobPath(path)) return null;
  if (containsControlCharacter(path)) {
    throw new Error('Source-path reference contains a control character.');
  }
  if (!path.includes(':')) return path;
  const location = SOURCE_LOCATION_SUFFIX.exec(path);
  if (!location) {
    throw new Error(`Unsupported source-path location reference '${path}'.`);
  }
  const basePath = path.slice(0, -location[0].length);
  if (basePath.includes(':')) {
    throw new Error(`Unsupported source-path location reference '${path}'.`);
  }
  if (!SOURCE_ROOTS.test(basePath)) {
    throw new Error(
      `Source-path location reference has no repo path '${path}'.`,
    );
  }
  return basePath;
}

function referencedLinkDestination(destination) {
  if (destination.startsWith('<')) {
    if (!destination.endsWith('>')) {
      throw new Error(
        'Inline link destination has an unmatched angle bracket.',
      );
    }
    const path = destination.slice(1, -1);
    if (path.length === 0 || containsControlCharacter(path)) {
      throw new Error(
        'Inline link destination is empty or contains a control character.',
      );
    }
    return path;
  }
  if (SOURCE_ROOTS.test(destination) && /\s/.test(destination)) {
    throw new Error(
      'Source-path link destinations with spaces require CommonMark angle brackets.',
    );
  }
  return destination;
}

function referencedCodeSpan(reference) {
  if (!SOURCE_ROOTS.test(reference)) return reference;
  if (isGlobPath(reference)) return null;
  if (containsControlCharacter(reference)) {
    throw new Error('Concrete source-path code span contains a line break.');
  }
  return reference;
}

/** Backticked code and inline-link repo paths in a markdown body. */
export function referencedPaths(markdown) {
  const found = new Set();
  const references = [
    ...[...markdown.matchAll(/`([^`]*)`/g)].map((match) => [
      match[0],
      referencedCodeSpan(match[1]),
    ]),
    ...[...markdown.matchAll(/\[[^\]\r\n]*\]\(([\s\S]*?)\)/g)].map((match) => [
      match[0],
      referencedLinkDestination(match[1]),
    ]),
  ];
  for (const match of references) {
    if (match[1] === null) continue;
    const path = normalizeReferencedPath(match[1]);
    if (path !== null) found.add(path);
  }
  return [...found];
}

export function findBrokenReferences(
  files,
  exists = existsSync,
  read = readFileSync,
) {
  const broken = new Map();
  for (const file of files) {
    for (const path of referencedPaths(read(file, 'utf8'))) {
      if (exists(path) || ALLOWED_MISSING.has(path)) continue;
      if (!broken.has(path)) broken.set(path, new Set());
      broken.get(path).add(file);
    }
  }
  return broken;
}

function scopeForLiveDoc(path) {
  if (LIVE_DOC_FILES.includes(path)) return 'named file';
  return LIVE_DOC_DIRECTORIES.find((directory) =>
    path.startsWith(`${directory}/`),
  );
}

function assertCanonicalTrackedPath(path) {
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    containsControlCharacter(path) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..',
    ) ||
    posix.normalize(path) !== path
  ) {
    throw new Error(
      `Live-doc discovery returned non-canonical path '${path}'.`,
    );
  }
}

function decodeNulDelimitedPaths(output) {
  if (!Buffer.isBuffer(output)) {
    throw new Error('Live-doc discovery did not return Buffer output.');
  }
  if (output.length === 0) {
    throw new Error('Live-doc discovery returned no paths.');
  }
  if (output.at(-1) !== 0) {
    throw new Error('Live-doc discovery output is missing its terminal NUL.');
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw new Error('Live-doc discovery output is not valid UTF-8.');
  }
  const paths = decoded.split('\0');
  paths.pop();
  if (paths.length === 0 || (paths.length === 1 && paths[0] === '')) {
    throw new Error('Live-doc discovery returned no paths.');
  }
  if (paths.some((path) => path.length === 0)) {
    throw new Error('Live-doc discovery output contains an empty path entry.');
  }
  const seen = new Set();
  for (const path of paths) {
    assertCanonicalTrackedPath(path);
    if (seen.has(path)) {
      throw new Error(`Live-doc discovery returned duplicate path '${path}'.`);
    }
    seen.add(path);
    if (!scopeForLiveDoc(path)) {
      throw new Error(
        `Live-doc discovery returned out-of-scope path '${path}'.`,
      );
    }
  }
  for (const file of LIVE_DOC_FILES) {
    if (!seen.has(file)) {
      throw new Error(`Live-doc discovery is missing required file '${file}'.`);
    }
  }
  const liveDocs = paths.filter(
    (path) => path.endsWith('.md') || LIVE_DOC_FILES.includes(path),
  );
  for (const directory of LIVE_DOC_DIRECTORIES) {
    if (!liveDocs.some((path) => path.startsWith(`${directory}/`))) {
      throw new Error(
        `Live-doc discovery is missing Markdown files for directory '${directory}'.`,
      );
    }
  }
  return liveDocs;
}

export function liveDocs({
  root = ROOT,
  runGit = execFileSync,
  stat = statSync,
} = {}) {
  for (const directory of LIVE_DOC_DIRECTORIES) {
    let directoryStat;
    try {
      directoryStat = stat(`${root}/${directory}`);
    } catch {
      throw new Error(
        `Live-doc discovery could not inspect required directory '${directory}'.`,
      );
    }
    if (!directoryStat.isDirectory()) {
      throw new Error(`Live-doc discovery requires directory '${directory}'.`);
    }
  }
  let output;
  try {
    output = runGit(
      'git',
      ['ls-files', '-z', '--', ...LIVE_DOC_DIRECTORIES, ...LIVE_DOC_FILES],
      { cwd: root, encoding: 'buffer' },
    );
  } catch {
    throw new Error('Live-doc discovery could not enumerate tracked files.');
  }
  return decodeNulDelimitedPaths(output);
}

export function runDocsReferenceGate({
  discover = liveDocs,
  writeError = console.error,
  writeOutput = console.log,
} = {}) {
  let files;
  try {
    files = discover();
  } catch {
    writeError('\nFAIL: could not enumerate the required live-document scope.');
    return 1;
  }
  writeOutput(
    `\nDocs reference gate (${files.length} live documents; scope: ${describeLiveDocScope()}; historical records are out of scope).`,
  );

  let broken;
  try {
    broken = findBrokenReferences(files);
  } catch {
    writeError('\nFAIL: live docs contain a malformed repo-path reference.');
    return 1;
  }
  if (broken.size > 0) {
    writeError(
      `\nFAIL: ${broken.size} path(s) named in live docs do not exist.`,
    );
    for (const [path, sources] of broken) {
      writeError(`  ${path}`);
      for (const source of sources) writeError(`      <- ${source}`);
    }
    writeError(
      '\nFix the document, or — if the path is correct as written (owned by a\n' +
        'dependency, a build output, or named only as something removed) — add it\n' +
        'to ALLOWED_MISSING in scripts/docs-reference-gate.mjs with the reason.',
    );
    return 1;
  }

  // A stale allowlist entry is its own kind of rot.
  const resurrected = [...ALLOWED_MISSING.keys()].filter((p) => existsSync(p));
  for (const path of resurrected) {
    writeOutput(
      `  note: ${path} now exists — its ALLOWED_MISSING entry can go.`,
    );
  }

  writeOutput(
    `OK: every repo path named in ${files.length} live docs resolves (scope: ${describeLiveDocScope()}; ${ALLOWED_MISSING.size} documented exceptions).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runDocsReferenceGate();
}
