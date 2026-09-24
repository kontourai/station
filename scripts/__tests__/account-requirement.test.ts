import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  e2eManifest,
  getSpecsForSuite,
  requiresAccountErrors,
} from '../../tests/e2e-manifest.mjs';
import {
  ACCOUNT_DISABLED_HEADING,
  ACCOUNT_DISABLED_REASON,
  accountsAbsent,
  parseE2EDisabledLines,
  partitionAccountDependentSpecs,
} from '../lib/account-requirement.mjs';
import { projectLatestE2EEvidence } from '../lib/e2e-latest-evidence.mjs';
import { selectAccountRunnableSpecs } from '../run-e2e-suite.mjs';
import {
  feedbackExitCode,
  renderFeedback,
  reviewScreens,
  summarizeJourneys,
} from '../usability-feedback.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ABSENT = { STATION_CI_ACCOUNTS: 'absent' };
const PRESENT = { STATION_CI_ACCOUNTS: 'present' };
const CLI_TURN = 'tests/agents-new-cli-turn.spec.ts';
const MUSE_TURN = 'tests/agents-new-muse-echo-turn.spec.ts';
const PANE_HOST = 'tests/workspace-pane-host-actions-live.spec.ts';
// Undeclared control: a smoke-live spec that talks to a LOCAL model fixture,
// so it needs no account and must never be disabled.
const LOCAL_MODEL = 'tests/pr-smoke-live-chat-send.spec.ts';

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'station-accounts-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A clean env: the host's own CI/account variables must not leak in. */
function childEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !['CI', 'GITHUB_ACTIONS', 'STATION_CI_ACCOUNTS'].includes(key) &&
      !key.startsWith('GITHUB_')
    )
      env[key] = value;
  return { ...env, ...extra };
}

