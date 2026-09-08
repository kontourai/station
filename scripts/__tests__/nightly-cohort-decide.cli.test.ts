import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #1780: the decide CLI must read the deploy ledger from `origin/main`, not
 * from the checkout. The stage job checks out the SOURCE SHA under decision
 * and ledger rows land on main after a ship, so the checkout's ledger can
 * never hold the row for its own marker. This runs the real script against
 * a throwaway git repository whose checkout ledger and `origin/main` ledger
 * DISAGREE, and asserts the observed exit status and `$GITHUB_OUTPUT`.
 */

const SCRIPT = join(process.cwd(), 'scripts/nightly-cohort-decide.mjs');
const NORMALIZER = join(
  process.cwd(),
  'scripts/normalize-deploy-ledger-head.mjs',
);
const COHORT_WORKFLOW = join(
  process.cwd(),
  '.github/workflows/nightly-native-cohort.yml',
);
const LEDGER = 'docs/reference/deploy-ledger.json';
const LEDGER_MD = 'docs/reference/deploy-ledger.md';
const HEAD = 'a'.repeat(40);

function row(channel: string, sha: string) {
  return {
    timestampUtc: '2026-09-07T09:30:00Z',
    channel,
    version: '0.1.2-nightly.2441',
    sha,
    workflowRunUrl: 'https://github.com/kontourai/station/actions/runs/1',
    artifacts: ['x'],
    gateResult: 'native cohort final receipt complete',
    notes: [],
  };
}

let repo: string;

function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
}

function commitLedger(content: string, subject: string) {
  mkdirSync(join(repo, 'docs/reference'), { recursive: true });
  writeFileSync(join(repo, LEDGER), content, 'utf8');
  git('add', '--', LEDGER);
  git('commit', '--quiet', '-m', subject);
  return git('rev-parse', 'HEAD');
}

/** The subject the cohort's record job writes for `channel`, read from the
 * workflow itself with its shell variables substituted — so this fixture is
 * bound to the writer, not to a string the test happens to agree with. */
function cohortLedgerSubject(channel: string, version: string, runId: string) {
  const workflow = readFileSync(COHORT_WORKFLOW, 'utf8');
  const subjects = Array.from(
    workflow.matchAll(/--commit-subject "([^"]+)"/g),
    (m) => m[1],
  ).filter((subject) => subject.includes(channel));
  expect(subjects, `one cohort subject for ${channel}`).toHaveLength(1);
  return subjects[0]
    .replace(/\$GITHUB_RUN_ID\b/g, runId)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, version);
}

function commitLedgerPair(json: string, subject: string) {
  mkdirSync(join(repo, 'docs/reference'), { recursive: true });
  writeFileSync(join(repo, LEDGER), json, 'utf8');
  writeFileSync(join(repo, LEDGER_MD), `# ledger\n${subject}\n`, 'utf8');
  git('add', '--', LEDGER, LEDGER_MD);
  git('commit', '--quiet', '-m', subject);
  return git('rev-parse', 'HEAD');
}

function normalize(headSha: string, stopSha: string) {
  return spawnSync(
    process.execPath,
    [NORMALIZER, '--head-sha', headSha, '--stop-sha', stopSha],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  );
}

