import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  compareAttribution,
  DEFAULT_MAX_SCREENS,
  normaliseFailureDetail,
  planAttribution,
} from '../gallery-main-attribution.mjs';

// Runs the PR Gallery job's own composition, attribution and verdict step
// text under bash against disposable Git repositories, the way the hosted
// job runs them (#4898/#4931). The capture itself is replaced by a fake
// `npm` that writes the manifest shape tests/screenshots.spec.ts writes.

type Step = { id?: string; name?: string; run?: string };
const workflow = load(
  readFileSync('.github/workflows/gallery-pr-check.yml', 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const steps = workflow.jobs['gallery-diff'].steps;
function stepRun(match: (step: Step) => boolean, label: string) {
  const run = steps.find(match)?.run;
  if (!run) throw new Error(`${label} step not found`);
  return run;
}
const COMPOSE = stepRun((step) => step.id === 'compose', 'compose');
const ATTRIBUTION = stepRun((step) => step.id === 'attribution', 'attribution');
const VERDICT = stepRun((step) => step.name === 'Gallery verdict', 'verdict');

const makeTempDir = trackTempDirs();
// What the composition step records for the attribution step.
const NODE_ON_PATH = execFileSync('bash', ['-c', 'command -v node'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function gitIn(root: string) {
  return (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: ENV,
      windowsHide: true,
    }).trim();
}

function commitFile(root: string, file: string, text: string, message: string) {
  const git = gitIn(root);
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), text);
  git('add', '.');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

function runner() {
  const dir = makeTempDir('gallery-composition-runner-');
  const output = join(dir, 'output');
  const summary = join(dir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return { dir, output, summary };
}

function runStep(
  script: string,
  cwd: string,
  env: Record<string, string>,
  pathPrefix?: string,
  temp = runner(),
) {
  const run = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...ENV,
      ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH}` } : {}),
      RUNNER_TEMP: temp.dir,
      GITHUB_OUTPUT: temp.output,
      GITHUB_STEP_SUMMARY: temp.summary,
      ...env,
    },
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    status: run.status,
    out: run.stdout + run.stderr,
    output: readFileSync(temp.output, 'utf8'),
    summary: readFileSync(temp.summary, 'utf8'),
  };
}

/** An upstream main: root commit, the PR's fork point, a base tip, then a later commit. */
function upstreamMain() {
  const root = makeTempDir('gallery-composition-upstream-');
  const git = gitIn(root);
  git('init', '-q', '-b', 'main');
  const forkPoint = commitFile(root, 'shared.txt', 'one\n', 'root');
  const base = commitFile(root, 'from-main.txt', 'main\n', 'main moves');
  // main moves again after the event: the composition must not see it.
  const later = commitFile(root, 'later.txt', 'later\n', 'after the event');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { root, forkPoint, base, later };
}

/** The job's checkout: the PR head, cloned from a fork that lacks the base tip. */
function prCheckout(
  upstream: ReturnType<typeof upstreamMain>,
  change: { file: string; text: string },
) {
  const root = makeTempDir('gallery-composition-head-');
  const git = gitIn(root);
  git('init', '-q');
  git('fetch', '-q', upstream.root, upstream.forkPoint);
  git('checkout', '-q', '--detach', upstream.forkPoint);
  const head = commitFile(root, change.file, change.text, 'pull request');
  git('checkout', '-q', '--detach', head);
  return { root, git, head };
}

describe('PR Gallery composes the head with the current base (#4898)', () => {
  it('merges the pinned head with exactly the base tip, fetched from upstream', () => {
    const upstream = upstreamMain();
    const pr = prCheckout(upstream, { file: 'feature.txt', text: 'pr\n' });
    // A fork's checkout does not have the base tip; the step fetches it.
    expect(() =>
      pr.git('cat-file', '-e', `${upstream.base}^{commit}`),
    ).toThrow();
    const result = runStep(COMPOSE, pr.root, {
      HEAD_SHA: pr.head,
      BASE_SHA: upstream.base,
      UPSTREAM_URL: upstream.root,
    });
    expect(result.status, result.out).toBe(0);
    expect(pr.git('rev-parse', 'HEAD^1')).toBe(pr.head);
    expect(pr.git('rev-parse', 'HEAD^2')).toBe(upstream.base);
    expect(existsSync(join(pr.root, 'feature.txt'))).toBe(true);
    expect(existsSync(join(pr.root, 'from-main.txt'))).toBe(true);
    // Not upstream's moving branch tip.
    expect(existsSync(join(pr.root, 'later.txt'))).toBe(false);
    expect(result.output).toBe(`base=${upstream.base}\nnode=${NODE_ON_PATH}\n`);
    expect(result.summary).toContain(`merged into main at ${upstream.base}`);
  });

  it('keeps a head that already contains the base tip as it is', () => {
    const upstream = upstreamMain();
    const pr = prCheckout(upstream, { file: 'feature.txt', text: 'pr\n' });
    pr.git('fetch', '-q', upstream.root, upstream.base);
    pr.git('merge', '-q', '--no-edit', upstream.base);
    const head = pr.git('rev-parse', 'HEAD');
    const result = runStep(COMPOSE, pr.root, {
      HEAD_SHA: head,
      BASE_SHA: upstream.base,
      UPSTREAM_URL: upstream.root,
    });
    expect(result.status, result.out).toBe(0);
    expect(pr.git('rev-parse', 'HEAD')).toBe(head);
    expect(result.output).toBe(`base=${upstream.base}\nnode=${NODE_ON_PATH}\n`);
  });

  it('fails on a conflict, names the file, and leaves no merge in progress', () => {
    const upstream = upstreamMain();
    // main and the PR both change shared.txt.
    commitFile(upstream.root, 'shared.txt', 'main side\n', 'main edits shared');
    const conflictingBase = gitIn(upstream.root)('rev-parse', 'HEAD');
    const pr = prCheckout(upstream, { file: 'shared.txt', text: 'pr side\n' });
    const result = runStep(COMPOSE, pr.root, {
      HEAD_SHA: pr.head,
      BASE_SHA: conflictingBase,
      UPSTREAM_URL: upstream.root,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      '::error title=Gallery composition conflict::',
    );
    expect(result.out).toContain('(shared.txt)');
    expect(result.output).toBe('');
    expect(pr.git('rev-parse', 'HEAD')).toBe(pr.head);
    expect(existsSync(join(pr.root, '.git/MERGE_HEAD'))).toBe(false);
  });

  it('refuses a checkout that is not the pinned head, and a base it cannot fetch', () => {
    const upstream = upstreamMain();
    const pr = prCheckout(upstream, { file: 'feature.txt', text: 'pr\n' });
    const notHead = runStep(COMPOSE, pr.root, {
      HEAD_SHA: upstream.forkPoint,
      BASE_SHA: upstream.base,
      UPSTREAM_URL: upstream.root,
    });
    expect(notHead.status).toBe(1);
    expect(notHead.out).toContain('not the pinned pull request head');
    const missing = runStep(COMPOSE, pr.root, {
      HEAD_SHA: pr.head,
      BASE_SHA: 'f'.repeat(40),
      UPSTREAM_URL: upstream.root,
    });
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('Cannot fetch the base tip');
    const symbolic = runStep(COMPOSE, pr.root, {
      HEAD_SHA: pr.head,
      BASE_SHA: 'main',
      UPSTREAM_URL: upstream.root,
    });
    expect(symbolic.status).toBe(1);
    expect(symbolic.out).toContain('must both be full commit ids');
  });
});

describe('PR Gallery verdict', () => {
  const sha = 'a'.repeat(40);
  const verdict = (env: Record<string, string>) =>
    runStep(VERDICT, makeTempDir('gallery-verdict-'), {
      BASE_SHA: sha,
      ...env,
    });

  it.each([
    // A clean composed run passes.
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'success',
      },
      0,
    ],
    // Failures already on main are excused, and only those.
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'failure',
        DIFF: 'skipped',
        ASSERTIONS: 'skipped',
        ATTRIBUTION: 'main',
      },
      0,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'failure',
        ATTRIBUTION: 'main',
      },
      0,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'failure',
        DIFF: 'skipped',
        ASSERTIONS: 'skipped',
        ATTRIBUTION: 'pr',
      },
      1,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'failure',
        DIFF: 'skipped',
        ASSERTIONS: 'skipped',
        ATTRIBUTION: '',
      },
      1,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'failure',
        ATTRIBUTION: 'pr',
      },
      1,
    ],
    // An integrity failure is never attributed, whatever the attribution says.
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'failure',
        ASSERTIONS: 'success',
        ATTRIBUTION: 'main',
      },
      1,
    ],
    // Steps that did not run are not a pass.
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'skipped',
        ASSERTIONS: 'success',
      },
      1,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'skipped',
      },
      1,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'skipped',
        DIFF: 'skipped',
        ASSERTIONS: 'skipped',
        ATTRIBUTION: 'main',
      },
      1,
    ],
    [
      {
        COMPOSE: 'success',
        CAPTURE: 'cancelled',
        DIFF: '',
        ASSERTIONS: '',
        ATTRIBUTION: 'main',
      },
      1,
    ],
    // No composition, no verdict: a bare-head capture never counts.
    [
      {
        COMPOSE: 'failure',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'success',
      },
      1,
    ],
    [
      {
        COMPOSE: 'skipped',
        CAPTURE: 'success',
        DIFF: 'success',
        ASSERTIONS: 'success',
      },
      1,
    ],
  ])('%o exits %i', (env, status) => {
    const result = verdict({ ATTRIBUTION: '', ...env });
    expect(result.status, result.out).toBe(status);
  });

  it('says when it excuses a failure, and which main', () => {
    const result = verdict({
      COMPOSE: 'success',
      CAPTURE: 'failure',
      DIFF: 'skipped',
      ASSERTIONS: 'skipped',
      ATTRIBUTION: 'main',
    });
    expect(result.out).toContain(
      `::warning title=Gallery failure already on main::Every failure here also fails on main at ${sha}`,
    );
  });
});

// The entry shape tests/screenshots.spec.ts writes to capture.json.
function screen(name: string, overrides: Record<string, unknown> = {}) {
  return {
    file: `${name}.png`,
    ok: true,
    name,
    viewport: { width: 390, height: 844 },
    error: null,
    sha256: 'a'.repeat(64),
    controls: [],
    uiAudit: {
      findings: [],
      measured: { controls: 4, smallTargets: 0, viewport: 390 },
    },
    ...overrides,
  };
}
const failedCapture = (
  name: string,
  error = 'breadcrumb stays before actions',
) => screen(name, { ok: false, error, sha256: null, uiAudit: null });
const withFinding = (name: string, identity: string) =>
  screen(name, {
    uiAudit: {
      findings: [{ identity, detail: 'measured' }],
      measured: { controls: 4, smallTargets: 0, viewport: 390 },
    },
  });
const manifest = (screens: unknown[], selection: string[] | null = null) =>
  JSON.stringify({
    schemaVersion: 1,
    runId: null,
    capturedAt: '2026-11-14T00:00:00.000Z',
    expected: screens.length,
    selection,
    screens,
  });

/**
 * A composed workspace whose history holds the base commit (as the job's
 * does after composing), with the base carrying the attribution script and
 * its judge, and a fake npm whose capture writes `baseCapture`.
 */
function attributionFixture({
  composed,
  baseCapture,
  baseScreens = ['child-chat-dark-390', 'home'],
  baseAllowlist = {},
  composedAllowlist = baseAllowlist,
  composedManifest,
  capture = 'failure',
  diffStatus = 0,
  nodeBin = process.execPath,
  shimNode = false,
}: {
  composed: unknown[];
  composedManifest?: string;
  capture?: string;
  diffStatus?: number;
  nodeBin?: string;
  shimNode?: boolean;
  baseCapture: string | null;
  baseScreens?: string[];
  baseAllowlist?: Record<string, string[]>;
  composedAllowlist?: Record<string, string[]>;
}) {
  const root = makeTempDir('gallery-attribution-workspace-');
  const git = gitIn(root);
  git('init', '-q');
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  copyFileSync(
    resolve('scripts/lib/module-entry.mjs'),
    join(root, 'scripts/lib/module-entry.mjs'),
  );
  mkdirSync(join(root, 'tests'));
  for (const file of [
    'gallery-main-attribution.mjs',
    'gallery-ui-findings.mjs',
  ])
    copyFileSync(resolve('scripts', file), join(root, 'scripts', file));
  writeFileSync(
    join(root, 'tests/gallery-screen-sources.json'),
    JSON.stringify({
      schemaVersion: 1,
      shell: [],
      screens: Object.fromEntries(baseScreens.map((name) => [name, []])),
    }),
  );
  writeFileSync(
    join(root, 'tests/gallery-ui-findings.allowlist.json'),
    JSON.stringify({ schemaVersion: 1, screens: baseAllowlist }),
  );
  writeFileSync(join(root, '.gitignore'), 'gallery/\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(
    join(root, 'tests/gallery-ui-findings.allowlist.json'),
    JSON.stringify({ schemaVersion: 1, screens: composedAllowlist }),
  );
  commitFile(root, 'feature.txt', 'pr\n', 'composed');
  mkdirSync(join(root, 'gallery'));
  writeFileSync(
    join(root, 'gallery/capture.json'),
    composedManifest ?? manifest(composed),
  );

  const bin = makeTempDir('gallery-attribution-bin-');
  const calls = join(bin, 'calls.log');
  const fixture = join(bin, 'base-capture.json');
  if (baseCapture !== null) writeFileSync(fixture, baseCapture);
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/usr/bin/env bash',
      `printf '%s|%s\\n' "$PWD" "$*" >> '${calls}'`,
      'if [[ "$*" == *test:e2e:screenshot* ]]; then',
      `  if [[ -f '${fixture}' ]]; then mkdir -p gallery && cp '${fixture}' gallery/capture.json; fi`,
      '  exit 1',
      'fi',
      `if [[ "$*" == *screenshot:diff* ]]; then exit ${diffStatus}; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'npm'), 0o755);
  if (shimNode) {
    // A `node` on PATH that forges an excuse, as GITHUB_PATH could plant.
    writeFileSync(
      join(bin, 'node'),
      [
        '#!/usr/bin/env bash',
        'case " $* " in',
        "  *' plan '*) echo screens=child-chat-dark-390 ;;",
        "  *' compare '*) printf 'FORGED\\nverdict=main\\n' ;;",
        '  *) printf home ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'node'), 0o755);
  }
  const temp = runner();
  const run = () => {
    const result = runStep(
      ATTRIBUTION,
      root,
      { BASE_SHA: base, CAPTURE: capture, NODE_BIN: nodeBin },
      bin,
      temp,
    );
    return {
      ...result,
      base,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    };
  };
  const setBaseCapture = (text: string) => writeFileSync(fixture, text);
  return { run, root, git, base, bin, runnerTemp: temp.dir, setBaseCapture };
}

describe('PR Gallery attributes a failure main already has', () => {
  it('answers main when the base fails the same screen the same way', () => {
    const { run } = attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      baseCapture: manifest(
        [failedCapture('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
    });
    const result = run();
    expect(result.status, result.out).toBe(0);
    expect(result.output).toBe('verdict=main\n');
    // The base was captured from its own worktree, for that screen only.
    expect(result.calls).toMatch(
      /gallery-base\|run test:e2e:screenshot -- --screens=child-chat-dark-390\n/,
    );
    expect(result.out).toContain(
      '::warning title=Gallery failure already on main::',
    );
    expect(result.summary).toContain(
      `ALSO ON MAIN child-chat-dark-390: capture-failed`,
    );
  });

  it('answers pr when the base renders the screen', () => {
    const { run } = attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      baseCapture: manifest(
        [screen('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
    });
    const result = run();
    expect(result.status, result.out).toBe(0);
    expect(result.output).toBe('verdict=pr\n');
    expect(result.summary).toContain(
      'INTRODUCED child-chat-dark-390: capture-failed',
    );
  });

  it('answers pr for a different finding on a screen main also fails', () => {
    const { run } = attributionFixture({
      composed: [
        withFinding('home', 'overflow:document'),
        failedCapture('child-chat-dark-390'),
      ],
      baseCapture: manifest(
        [
          withFinding('home', 'hit-target:small:Send'),
          failedCapture('child-chat-dark-390'),
        ],
        ['child-chat-dark-390', 'home'],
      ),
    });
    const result = run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.summary).toContain('INTRODUCED home: overflow:document');
    expect(result.summary).toContain(
      'ALSO ON MAIN child-chat-dark-390: capture-failed',
    );
  });

  it('answers pr without a base capture for a screen main does not have', () => {
    const { run } = attributionFixture({
      composed: [failedCapture('brand-new-screen')],
      baseCapture: manifest(
        [failedCapture('brand-new-screen')],
        ['brand-new-screen'],
      ),
    });
    const result = run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.out).toContain('main has no screen named brand-new-screen');
    expect(result.calls).toBe('');
  });

  it('answers pr when the capture failed with no failing screen', () => {
    const { run } = attributionFixture({
      composed: [screen('home')],
      baseCapture: manifest([screen('home')], ['home']),
    });
    const result = run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.out).toContain('without a failing screen');
    expect(result.calls).toBe('');
  });

  it('answers pr when the base capture is missing or not the requested subset', () => {
    const missing = attributionFixture({
      composed: [failedCapture('child-chat-dark-390')],
      baseCapture: null,
    }).run();
    expect(missing.status, missing.out).toBe(0);
    expect(missing.output).toBe('verdict=pr\n');
    expect(missing.out).toContain('attribution comparison failed');
    const full = attributionFixture({
      composed: [failedCapture('child-chat-dark-390')],
      baseCapture: manifest([
        failedCapture('child-chat-dark-390'),
        screen('home'),
      ]),
    }).run();
    expect(full.output).toBe('verdict=pr\n');
    expect(full.out).toContain("the base capture's selection null");
  });

  it('judges the base with its own allowlist', () => {
    // main lists the finding, so it does not fail there: the PR's copy of it
    // is the PR's, even though the pixels match.
    const { run } = attributionFixture({
      composed: [withFinding('home', 'overflow:document')],
      baseCapture: manifest(
        [withFinding('home', 'overflow:document')],
        ['home'],
      ),
      baseAllowlist: { home: ['overflow:document'] },
      composedAllowlist: {},
    });
    const result = run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.summary).toContain('INTRODUCED home: overflow:document');
  });
});

