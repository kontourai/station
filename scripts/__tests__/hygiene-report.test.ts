import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { HYGIENE_ISSUE_TITLE, reportOutstanding } from '../hygiene-report.mjs';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { upsertTrackingIssue } from '../lib/tracking-issue.mjs';

// Every check runs as the real CLI child against a disposable Git tree. The
// GitHub seam is the `gh` command itself: STATION_HYGIENE_GH points at a
// fake that answers the real GraphQL query text the way `gh` does, including
// exit 1 with a JSON body when a number does not exist.

const SCRIPT = resolve('scripts/hygiene-report.mjs');
const makeTemp = trackTempDirs({ lifetime: 'file' });

const FAKE_GH = `
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.env.FAKE_GH_MODE ?? 'online';
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (mode === 'offline') {
  process.stderr.write('error connecting to api.github.com\\n');
  process.exit(1);
}
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const query = process.argv.find((arg) => arg.startsWith('query=')).slice(6);
const repository = {};
const errors = [];
if (query.includes('issues(first: 1')) {
  repository.issues = { nodes: [{ number: state.max }] };
  repository.pullRequests = { nodes: [{ number: state.max - 1 }] };
}
for (const match of query.matchAll(/n(\\d+): issueOrPullRequest\\(number: (\\d+)\\)/g)) {
  const entry = state.numbers[match[2]];
  if (entry) repository['n' + match[1]] = entry;
  else {
    repository['n' + match[1]] = null;
    errors.push({ type: 'NOT_FOUND', path: ['repository', 'n' + match[1]], message: 'Could not resolve to an issue or pull request with the number of ' + match[2] + '.' });
  }
}
process.stdout.write(JSON.stringify({ data: { repository }, ...(errors.length ? { errors } : {}) }));
process.exit(errors.length ? 1 : 0);
`;

type Finding = { kind: string; path: string; line?: number; detail: string };
type CheckResult = {
  id: string;
  findings: Finding[];
  notVerified: string | null;
  summary: string;
};

const ISSUE = (state: string, title = 'an issue') => ({
  __typename: 'Issue',
  state,
  title,
});

const DEFAULT_GITHUB = {
  max: 3877,
  numbers: {
    '100': ISSUE('OPEN', 'open work'),
    '200': ISSUE('CLOSED', 'finished work'),
    '300': { __typename: 'PullRequest', state: 'MERGED', title: 'a change' },
  } as Record<string, unknown>,
};

function makeRepo(files: Record<string, string>) {
  const root = makeTemp('hygiene-repo-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true });
  return root;
}

function run(
  root: string,
  args: string[],
  {
    github = DEFAULT_GITHUB,
    mode = 'online',
  }: { github?: typeof DEFAULT_GITHUB; mode?: string } = {},
) {
  const tools = makeTemp('hygiene-gh-');
  const fake = join(tools, 'fake-gh.mjs');
  writeFileSync(fake, FAKE_GH);
  writeFileSync(join(tools, 'state.json'), JSON.stringify(github));
  const log = join(tools, 'calls.log');
  writeFileSync(log, '');
  const child = spawnSyncBounded(
    process.execPath,
    [SCRIPT, '--root', root, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        STATION_HYGIENE_GH: JSON.stringify([process.execPath, fake]),
        FAKE_GH_MODE: mode,
        FAKE_GH_STATE: join(tools, 'state.json'),
        FAKE_GH_LOG: log,
      },
    },
  );
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    calls,
  };
}

function runJson(root: string, check: string, options = {}) {
  const out = run(root, ['--check', check, '--json'], options);
  const [result] = JSON.parse(out.stdout) as CheckResult[];
  return { ...out, result };
}

const located = (findings: Finding[]) =>
  findings.map((finding) =>
    [finding.kind, finding.path, finding.line].filter(Boolean).join(':'),
  );