function run(extra: string[] = []) {
  const outputDir = mkdtempSync(join(tmpdir(), 'nightly-cohort-decide-out-'));
  const githubOutput = join(outputDir, 'output');
  const summary = join(outputDir, 'summary');
  writeFileSync(githubOutput, '');
  writeFileSync(summary, '');
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--head-sha',
      HEAD,
      '--android-marker',
      HEAD,
      '--android-candidate',
      HEAD,
      '--desktop-marker',
      HEAD,
      '--desktop-candidate',
      HEAD,
      ...extra,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  const captured = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(githubOutput, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
  };
  rmSync(outputDir, { recursive: true, force: true });
  return captured;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'nightly-cohort-decide-'));
  git('init', '--quiet', '--initial-branch=main');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('nightly-cohort-decide CLI against a git repository', () => {
  it('decides from origin/main ledger, not the checkout, and fails closed without the ref', () => {
    // origin/main: Android row only (the #1780 partial night).
    const androidOnly = commitLedger(
      `${JSON.stringify([row('nightly-android', HEAD)], null, 2)}\n`,
      'docs(ledger): record nightly-android 0.1.2-nightly.2441 from run 1',
    );

    // No origin/main ref yet: the CLI must refuse rather than read HEAD.
    const missingRef = run();
    expect(missingRef.status).toBe(1);
    expect(missingRef.stderr).toContain('::error::');
    expect(missingRef.stderr).toContain(`git show origin/main:${LEDGER}`);
    expect(missingRef.output).toBe('');

    git('update-ref', 'refs/remotes/origin/main', androidOnly);

    // The CHECKOUT now carries both rows (as if a later commit or a working
    // tree edit recorded macOS); origin/main still has Android only. A CLI
    // reading the checkout would say no cohort is needed.
    commitLedger(
      `${JSON.stringify([row('nightly-desktop', HEAD), row('nightly-android', HEAD)], null, 2)}\n`,
      'docs(ledger): record nightly-desktop 0.1.2-nightly.2441 from run 2',
    );

    const partial = run();
    expect(partial.status).toBe(0);
    expect(partial.output).toBe('build=true\n');
    expect(partial.summary).toContain(
      'macos: marker at HEAD without a ledger row for this source',
    );
    expect(partial.summary).not.toContain('android:');

    // Move origin/main to the checkout's both-rows commit: no cohort needed.
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    const complete = run();
    expect(complete.status).toBe(0);
    expect(complete.output).toBe('build=false\n');
    expect(complete.summary).toBe(
      'No native cohort is needed for this source.\n',
    );

    // An explicit rebuild index still forces a build against the same ledger.
    const rebuild = run(['--rebuild-index', '2']);
    expect(rebuild.status).toBe(0);
    expect(rebuild.output).toBe('build=true\n');
    expect(rebuild.summary).toContain('rebuild_index=2');
  });

  it("peels the cohort record job's own ledger commits back to the source (#1802)", () => {
    // Real history after run 34252063142: source fd2c04e86 shipped, then
    // main gained the npm row, the Android row, and the desktop row as three
    // ledger-only commits. The cohort's subjects lacked `from run N`, so the
    // last two never peeled and an idle main read as "behind source".
    const source = commitLedgerPair(
      `${JSON.stringify([], null, 2)}\n`,
      'feat: a source change',
    );
    const androidRow = commitLedgerPair(
      `${JSON.stringify([row('nightly-android', source)], null, 2)}\n`,
      cohortLedgerSubject(
        'nightly-android',
        '0.1.11-nightly.2442.5',
        '34252063142',
      ),
    );
    const desktopRow = commitLedgerPair(
      `${JSON.stringify([row('nightly-desktop', source), row('nightly-android', source)], null, 2)}\n`,
      cohortLedgerSubject(
        'nightly-desktop',
        '0.1.11-nightly.2442.5',
        '34252063142',
      ),
    );
    expect(androidRow).not.toBe(source);
    expect(desktopRow).not.toBe(androidRow);

    for (const stop of ['', source]) {
      const peeled = normalize(desktopRow, stop);
      expect(peeled.status, peeled.stderr).toBe(0);
      expect(peeled.stdout.trim()).toBe(source);
    }

    // Known-bad control: the pre-#1802 subject shape does not peel, which is
    // the defect this fixture exists to keep closed at the writer.
    const legacy = commitLedgerPair(
      `${JSON.stringify([row('nightly-desktop', source), row('nightly-android', source)], null, 2)}\n`,
      'docs(ledger): record finalized nightly-desktop 0.1.11-nightly.2442.5',
    );
    const stuck = normalize(legacy, source);
    expect(stuck.status).toBe(0);
    expect(stuck.stdout.trim()).toBe(legacy);

    // With the source peeled out and both rows at the source, the decision
    // the workflow makes next is "no cohort" — end to end.
    git('update-ref', 'refs/remotes/origin/main', desktopRow);
    const decided = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--head-sha',
        desktopRow,
        '--android-marker',
        source,
        '--android-candidate',
        source,
        '--desktop-marker',
        source,
        '--desktop-candidate',
        source,
      ],
      { cwd: repo, encoding: 'utf8', windowsHide: true },
    );
    expect(decided.status, decided.stderr).toBe(0);
    expect(decided.stdout).toContain('build=false');
  });

  it('fails closed on a malformed ledger at origin/main', () => {
    const malformed = commitLedger(
      '{"entries":[]}\n',
      'docs: break the ledger shape',
    );
    git('update-ref', 'refs/remotes/origin/main', malformed);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deploy ledger must be a JSON array');
    expect(result.output).toBe('');

    const notJson = commitLedger('not json\n', 'docs: break the ledger bytes');
    git('update-ref', 'refs/remotes/origin/main', notJson);
    const unparsable = run();
    expect(unparsable.status).toBe(1);
    expect(unparsable.stderr).toContain('is not valid JSON');
    expect(unparsable.output).toBe('');
  });
});