// Playwright's message shape for the #4931 breadcrumb assertion.
const breadcrumb = (received: string, expected = '306') =>
  [
    'breadcrumb stays before actions',
    '',
    '\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBeLessThanOrEqual\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m',
    '',
    `Expected: <= \u001b[32m${expected}\u001b[39m`,
    `Received:    \u001b[31m${received}\u001b[39m`,
  ].join('\n');
const timeout = [
  'locator.click: Timeout 15000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Chat actions', exact: true })",
].join('\n');
const browserErrors = (port: number) =>
  `Browser errors: ${JSON.stringify([`TypeError: x at http://localhost:${port}/assets/index-abc.js:1:2`])}`;

describe('a render failure is excused only by the same error on main', () => {
  const failingOnBoth = (composedError: string, baseError: string) =>
    attributionFixture({
      composed: [
        failedCapture('child-chat-dark-390', composedError),
        screen('home'),
      ],
      baseCapture: manifest(
        [failedCapture('child-chat-dark-390', baseError)],
        ['child-chat-dark-390'],
      ),
    }).run();

  it('excuses the same assertion with a different measurement', () => {
    const result = failingOnBoth(breadcrumb('320.5'), breadcrumb('284'));
    expect(result.output, result.out).toBe('verdict=main\n');
  });

  it('keeps a different assertion on the same screen red', () => {
    const other = breadcrumb('320.5').replace(
      'breadcrumb stays before actions',
      'dock does not overflow',
    );
    const result = failingOnBoth(other, breadcrumb('284'));
    expect(result.output, result.out).toBe('verdict=pr\n');
    expect(result.summary).toContain(
      'INTRODUCED child-chat-dark-390: capture-failed (line 1: dock does not overflow | main: breadcrumb stays before actions)',
    );
  });

  it('keeps a different expected bound red', () => {
    const result = failingOnBoth(breadcrumb('320', '300'), breadcrumb('320'));
    expect(result.output, result.out).toBe('verdict=pr\n');
  });

  it('keeps a timeout on the pull request red when main fails an assertion', () => {
    const result = failingOnBoth(timeout, breadcrumb('284'));
    expect(result.output, result.out).toBe('verdict=pr\n');
  });

  it('excuses the same error when only the console lines differ', () => {
    // Decision: console output is not compared. It never fails a screen on
    // its own, and it carries bundle hashes and ports that differ between
    // any two builds, so comparing it would never excuse anything.
    const result = failingOnBoth(
      `${breadcrumb('320.5')}\n${browserErrors(5314)}`,
      breadcrumb('320.5'),
    );
    expect(result.output, result.out).toBe('verdict=main\n');
  });

  it('never excuses an error that is not text', () => {
    const odd = screen('child-chat-dark-390', {
      ok: false,
      error: { code: 1 },
      sha256: null,
      uiAudit: null,
    });
    const result = attributionFixture({
      composed: [odd, screen('home')],
      baseCapture: manifest([odd], ['child-chat-dark-390']),
    }).run();
    expect(result.output, result.out).toBe('verdict=pr\n');
    expect(result.summary).toContain(
      'INTRODUCED child-chat-dark-390: capture-failed (error is not text)',
    );
  });

  it('never excuses an error that is empty once normalised', () => {
    // An empty message, and the capture's join of an empty message with
    // its appended console line.
    for (const error of ['', ['', browserErrors(5314)].join('\n')]) {
      const empty = failedCapture('child-chat-dark-390', error);
      const result = attributionFixture({
        composed: [empty, screen('home')],
        baseCapture: manifest([empty], ['child-chat-dark-390']),
      }).run();
      expect(result.output, result.out).toBe('verdict=pr\n');
      expect(result.summary).toContain(
        'INTRODUCED child-chat-dark-390: capture-failed (error is empty)',
      );
    }
  });

  it('still matches a finding by its identity alone', () => {
    const result = attributionFixture({
      composed: [
        withFinding('home', 'overflow:document'),
        screen('child-chat-dark-390'),
      ],
      baseCapture: manifest(
        [withFinding('home', 'overflow:document')],
        ['home'],
      ),
      capture: 'success',
    }).run();
    expect(result.output, result.out).toBe('verdict=main\n');
  });

  it('excuses a stack whose only difference is the checkout root', () => {
    const fixture = attributionFixture({
      composed: [screen('home')],
      baseCapture: null,
    });
    // Each checkout's own root appears in its capture's stack.
    const stack = (rootDir: string) =>
      `${breadcrumb('1')}\n    at ${rootDir}/tests/screenshots.spec.ts:4485:13`;
    const composedCapture = manifest([
      failedCapture('child-chat-dark-390', stack(realpathSync(fixture.root))),
      screen('home'),
    ]);
    writeFileSync(join(fixture.root, 'gallery/capture.json'), composedCapture);
    const baseRoot = join(fixture.runnerTemp, 'gallery-base');
    fixture.setBaseCapture(
      manifest(
        [failedCapture('child-chat-dark-390', stack(baseRoot))],
        ['child-chat-dark-390'],
      ),
    );
    const result = fixture.run();
    expect(result.output, result.out).toBe('verdict=main\n');
  });

  it('compares an audit error by its message too', () => {
    const auditError = (error: string) =>
      screen('home', { uiAudit: { error } });
    const run = (composed: string, base: string) =>
      attributionFixture({
        composed: [auditError(composed), screen('child-chat-dark-390')],
        baseCapture: manifest([auditError(base)], ['home']),
        // An audit error does not fail the capture; the assertions do.
        capture: 'success',
      }).run().output;
    expect(
      run('axe failed: frame detached', 'axe failed: frame detached'),
    ).toBe('verdict=main\n');
    expect(run('axe failed: frame detached', 'audit timed out')).toBe(
      'verdict=pr\n',
    );
  });
});