describe('hygiene markers check', () => {
  const root = makeRepo({
    'src-server/services/demo/wired.ts': [
      '// UNWIRED(#100): the scheduler will call this once the queue lands.',
      'export function pending() {}',
      '// SUNSET(#200): delete after the legacy import window closes.',
      'export function legacy() {}',
      '// TODO(#300): replace the probe.',
      '// TODO(#9999): replace the probe.',
      '// UNWIRED(#100)',
      '// SUNSET(archive#980): retire with the old store.',
      '// UNWIRED: nothing owns this yet.',
      '// TODO(2026-11-01): a dated TODO belongs to another sweep.',
      '// The convention is UNWIRED(#N): <what remains>.',
      "const text = 'UNWIRED(#200): inside a string is not a comment';",
      "const url = 'https://example.com/ SUNSET(#200): a URL is not a comment';",
      '',
    ].join('\n'),
    'docs/guides/notes.md': [
      '# Notes',
      '',
      'SUNSET(#200): prose markers in Markdown count.',
      '',
      'Example: `UNWIRED(#200): in inline code is documentation`.',
      '',
      '```ts',
      '// UNWIRED(#200): fenced examples are documentation',
      '```',
      '',
    ].join('\n'),
    'scripts/__tests__/fixtures/marker.ts':
      '// UNWIRED(#200): fixture data is not scanned\n',
    // The two shapes Station reads STATION_FEATURES with today.
    'src-server/runtime/bootstrap/station-features.ts': [
      '/** Shared parsing. */',
      'function parseStationFeatures(env: NodeJS.ProcessEnv = process.env): string[] {',
      "  return (env.STATION_FEATURES || '').split(',').filter(Boolean);",
      '}',
      '',
      'export function isManagedChatOrchestrationFeatureEnabled(',
      '  env: NodeJS.ProcessEnv = process.env,',
      '): boolean {',
      "  return parseStationFeatures(env).includes('managed-chat-orchestration');",
      '}',
      '',
      '/** SUNSET(#100): remove once the replacement ships. */',
      'export function isRetiringEnabled(env = process.env): boolean {',
      "  return parseStationFeatures(env).includes('retiring-flag');",
      '}',
      '',
    ].join('\n'),
    'src-server/runtime/bootstrap/runtime-initialize.ts': [
      'export async function initialize(appConfig: { runtime?: string }) {',
      "  const features = (process.env.STATION_FEATURES || '')",
      "    .split(',')",
      '    .filter(Boolean);',
      "  if (features.includes('strands-runtime')) {",
      "    appConfig.runtime = 'strands';",
      '  }',
      '  // SUNSET(#100): drop when the preview ends.',
      "  if (features.includes('preview-flag')) appConfig.runtime = 'x';",
      "  if (features.includes('unrelated-check') && ['a'].includes('a')) return;",
      '}',
      '',
    ].join('\n'),
    'src-server/runtime/bootstrap/__tests__/flags.test.ts':
      "const features = (process.env.STATION_FEATURES || '').split(',');\nfeatures.includes('test-only-flag');\n",
  });

  it('reports closed, missing, pull-request and malformed markers and flags without a sunset', () => {
    const { status, result, calls } = runJson(root, 'markers');
    expect(status).toBe(0);
    expect(result.notVerified).toBeNull();
    expect(located(result.findings)).toEqual([
      'closed-issue:docs/guides/notes.md:3',
      'flag-without-sunset:src-server/runtime/bootstrap/runtime-initialize.ts:5',
      'flag-without-sunset:src-server/runtime/bootstrap/runtime-initialize.ts:10',
      'flag-without-sunset:src-server/runtime/bootstrap/station-features.ts:9',
      'closed-issue:src-server/services/demo/wired.ts:3',
      'not-an-issue:src-server/services/demo/wired.ts:5',
      'not-an-issue:src-server/services/demo/wired.ts:6',
      'malformed:src-server/services/demo/wired.ts:7',
      'malformed:src-server/services/demo/wired.ts:8',
      'malformed:src-server/services/demo/wired.ts:9',
    ]);
    const details = result.findings.map((finding) => finding.detail).join('\n');
    expect(details).toContain("flag 'managed-chat-orchestration'");
    expect(details).toContain("flag 'strands-runtime'");
    expect(details).not.toContain('retiring-flag');
    expect(details).not.toContain('preview-flag');
    expect(details).not.toContain('test-only-flag');
    expect(details).toContain('#300 is a pull request');
    expect(details).toContain('#9999 does not exist');
    // Every distinct number is resolved in one batched request.
    expect(calls).toHaveLength(1);
  });

  it('reports NOT_VERIFIED, never clean, when GitHub cannot be reached', () => {
    const { status, stdout } = run(root, ['--check', 'markers'], {
      mode: 'offline',
    });
    expect(status).toBe(2);
    expect(stdout).toContain(
      '[hygiene:markers] NOT_VERIFIED: the GitHub query exited 1 without a JSON response: error connecting to api.github.com',
    );
    // Findings that need no GitHub data are still reported.
    expect(stdout).toContain('malformed');
    expect(stdout).not.toContain('closed-issue');
  });

  it('batches more than one hundred markers', () => {
    const numbers: Record<string, unknown> = {};
    const lines: string[] = [];
    for (let n = 1; n <= 150; n += 1) {
      numbers[String(n)] = ISSUE('OPEN');
      lines.push(`// UNWIRED(#${n}): pending.`);
    }
    const many = makeRepo({ 'src/many.ts': `${lines.join('\n')}\n` });
    const { status, result, calls } = runJson(many, 'markers', {
      github: { max: 3877, numbers },
    });
    expect(status).toBe(0);
    expect(result.findings).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('hygiene issue references check', () => {
  const root = makeRepo({
    'docs/guide.md': [
      '# Guide',
      '',
      'Open work is #12 and station#3877; #5000 is not a Station issue yet.',
      'History is archive#5000; another repository is kirodotdev/Kiro#10416.',
      'Named fully: kontourai/station#4001 and https://github.com/kontourai/station/issues/4002.',
      'Colours #111111 and anchors [x](#4003-heading) are not references.',
      'Inline `#4004` is code.',
      '',
    ].join('\n'),
    'src/code.ts': [
      '// archive#980 was re-filed; this comment still says #980.',
      '// station#4005 regressed here.',
      "const label = '#4006 is a string, not a comment';",
      '',
    ].join('\n'),
    'packages/demo/CHANGELOG.md': '- #4007 release note\n',
    'docs/migration/issue-number-map.json': JSON.stringify({
      mapping: { '4005': 321 },
    }),
  });

  it('reports references above the highest issue or pull request number', () => {
    const { status, result, calls } = runJson(root, 'issue-refs');
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(
      result.findings.map((finding) => finding.detail.split(' ')[0]),
    ).toEqual([
      '#5000',
      'kontourai/station#4001',
      'github.com/kontourai/station/issues/4002',
      'station#4005',
    ]);
    expect(result.findings[3].detail).toContain('(re-filed here as #321)');
    expect(result.summary).toContain('highest number #3877');
  });

  it('reports NOT_VERIFIED when the highest number cannot be read', () => {
    const { status, stdout } = run(root, ['--check', 'issue-refs'], {
      mode: 'offline',
    });
    expect(status).toBe(2);
    expect(stdout).toContain('[hygiene:issue-refs] 0 findings');
    expect(stdout).toContain('[hygiene:issue-refs] NOT_VERIFIED:');
  });
});

describe('hygiene plan label check', () => {
  const root = makeRepo({
    'src-server/routes/knowledge/routes.ts': [
      '/**',
      ' * Wave 1 routes from s203-knowledge-meeting-notes--plan.md.',
      ' */',
      '// MED-4 (security review round 3): bound the read.',
      '// delta-review L1 kept the guard.',
      "const id = 's201-not-a-comment';",
      '// Track 2 owns this.',
      '',
    ].join('\n'),
    'src-server/routes/knowledge/__tests__/routes.test.ts': '// Wave 1 test\n',
    'docs/reviews/workspace-map-20261015/notes.md': 'Wave 2 findings.\n',
    'docs/adr/0001-x.md': 'MED-4 recorded.\n',
    'docs/guides/code-hygiene.md': 'Labels such as `Wave 1` are reported.\n',
  });

  it('reports private labels in maintained comments and prose only', () => {
    const { status, result } = runJson(root, 'plan-labels');
    expect(status).toBe(0);
    expect(result.notVerified).toBeNull();
    expect(located(result.findings)).toEqual([
      'plan-file:src-server/routes/knowledge/routes.ts:2',
      'plan-id:src-server/routes/knowledge/routes.ts:2',
      'wave:src-server/routes/knowledge/routes.ts:2',
      'review-round:src-server/routes/knowledge/routes.ts:4',
      'severity-tag:src-server/routes/knowledge/routes.ts:4',
      'delta-review:src-server/routes/knowledge/routes.ts:5',
      'track:src-server/routes/knowledge/routes.ts:7',
    ]);
  });
});

describe('hygiene module ownership check', () => {
  const root = makeRepo({
    'docs/architecture/module-map.md': [
      '| Module | Purpose | Owner |',
      '| --- | --- | --- |',
      '| Mapped | maps | `packages/mapped/src/index.ts` |',
      '| Sessions | owns | `src-server/services/sessions-store/store.ts` |',
      '',
    ].join('\n'),
    'packages/mapped/src/index.ts': 'export {};\n',
    'packages/documented/README.md': '# Documented\n',
    'packages/documented/src/index.ts': 'export {};\n',
    'packages/orphan/src/index.ts': 'export {};\n',
    'src-server/services/sessions-store/store.ts': 'export {};\n',
    'src-server/services/sessions/service.ts': 'export {};\n',
    'src-server/services/loose-file.ts': 'export {};\n',
  });

  it('reports directories named neither in the module map nor by a README', () => {
    const { status, result } = runJson(root, 'module-ownership');
    expect(status).toBe(0);
    expect(located(result.findings)).toEqual([
      'unowned-module:packages/orphan',
      'unowned-module:src-server/services/sessions',
    ]);
  });

  it('reports NOT_VERIFIED when the module map is missing', () => {
    const bare = makeRepo({ 'packages/a/index.ts': 'export {};\n' });
    const { status, result } = runJson(bare, 'module-ownership');
    expect(status).toBe(2);
    expect(result.notVerified).toContain('module-map.md does not exist');
  });
});

describe('hygiene design status check', () => {
  const issue = (n: number) =>
    `[#${n}](https://github.com/kontourai/station/issues/${n})`;
  const root = makeRepo({
    'docs/design/README.md': '# Design\n',
    'docs/design/closed-draft.md': [
      '# Conversation state',
      '',
      '> **Reading status: draft design with a historical source survey.**',
      '> The survey is dated.',
      '',
      `> Status: **draft for owner review (2026-08-01); tracking issue ${issue(200)}.**`,
      '',
    ].join('\n'),
    'docs/design/open-proposal.md': [
      '# Hosted execution',
      '',
      `> Status: proposed boundary for ${issue(100)}.`,
      '',
    ].join('\n'),
    'docs/design/historical.md': [
      '# Local model calling',
      '',
      '> **Reading status: historical investigation.** Proposal text kept.',
      `> Tracking: ${issue(200)}.`,
      '',
    ].join('\n'),
    'docs/design/untracked.md': [
      '# Terminal',
      '',
      '> **Reading status: proposal (2026-10-17).** Nothing is built.',
      '',
    ].join('\n'),
    'docs/design/archive-only.md': [
      '# Spike',
      '',
      '**Status (2026-09-22):** draft for the archive#1376 spike.',
      '',
    ].join('\n'),
    'docs/design/no-banner.md': [
      '# Developer surface',
      '',
      '```md',
      'Status: proposed',
      '```',
      '',
    ].join('\n'),
    'docs/plans/active-plan.md': [
      '# Issue class prevention',
      '',
      `**Status:** active execution plan, 2026-09-23. Program ${issue(300)}.`,
      '',
    ].join('\n'),
    'docs/design/nested/ignored.md': '# Nested\n',
  });

  it('reports open statuses whose issues closed, untracked open statuses and missing statuses', () => {
    const { status, result, calls } = runJson(root, 'design-status');
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(located(result.findings)).toEqual([
      'untracked-open-status:docs/design/archive-only.md:3',
      'closed-tracking-issue:docs/design/closed-draft.md:3',
      'no-status:docs/design/no-banner.md',
      'untracked-open-status:docs/design/untracked.md:3',
      'closed-tracking-issue:docs/plans/active-plan.md:3',
    ]);
    expect(result.findings[0].detail).toContain('only archive issues');
    expect(result.findings[1].detail).toContain('#200 closed');
    expect(result.findings[4].detail).toContain('#300 merged');
  });

  it('reports NOT_VERIFIED for issue state but still reports offline findings', () => {
    const { status, stdout } = run(root, ['--check', 'design-status'], {
      mode: 'offline',
    });
    expect(status).toBe(2);
    expect(stdout).toContain('[hygiene:design-status] NOT_VERIFIED:');
    expect(stdout).toContain('no-status');
    expect(stdout).not.toContain('closed-tracking-issue');
  });
});

describe('hygiene evidence retention check', () => {
  const root = makeRepo({
    'docs/reviews/kept-20261015/README.md':
      '# Review\n\nRetention: until 2027-01-31\n',
    'docs/reviews/kept-20261015/shot.md': 'evidence\n',
    'docs/reviews/expired-20260101/README.md':
      '# Review\n\nRetention: until 2026-06-30\n',
    'docs/reviews/loose-review.md': 'a file, not a directory\n',
    'docs/strategy/catches/README.md':
      '# Catches\n\nRetention: permanent — promotion evidence for proof families.\n',
    'docs/strategy/dogfood/log.md': 'no readme\n',
    'docs/strategy/onboarding-20261015/README.md':
      '# Onboarding\n\nRetention: forever\n',
    'docs/ui/reviews/mobile-pickers-20261003/a.png.md': 'x\n',
    'docs/ui/reviews/mobile-pickers-20261003/nested-20261002/b.md': 'x\n',
    'docs/learn/review-ledger/records/docs/reviews/kept-20261015/x.json':
      '{}\n',
    'scripts/__tests__/fixtures/run-20260101/x.json': '{}\n',
  });

  it('reports missing, malformed and expired retention lines', () => {
    const out = run(root, [
      '--check',
      'evidence-retention',
      '--json',
      '--today',
      '2026-10-19',
    ]);
    const [result] = JSON.parse(out.stdout) as CheckResult[];
    const status = out.status;
    expect(status).toBe(0);
    expect(located(result.findings)).toEqual([
      'expired-retention:docs/reviews/expired-20260101/README.md',
      'missing-retention:docs/strategy/dogfood',
      'missing-retention:docs/strategy/onboarding-20261015/README.md',
      'missing-retention:docs/ui/reviews/mobile-pickers-20261003',
    ]);
    expect(result.summary).toBe('6 evidence directories');
  });

  it('dates expiry from --today', () => {
    const out = run(root, [
      '--check',
      'evidence-retention',
      '--json',
      '--today',
      '2027-02-01',
    ]);
    const [result] = JSON.parse(out.stdout) as CheckResult[];
    expect(
      result.findings.filter((finding) => finding.kind === 'expired-retention'),
    ).toHaveLength(2);
  });
});

describe('hygiene report CLI', () => {
  it('runs every check, exits 0 when advisory and 1 with --strict', () => {
    const root = makeRepo({
      'docs/architecture/module-map.md': '# Map\n',
      'packages/orphan/index.ts': 'export {};\n',
    });
    const advisory = run(root, []);
    expect(advisory.status).toBe(0);
    for (const id of [
      'markers',
      'issue-refs',
      'plan-labels',
      'module-ownership',
      'design-status',
      'evidence-retention',
    ])
      expect(advisory.stdout).toContain(`[hygiene:${id}]`);
    expect(run(root, ['--strict']).status).toBe(1);
  });

  it('exits 0 under --strict when nothing is outstanding', () => {
    const root = makeRepo({
      'docs/architecture/module-map.md': '`packages/owned/index.ts`\n',
      'packages/owned/index.ts': '// owned\n',
    });
    expect(run(root, ['--strict']).status).toBe(0);
  });

  it('refuses a directory that is not a Git checkout', () => {
    const notRepo = makeTemp('hygiene-plain-');
    const out = run(notRepo, ['--check', 'plan-labels']);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('hygiene: cannot run:');
  });

  it('refuses an unknown check', () => {
    const out = run(makeTemp('hygiene-any-'), ['--check', 'nope']);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--check must be one of');
  });

  it('writes a tracking-issue body that counts findings and NOT_VERIFIED checks', () => {
    const root = makeRepo({
      'docs/architecture/module-map.md': '# Map\n',
      'packages/orphan/index.ts': 'export {};\n',
      'src/a.ts': '// UNWIRED(#100): pending.\n',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root, windowsHide: true },
    );
    const report = join(makeTemp('hygiene-out-'), 'report.md');
    const out = run(root, ['--report', report], { mode: 'offline' });
    expect(out.status).toBe(2);
    const body = readFileSync(report, 'utf8');
    expect(body).toMatch(
      /^<!-- code-hygiene-sweep findings=1 not_verified=2 revision=[a-f0-9]{40} -->$/m,
    );
    expect(body).toContain('**NOT_VERIFIED**');
    expect(body).toContain('- [ ] unowned-module `packages/orphan`');
    expect(reportOutstanding(body)).toBe(3);
  });
});

describe('tracking issue upsert', () => {
  it('keeps one issue per sweep title open while anything is outstanding', () => {
    const reportPath = join(makeTemp('hygiene-upsert-'), 'r.md');
    writeFileSync(reportPath, 'body');
    const calls: string[][] = [];
    const gh = (output: string) => (args: string[]) => {
      calls.push(args);
      return args.includes('search/issues') ? output : '7';
    };
    const base = {
      repo: 'owner/repo',
      reportPath,
      title: HYGIENE_ISSUE_TITLE,
      labels: ['P2'],
    };
    expect(
      upsertTrackingIssue({ ...base, outstanding: 0, gh: gh('') }),
    ).toEqual({ action: 'none' });
    expect(
      upsertTrackingIssue({ ...base, outstanding: 3, gh: gh('') }),
    ).toEqual({ action: 'created', number: 7 });
    expect(
      upsertTrackingIssue({ ...base, outstanding: 0, gh: gh('9\n4') }),
    ).toEqual({ action: 'closed', number: 4 });
    expect(calls.at(-1)).toContain('state=closed');
    expect(() =>
      upsertTrackingIssue({ ...base, repo: 'bad', outstanding: 1, gh: gh('') }),
    ).toThrow('--repo must be owner/name');
  });
});
