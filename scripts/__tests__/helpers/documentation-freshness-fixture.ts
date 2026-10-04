/**
 * Shared Git fixtures and CLI runners for the documentation freshness and
 * review-notes suites. Importing it registers per-test temp-dir cleanup.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import {
  listReviewLedgerFiles,
  REVIEW_LEDGER_DIR,
  readReviewState,
  recordFile,
  serializeRecordFile,
} from '../../lib/review-ledger-store.mjs';
import { pinnedFreshnessEnv } from './freshness-env.js';
import {
  type FixtureRecord,
  writeLearningMedia,
  writeReviewLedger,
} from './review-ledger-fixture.js';

export const makeTempDir = trackTempDirs();
export const scripts = resolve(import.meta.dirname, '../..');
export const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=',
  'base64',
);
export const MEDIA = 'docs/learn/media.json';

/**
 * Fixture Git commands must not inherit this checkout's Git location. Built at
 * call time, after the ambient mode is stubbed, so reusing it for a spawned
 * check leaks the forbidden mode and fails on every host.
 */
export const gitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

export function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export const identity = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'core.hooksPath=/dev/null',
];

export function commit(root: string, message: string) {
  git(root, ['add', '-A']);
  git(root, [...identity, 'commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** `git merge` with the default driver and no custom configuration. */
export function merge(root: string, ref: string) {
  return spawnSync('git', [...identity, 'merge', '--no-edit', ref], {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function record(
  path: string,
  sources: [string, string][],
  doc: string,
): FixtureRecord {
  return {
    path,
    documentDigest: hash(doc),
    kind: 'current',
    state: 'source-reviewed',
    summary: 'Checked the caller.',
    limits: 'Fixture review only.',
    sources: sources.map(([source, text]) => ({
      path: source,
      digest: hash(text),
    })),
    checks: ['Fixture evidence.'],
  };
}

// src/c.ts and src/d.ts are cited only by docs/map.md, a shared page like the
// module map. src/c.ts has room between its lines, so edits at either end
// merge cleanly as source while their reviews must still meet.
export const SHARED_C =
  'export const c1 = 1;\n// one\n// two\n// three\nexport const c2 = 1;\n';

// A broad manifest that docs/pkg.md cites by one value, not as a whole.
const PACKAGE_JSON = `${JSON.stringify(
  { scripts: { docs: 'node docs.mjs', other: 'node other.mjs' } },
  null,
  2,
)}\n`;

/** A main branch whose records and one capture are fresh and verifiable. */
export function fixture({
  commitIt = true,
  makeDir = makeTempDir,
}: {
  commitIt?: boolean;
  makeDir?: (prefix: string) => string;
} = {}) {
  const root = makeDir('station-doc-freshness-');
  const { write } = fixtureAt(root, '');
  const files: Record<string, string> = {
    'docs/a.md': '# A\n',
    'docs/b.md': '# B\n',
    'docs/c.md': '# C cites A\n',
    'docs/d.md': '# D cites the capture manifest\n',
    'docs/map.md': '# Map cites C and D\n',
    'docs/pkg.md': '# Run npm run docs\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': SHARED_C,
    'src/d.ts': 'export const d = 1;\n',
    'src/ui.ts': 'export const ui = 1;\n',
    'package.json': PACKAGE_JSON,
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  write('docs/learn/media/task.png', image);
  const capture = {
    path: 'docs/learn/media/task.png',
    kind: 'image',
    digest: hash(image),
    alt: 'A task',
    caption: 'A task.',
    scenario: 'Task → detail',
    evidence: 'Fixture capture.',
    capturedRevision: 'a'.repeat(40),
    documents: ['docs/a.md'],
    sources: [{ path: 'src/ui.ts', digest: hash(files['src/ui.ts']) }],
  };
  const mediaText = writeLearningMedia(root, [capture]);
  const records = [
    record('docs/a.md', [['src/a.ts', files['src/a.ts']]], files['docs/a.md']),
    record('docs/b.md', [['src/b.ts', files['src/b.ts']]], files['docs/b.md']),
    record(
      'docs/c.md',
      [['docs/a.md', files['docs/a.md']]],
      files['docs/c.md'],
    ),
    // A page that cites the capture manifest itself.
    record('docs/d.md', [[MEDIA, mediaText]], files['docs/d.md']),
    {
      ...record('docs/pkg.md', [], files['docs/pkg.md']),
      sources: [
        {
          path: 'package.json#/scripts/docs',
          digest: hash(JSON.stringify('node docs.mjs')),
        },
      ],
    },
    record(
      'docs/map.md',
      [
        ['src/c.ts', files['src/c.ts']],
        ['src/d.ts', files['src/d.ts']],
      ],
      files['docs/map.md'],
    ),
  ];
  git(root, ['init', '-q', '-b', 'main']);
  if (!commitIt) {
    writeReviewLedger(root, records);
    // No commit exists yet, so nothing can be bound to one.
    return {
      root,
      content: '',
      write,
      read: (p: string) => readFileSync(join(root, p), 'utf8'),
    };
  }
  // Bind every record to the commit that holds its reviewed bytes, exactly as
  // the record command does.
  const content = commit(root, 'content');
  writeReviewLedger(
    root,
    records.map((entry) => ({ ...entry, documentRevision: content })),
  );
  writeLearningMedia(root, [capture], content);
  commit(root, 'fresh main');
  return {
    root,
    content,
    write,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
}

export function compiled(root: string, path: string) {
  const found = readReviewState(root).ledger.records.find(
    (entry: { path: string }) => entry.path === path,
  );
  if (!found) throw new Error(`No compiled review record: ${path}`);
  return found;
}

export function compiledMedia(root: string) {
  const { media } = readReviewState(root);
  if (!media) throw new Error('No compiled capture manifest');
  return media;
}

/** Hand-edit one record file, keeping the canonical layout. */
export function editRecord(
  root: string,
  path: string,
  edit: (data: any) => void,
) {
  const file = join(root, recordFile(path));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, serializeRecordFile(data));
}

/** Notes file names in the fixture's ledger, tracked or not yet added. */
export const notesFiles = (root: string) =>
  listReviewLedgerFiles(root)
    .filter((file: string) => file.startsWith(`${REVIEW_LEDGER_DIR}/notes/`))
    .map((file: string) => file.slice(`${REVIEW_LEDGER_DIR}/notes/`.length))
    .sort();

export function run(
  root: string,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: root,
    env: pinnedFreshnessEnv(env),
    encoding: 'utf8',
    windowsHide: true,
  });
}
type Entry = {
  kind: string;
  path: string;
  changed: string[];
  rule: string;
};

/** The last stdout line as JSON: the CLIs' `--json` result. */
const lastJson = (stdout: string) => {
  const line = stdout.trim().split('\n').at(-1);
  return line ? JSON.parse(line) : {};
};

/**
 * The check's machine-readable result (#2927): tests assert its mode, rules
 * and entries, never the wording of the human report.
 */
export function check(root: string, env: Record<string, string>) {
  const result = run(
    root,
    'check-documentation-freshness.mjs',
    ['--json'],
    env,
  );
  const parsed = lastJson(result.stdout);
  return {
    status: result.status,
    mode: parsed.mode as string | undefined,
    blocking: (parsed.blocking ?? []) as Entry[],
    advisory: (parsed.advisory ?? []) as Entry[],
    error: parsed.error as { code: string } | undefined,
  };
}
export const stale = (kind: string, path: string, changed: string[]) => ({
  kind,
  path,
  changed,
  rule: 'stale',
});
export const entryPaths = (entries: Entry[]) =>
  entries.map((entry) => entry.path);

/** The record command's `--json` result or refusal code. */
export function record_(root: string, args: string[]) {
  const result = run(root, 'record-documentation-review.mjs', [
    ...args,
    '--json',
  ]);
  const parsed = lastJson(result.stdout);
  return {
    status: result.status,
    output: parsed.error ? undefined : parsed,
    error: parsed.error as { code: string } | undefined,
  };
}

/** Paths with unresolved merge conflicts, from Git rather than its prose. */
export const conflicted = (root: string) =>
  git(root, ['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .filter(Boolean);
export const scoped = { STATION_DOCS_FRESHNESS_BASE: 'main' };
export const strict = { STATION_DOCS_FRESHNESS: 'strict' };
export const queue = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'merge_group',
};
export const pullRequest = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request_target',
  STATION_CI_FAST_BASE: 'main',
};

/** Every ledger file's text, for byte-level comparisons. */
export const ledgerTexts = (root: string) =>
  Object.fromEntries(
    listReviewLedgerFiles(root).map((file: string) => [
      file,
      readFileSync(join(root, file), 'utf8'),
    ]),
  );

/** The fixture handle for an existing fixture repository, such as a copy. */
export function fixtureAt(root: string, content: string) {
  return {
    root,
    content,
    write: (path: string, bytes: string | Buffer) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    },
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
}