describe('normaliseFailureDetail', () => {
  const root = '/__w/station/station';
  const same = (a: string, b: string) =>
    normaliseFailureDetail(a, { root }) === normaliseFailureDetail(b, { root });

  it('masks only the volatile parts', () => {
    expect(normaliseFailureDetail(breadcrumb('320.5'))).toBe(
      [
        'breadcrumb stays before actions',
        '',
        'expect(received).toBeLessThanOrEqual(expected)',
        '',
        'Expected: <= 306',
        'Received: <n>',
      ].join('\n'),
    );
    expect(normaliseFailureDetail(timeout)).toBe(
      'locator.click: Timeout 15000ms exceeded.',
    );
    expect(
      normaliseFailureDetail(
        'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3282/agents',
      ),
    ).toBe(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:<port>/agents',
    );
    expect(normaliseFailureDetail('GET /api/agents failed; Expected: 3')).toBe(
      'GET /api/agents failed; Expected: 3',
    );
  });

  it('keeps the 390 and 412 measurements of one assertion equal', () => {
    expect(same(breadcrumb('320.5'), breadcrumb('-12'))).toBe(true);
    expect(same(breadcrumb('284'), breadcrumb('306.25'))).toBe(true);
  });

  it('compares a Received value exactly unless it is only a number', () => {
    expect(same('Received: "Step 1"', 'Received: "Step 2"')).toBe(false);
    expect(
      same('Received string: "Step 1 of 3"', 'Received string: "Step 2 of 3"'),
    ).toBe(false);
    expect(same('Received: "rgb(1, 2, 3)"', 'Received: "rgb(1, 2, 4)"')).toBe(
      false,
    );
    expect(
      same(
        'Received: "http://localhost:5314/chat/1"',
        'Received: "http://localhost:5314/chat/2"',
      ),
    ).toBe(false);
    expect(same('Received: 12px', 'Received: 13px')).toBe(false);
    expect(same('Received: 12', 'Received: 13')).toBe(true);
  });

  it('masks only the checkout root of a path, at a path start', () => {
    expect(
      normaliseFailureDetail(`at ${root}/tests/screenshots.spec.ts:6684:61`, {
        root,
      }),
    ).toBe('at <repo>/tests/screenshots.spec.ts:6684:61');
    expect(
      same(
        `at ${root}/tests/screenshots.spec.ts:6684:61`,
        `at ${root}/tests/screenshots.spec.ts:7223:61`,
      ),
    ).toBe(false);
    expect(same(`at ${root}/x.ts`, 'at /__w/other/x.ts')).toBe(false);
    expect(
      same('http://example.test/Users/a', 'http://example.test/Users/b'),
    ).toBe(false);
    expect(
      normaliseFailureDetail(`see http://example.test${root}/x`, { root }),
    ).toBe(`see http://example.test${root}/x`);
    // The two checkouts' roots differ; the repo-relative rest must not.
    expect(
      normaliseFailureDetail('(/__w/_temp/gallery-base/tests/a.ts:1:2)', {
        root: '/__w/_temp/gallery-base',
      }),
    ).toBe(normaliseFailureDetail(`(${root}/tests/a.ts:1:2)`, { root }));
  });

  it('drops only the appended console line, keeps call-log-only messages, and refuses non-text', () => {
    const appended = `${breadcrumb('1')}\n${browserErrors(5314)}`;
    expect(normaliseFailureDetail(appended, { appendedConsole: true })).toBe(
      normaliseFailureDetail(breadcrumb('1')),
    );
    // Not appended by the capture: kept.
    expect(normaliseFailureDetail(appended)).toContain('Browser errors: ');
    const embedded =
      'Extension registry failed during capture. Browser errors: ["a"]';
    expect(normaliseFailureDetail(embedded, { appendedConsole: true })).toBe(
      embedded,
    );
    expect(normaliseFailureDetail('Call log:\n  - waiting for a')).not.toBe(
      normaliseFailureDetail('Call log:\n  - waiting for b'),
    );
    expect(normaliseFailureDetail({ message: 'x' })).toBeNull();
    expect(normaliseFailureDetail(undefined)).toBeNull();
  });
});