describe('account absence', () => {
  test('explicit switch wins, CI implies absent, local defaults to present', () => {
    expect(accountsAbsent(ABSENT)).toBe(true);
    expect(accountsAbsent({ ...PRESENT, CI: 'true' })).toBe(false);
    expect(accountsAbsent({ CI: 'true' })).toBe(true);
    expect(accountsAbsent({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(accountsAbsent({})).toBe(false);
    expect(accountsAbsent({ STATION_CI_ACCOUNTS: '' })).toBe(false);
  });

  test('a mistyped switch is refused, not guessed', () => {
    expect(() => accountsAbsent({ STATION_CI_ACCOUNTS: 'none' })).toThrow(
      "STATION_CI_ACCOUNTS must be 'absent' or 'present'",
    );
  });
});

describe('E2E declarations', () => {
  test('the declared set is exactly the known account-dependent specs', () => {
    // Pinned independently: a declaration silently dropped (or added) must
    // move this list, not merely shrink a loop.
    expect(
      e2eManifest
        .filter((entry) => 'requiresAccount' in entry)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([CLI_TURN, MUSE_TURN, PANE_HOST]);
  });

  test('a declaration must name the account it needs', () => {
    expect(
      requiresAccountErrors({ path: 'tests/x.spec.ts', requiresAccount: ' ' }),
    ).toEqual([
      'tests/x.spec.ts declares requiresAccount without naming the account it needs.',
    ]);
    expect(
      requiresAccountErrors({ path: 'tests/x.spec.ts', requiresAccount: 1 }),
    ).toHaveLength(1);
    expect(requiresAccountErrors({ path: 'tests/x.spec.ts' })).toEqual([]);
  });

  test('declared specs are disabled when accounts are absent and run when present', () => {
    const specs = getSpecsForSuite('smoke-live');
    const absent = partitionAccountDependentSpecs(specs, e2eManifest, ABSENT);
    expect(absent.disabled.map((entry) => entry.path).sort()).toEqual([
      CLI_TURN,
      MUSE_TURN,
      PANE_HOST,
    ]);
    expect(absent.disabled[0].reason).toBe(ACCOUNT_DISABLED_REASON);
    expect(absent.runnable).toContain(LOCAL_MODEL);
    expect(absent.runnable).toHaveLength(specs.length - 3);

    const present = partitionAccountDependentSpecs(specs, e2eManifest, PRESENT);
    expect(present.disabled).toEqual([]);
    expect(present.runnable).toEqual(specs);
  });

  test('an undeclared spec is never disabled, even with accounts absent', () => {
    for (const suite of ['product', 'extended', 'smoke-live', 'pr-smoke']) {
      const specs = getSpecsForSuite(suite);
      const { disabled } = partitionAccountDependentSpecs(
        specs,
        e2eManifest,
        ABSENT,
      );
      for (const entry of disabled)
        expect(
          e2eManifest.find((candidate) => candidate.path === entry.path)
            ?.requiresAccount,
        ).toBeTypeOf('string');
    }
  });

  test('the runner lists disabled specs in the step summary and a line the coordinator parses', () => {
    const summary = join(scratch(), 'summary.md');
    const log = vi.fn();
    const { runnable } = selectAccountRunnableSpecs(
      'smoke-live',
      [CLI_TURN, LOCAL_MODEL],
      { env: { ...ABSENT, GITHUB_STEP_SUMMARY: summary }, log },
    );
    expect(runnable).toEqual([LOCAL_MODEL]);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain(`### ${ACCOUNT_DISABLED_HEADING}`);
    expect(text).toContain(`| smoke-live: ${CLI_TURN} |`);
    expect(text).not.toContain(LOCAL_MODEL);
    const printed = log.mock.calls.map(([line]) => line).join('\n');
    expect(parseE2EDisabledLines(printed)).toEqual([
      { path: CLI_TURN, requires: 'a signed-in Claude Code or Codex CLI' },
    ]);
  });

  test('nothing is listed or written when accounts are present', () => {
    const summary = join(scratch(), 'summary.md');
    const log = vi.fn();
    const { runnable } = selectAccountRunnableSpecs(
      'smoke-live',
      [CLI_TURN, LOCAL_MODEL],
      { env: { ...PRESENT, GITHUB_STEP_SUMMARY: summary }, log },
    );
    expect(runnable).toEqual([CLI_TURN, LOCAL_MODEL]);
    expect(existsSync(summary)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  test('the suite runner exits before booting when every selected spec is disabled', () => {
    // Real process: skipped at start means no Station, no Playwright, no
    // wait. The runner's own later steps (browser check, Station boot) would
    // print or fail; the early return must reach neither.
    const summary = join(scratch(), 'summary.md');
    const run = spawnSync(
      process.execPath,
      ['scripts/run-e2e-suite.mjs', '--suite=smoke-live', `--spec=${CLI_TURN}`],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: childEnv({ ...ABSENT, GITHUB_STEP_SUMMARY: summary }),
        timeout: 120_000,
        windowsHide: true,
      },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`DISABLED ${CLI_TURN}`);
    expect(run.stdout).toContain('nothing to run');
    expect(run.stdout).not.toContain('started on');
    expect(readFileSync(summary, 'utf8')).toContain(CLI_TURN);
  });

  test('the coordinator report records disabled specs without counting them', () => {
    const output = [
      'Running 26 tests',
      `[e2e-disabled] ${JSON.stringify({ suite: 'smoke-live', path: CLI_TURN, requires: 'x' })}`,
      '[e2e-disabled] {not json',
      `  [e2e-disabled] ${JSON.stringify({ path: 'indented.spec.ts', requires: 'y' })}`,
      '  26 passed (3m)',
    ].join('\r\n');
    expect(parseE2EDisabledLines(output)).toEqual([
      { path: CLI_TURN, requires: 'x' },
    ]);

    const root = scratch();
    mkdirSync(join(root, 'evidence'));
    const manifest = projectLatestE2EEvidence({
      sourceDir: join(root, 'evidence'),
      destinationDir: join(root, '.kontourai', 'e2e-latest'),
      workspaceRoot: root,
      runId: 'run-accounts',
      buckets: [
        {
          name: 'smoke-live',
          verdict: 'PASS',
          counts: { passed: 26 },
          seconds: 1,
          specs: [],
          disabled: parseE2EDisabledLines(output),
          output,
        },
      ],
    });
    expect(manifest.buckets[0].disabled).toEqual([
      { path: CLI_TURN, requires: 'x' },
    ]);
    const index = readFileSync(
      join(root, '.kontourai', 'e2e-latest', 'index.html'),
      'utf8',
    );
    expect(index).toContain(ACCOUNT_DISABLED_HEADING);
    expect(index).toContain(CLI_TURN);
  });
});

describe('usability feedback', () => {
  const walk = {
    routes: ['/'],
    failures: [],
    blockingFindings: [],
    expectedFailures: [],
  };

  test('only a journey the runner disabled becomes DISABLED', () => {
    const checks = summarizeJourneys(walk, {
      results: [
        {
          id: '1-multi-turn-continuity',
          status: 'disabled',
          requires: 'a signed-in claude-code engine CLI',
          notes: [`DISABLED: ${ACCOUNT_DISABLED_REASON}`],
        },
        { id: '2-x', status: 'not-exercised', notes: ['no engine'] },
        { id: '3-x', status: 'skipped', notes: [] },
        { id: '4-x', status: 'passed', notes: [] },
      ],
    });
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ['Fresh-home walkthrough', 'PASS'],
      ['1-multi-turn-continuity', 'DISABLED'],
      ['2-x', 'NOT_VERIFIED'],
      ['3-x', 'NOT_VERIFIED'],
      ['4-x', 'PASS'],
    ]);
  });

  test('the image review is disabled before any request when accounts are absent', async () => {
    const fetchImpl = vi.fn();
    const visual = await reviewScreens(
      [{ id: 'a', bytes: Buffer.from('png') }],
      { apiKey: 'sk-present', model: 'm', fetchImpl, accountsAbsent: true },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(visual.status).toBe('DISABLED');
    expect(visual.detail).toContain(ACCOUNT_DISABLED_REASON);
  });

  test('DISABLED never moves the exit code; other NOT_VERIFIED and FAIL still do', () => {
    const disabled = { name: 'd', status: 'DISABLED', detail: '' };
    const pass = { name: 'p', status: 'PASS', detail: '' };
    expect(feedbackExitCode([pass, disabled], disabled)).toBe(0);
    expect(
      feedbackExitCode(
        [disabled, { name: 'n', status: 'NOT_VERIFIED', detail: '' }],
        disabled,
      ),
    ).toBe(2);
    expect(
      feedbackExitCode([disabled], { status: 'NOT_VERIFIED', detail: '' }),
    ).toBe(2);
    expect(
      feedbackExitCode([disabled, { name: 'f', status: 'FAIL', detail: '' }], {
        status: 'DISABLED',
      }),
    ).toBe(1);
  });

  test('the report lists every disabled check under its own heading', () => {
    const markdown = renderFeedback({
      revision: 'a'.repeat(40),
      checks: [
        {
          name: '1-multi-turn-continuity',
          status: 'DISABLED',
          requires: 'a signed-in claude-code engine CLI',
          detail: 'x',
        },
        { name: 'Other', status: 'PASS', detail: 'y' },
      ],
      visual: {
        status: 'DISABLED',
        requires: 'a funded image-review API credential',
        findings: [],
        detail: 'z',
      },
    });
    const section = markdown.slice(
      markdown.indexOf(`## ${ACCOUNT_DISABLED_HEADING}`),
      markdown.indexOf('## Candidate findings'),
    );
    expect(section).toContain(
      '| 1-multi-turn-continuity | a signed-in claude-code engine CLI |',
    );
    expect(section).toContain(
      '| Semantic image review | a funded image-review API credential |',
    );
    expect(section).not.toContain('| Other |');
  });

  function feedbackRun(journeys: unknown, extraEnv: Record<string, string>) {
    const input = scratch();
    const output = join(input, 'report');
    mkdirSync(join(input, 'fresh-home-walkthrough'), { recursive: true });
    mkdirSync(join(input, 'core-loop-journeys'), { recursive: true });
    writeFileSync(
      join(input, 'fresh-home-walkthrough', 'summary.json'),
      JSON.stringify(walk),
    );
    writeFileSync(
      join(input, 'core-loop-journeys', 'summary.json'),
      JSON.stringify(journeys),
    );
    const run = spawnSync(
      process.execPath,
      ['scripts/usability-feedback.mjs', input, output],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: childEnv({
          UI_AUDIT_REVISION: 'b'.repeat(40),
          UI_SWEEP_RESULT: 'success',
          // A key that would be sent if the review were attempted: the
          // DISABLED decision must win before any request.
          OPENAI_API_KEY: 'sk-must-not-be-used',
          OPENAI_BASE_URL: 'http://127.0.0.1:9/unreachable',
          ...extraEnv,
        }),
        timeout: 60_000,
        windowsHide: true,
      },
    );
    return {
      run,
      report: existsSync(join(output, 'report.md'))
        ? readFileSync(join(output, 'report.md'), 'utf8')
        : '',
    };
  }

  const disabledJourneys = {
    results: [
      {
        id: '1-multi-turn-continuity',
        status: 'disabled',
        requires: 'a signed-in claude-code engine CLI',
        notes: ['DISABLED'],
      },
      { id: '4-pairing-delegation-loop', status: 'passed', notes: [] },
    ],
  };

  test('in CI, disabled journeys and the disabled review exit 0 and are listed', () => {
    const { run, report } = feedbackRun(disabledJourneys, ABSENT);
    expect(run.status).toBe(0);
    expect(report).toContain(`## ${ACCOUNT_DISABLED_HEADING}`);
    expect(report).toContain('| Semantic image review | DISABLED |');
    expect(report).toContain('| 1-multi-turn-continuity | DISABLED |');
  });

  test('known-bad control: a not-exercised journey in CI still exits 2', () => {
    const { run, report } = feedbackRun(
      {
        results: [
          ...disabledJourneys.results,
          { id: '3-x', status: 'not-exercised', notes: ['no engine'] },
        ],
      },
      ABSENT,
    );
    expect(run.status).toBe(2);
    expect(report).toContain('| 3-x | NOT_VERIFIED |');
  });

  test('known-bad control: with accounts present the review is attempted and its failure is NOT_VERIFIED', () => {
    const { run, report } = feedbackRun(disabledJourneys, PRESENT);
    expect(run.status).toBe(2);
    expect(report).toContain('| Semantic image review | NOT_VERIFIED |');
  });
});

describe('core-loop journey declarations', () => {
  test('exactly the engine journeys declare the account requirement', () => {
    // Structural: the journey runner boots a real Station, so this pins the
    // declarations; the runtime DISABLED path is exercised by the workflow.
    const source = readFileSync(
      join(ROOT, 'tests/live/core-loop-journeys.mjs'),
      'utf8',
    );
    const calls = [...source.matchAll(/await runJourney\(\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(calls).toEqual([
      '1-multi-turn-continuity',
      '3-project-deep-link-reload',
      '4-pairing-delegation-loop',
    ]);
    const declared = [
      ...source.matchAll(
        /await runJourney\(\s*'([^']+)'[^;]*?\{ requiresAccount: ENGINE_ACCOUNT \},\s*\);/gs,
      ),
    ].map((match) => match[1]);
    expect(declared).toEqual([
      '1-multi-turn-continuity',
      '3-project-deep-link-reload',
    ]);
  });
});