describe('an excuse needs a complete capture and a sound comparison', () => {
  const mainAlsoFails = manifest(
    [failedCapture('child-chat-dark-390')],
    ['child-chat-dark-390'],
  );
  const composed = [failedCapture('child-chat-dark-390'), screen('home')];

  it('refuses a capture that recorded fewer screens than it expected', () => {
    const partial = JSON.parse(manifest(composed));
    partial.expected = 181;
    const result = attributionFixture({
      composed,
      composedManifest: JSON.stringify(partial),
      baseCapture: mainAlsoFails,
    }).run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.out).toContain('recorded 2 of 181 expected screens');
    expect(result.calls).toBe('');
  });

  it('refuses a targeted composed capture', () => {
    const result = attributionFixture({
      composed,
      composedManifest: manifest(composed, ['child-chat-dark-390', 'home']),
      baseCapture: mainAlsoFails,
    }).run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.out).toContain('the capture is a targeted run');
  });

  it('runs the comparison over the screens that rendered before excusing', () => {
    const result = attributionFixture({
      composed,
      baseCapture: mainAlsoFails,
    }).run();
    expect(result.output, result.out).toBe('verdict=main\n');
    expect(result.calls).toMatch(
      /\|run screenshot:diff -- --report-only --screens=home --summary=/,
    );
  });

  it('does not excuse a run whose rendered screens fail integrity', () => {
    const result = attributionFixture({
      composed,
      baseCapture: mainAlsoFails,
      diffStatus: 1,
    }).run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.out).toContain('::error title=Gallery comparison::');
  });

  it('does not excuse a run in which no screen rendered', () => {
    const result = attributionFixture({
      composed: [failedCapture('child-chat-dark-390')],
      baseCapture: mainAlsoFails,
    }).run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.calls).not.toContain('screenshot:diff');
  });

  it('does not repeat the comparison when only the assertions failed', () => {
    const result = attributionFixture({
      composed: [withFinding('home', 'overflow:document')],
      baseCapture: manifest(
        [withFinding('home', 'overflow:document')],
        ['home'],
      ),
      capture: 'success',
      diffStatus: 1,
    }).run();
    expect(result.output, result.out).toBe('verdict=main\n');
    expect(result.calls).not.toContain('screenshot:diff');
  });
});

describe('the base checkout is exactly main, and node is the one resolved first', () => {
  it('ignores refs/replace for the base commit', () => {
    const fixture = attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      // main renders the screen, so the honest answer is pr.
      baseCapture: manifest(
        [screen('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
    });
    // A forged base whose attribution script always excuses.
    const forged = join(fixture.root, 'scripts/gallery-main-attribution.mjs');
    const honest = readFileSync(forged, 'utf8');
    writeFileSync(
      forged,
      "console.log(process.argv[2] === 'plan' ? 'screens=child-chat-dark-390' : 'FORGED\\nverdict=main');\n",
    );
    fixture.git('add', '.');
    const tree = fixture.git('write-tree');
    const forgedCommit = fixture.git('commit-tree', tree, '-m', 'forged base');
    fixture.git('replace', fixture.base, forgedCommit);
    writeFileSync(forged, honest);
    fixture.git('add', '.');
    const result = fixture.run();
    expect(result.out).not.toContain('FORGED');
    expect(result.output, result.out).toBe('verdict=pr\n');
  });

  // A hook in the shared .git runs in the new worktree after its checkout.
  const plantHook = (
    fixture: ReturnType<typeof attributionFixture>,
    body: string,
  ) => {
    const hooks = join(fixture.root, '.git/hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/usr/bin/env bash\n[[ -n "$PLANTED" ]] && exit 0\nexport PLANTED=1\n${body}\n`,
    );
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    // The shared config is the candidate's to write too; pin it here so a
    // developer's global hooksPath does not hide the planted hook.
    fixture.git('config', 'core.hooksPath', hooks);
  };
  const honestIsPr = () =>
    attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      baseCapture: manifest(
        [screen('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
    });
  const forger =
    "console.log(process.argv[2] === 'plan' ? 'screens=child-chat-dark-390' : 'FORGED\\nverdict=main');";

  it('refuses a base checkout a hook rewrote', () => {
    const fixture = honestIsPr();
    plantHook(
      fixture,
      `printf '%s\\n' "${forger}" > scripts/gallery-main-attribution.mjs`,
    );
    const result = fixture.run();
    expect(result.out).not.toContain('FORGED');
    expect(result.out).toContain('Cannot check out a clean copy of main');
    expect(result.output).toBe('verdict=pr\n');
  });

  it('refuses a base checkout a hook moved to another commit', () => {
    const fixture = honestIsPr();
    const forged = join(fixture.root, 'scripts/gallery-main-attribution.mjs');
    const honest = readFileSync(forged, 'utf8');
    writeFileSync(forged, `${forger}\n`);
    fixture.git('add', '.');
    const forgedCommit = fixture.git(
      'commit-tree',
      fixture.git('write-tree'),
      '-p',
      fixture.base,
      '-m',
      'forged',
    );
    writeFileSync(forged, honest);
    fixture.git('add', '.');
    plantHook(fixture, `git checkout -q --detach ${forgedCommit}`);
    const result = fixture.run();
    expect(result.out).not.toContain('FORGED');
    expect(result.out).toContain('Cannot check out a clean copy of main');
    expect(result.output).toBe('verdict=pr\n');
  });

  it('runs the node resolved before candidate code, not one on PATH', () => {
    const result = attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      baseCapture: manifest(
        [screen('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
      shimNode: true,
    }).run();
    expect(result.out).not.toContain('FORGED');
    expect(result.output, result.out).toBe('verdict=pr\n');
  });

  it('refuses a node that is not an absolute path', () => {
    const result = attributionFixture({
      composed: [failedCapture('child-chat-dark-390'), screen('home')],
      baseCapture: manifest(
        [failedCapture('child-chat-dark-390')],
        ['child-chat-dark-390'],
      ),
      nodeBin: 'node',
    }).run();
    expect(result.output).toBe('verdict=pr\n');
    expect(result.calls).toBe('');
  });
});

describe('gallery-main-attribution decisions', () => {
  const failure = (screen: string, identity = 'capture-failed') => ({
    screen,
    identity,
  });
  it('bounds the base capture and refuses one screen past it', () => {
    expect(DEFAULT_MAX_SCREENS).toBe(40);
    const names = Array.from({ length: 41 }, (_, index) => `s${index}`);
    const failures = names.map((name) => failure(name));
    expect(
      planAttribution(failures.slice(0, 40), names, DEFAULT_MAX_SCREENS),
    ).toEqual({ screens: names.slice(0, 40).sort() });
    expect(planAttribution(failures, names, DEFAULT_MAX_SCREENS)).toEqual({
      reason: '41 failing screens exceed the attribution bound of 40',
    });
  });

  it('needs every failure on the base, and at least one failure', () => {
    expect(compareAttribution([], []).verdict).toBe('pr');
    expect(
      compareAttribution([failure('a')], [failure('a'), failure('b')]).verdict,
    ).toBe('main');
    expect(
      compareAttribution([failure('a'), failure('b')], [failure('a')]),
    ).toEqual({
      verdict: 'pr',
      alsoOnMain: [failure('a')],
      introduced: [failure('b')],
    });
    expect(
      compareAttribution([failure('a', 'overflow:x')], [failure('a')]).verdict,
    ).toBe('pr');
  });
});
