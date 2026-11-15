import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitLedgerWithRetry } from '../lib/deploy-ledger-commit.mjs';

const scriptRoot = resolve(import.meta.dirname, '..');
const APPENDER = resolve(scriptRoot, 'deploy-ledger.mjs');

const SEED_TIMESTAMP = '2026-08-20T09:00:00Z';
const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** A valid seed entry so every clone starts from a non-empty ledger. */
function seedLedgerJson() {
  return [
    {
      timestampUtc: SEED_TIMESTAMP,
      channel: 'nightly-android',
      version: '0.1.2-nightly.2430',
      sha: 'c4229f43f7569e96874c25356d1199fa01cbfec1',
      workflowRunUrl: null,
      artifacts: [
        'play-internal-aab:io.kontourai.station.nightly@versionCode 243000',
      ],
      gateResult: 'seed gate sentence',
      notes: null,
      changelog: {
        previousSha: null,
        groups: { feat: [], fix: [], ci: [], docs: [], other: [] },
        note: 'First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.',
        commitCount: 0,
      },
    },
  ];
}

/**
 * A bare origin with one seed commit on main carrying the two ledger files,
 * plus two clones (the two concurrent writers). Everything is local
 * filesystem git — no network, no tokens.
 */
function makeTwoWriterScratch() {
  const root = mkdtempSync(join(tmpdir(), 'station-ledger-twowriter-'));
  const origin = join(root, 'origin.git');
  const seedWork = join(root, 'seed-work');
  git(root, 'init', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', origin, 'seed-work');
  mkdirSync(join(seedWork, 'docs/reference'), { recursive: true });
  writeFileSync(
    join(seedWork, 'docs/reference/deploy-ledger.json'),
    `${JSON.stringify(seedLedgerJson(), null, 2)}\n`,
  );
  writeFileSync(
    join(seedWork, 'docs/reference/deploy-ledger.md'),
    '# Deploy ledger (seed)\n',
  );
  git(
    seedWork,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'add',
    'docs/reference/deploy-ledger.json',
    'docs/reference/deploy-ledger.md',
  );
  git(
    seedWork,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'seed ledger',
  );
  git(seedWork, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const seedSha = git(seedWork, 'rev-parse', 'HEAD').trim();
  const writerA = join(root, 'writer-a');
  const writerB = join(root, 'writer-b');
  git(root, 'clone', '-q', origin, 'writer-a');
  git(root, 'clone', '-q', origin, 'writer-b');
  return { root, origin, seedSha, writerA, writerB };
}

/** The appender argv one workflow passes, pointed at a scratch clone. */
function recordArgv(
  clone: string,
  {
    channel,
    version,
    sha,
    artifact,
  }: {
    channel: string;
    version: string;
    sha: string;
    artifact: string;
  },
) {
  return [
    process.execPath,
    APPENDER,
    '--repo-root',
    clone,
    '--channel',
    channel,
    '--version',
    version,
    '--sha',
    sha,
    '--timestamp',
    SEED_TIMESTAMP,
    '--gate-result',
    'scratch gate success',
    '--github-repo',
    'kontourai/station',
    '--artifact',
    artifact,
  ];
}

function testEnv(summaryPath?: string) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GITHUB_TOKEN;
  if (summaryPath !== undefined) env.GITHUB_STEP_SUMMARY = summaryPath;
  else delete env.GITHUB_STEP_SUMMARY;
  return env;
}

function originLedger(origin: string) {
  const raw = git(origin, 'show', 'main:docs/reference/deploy-ledger.json');
  return JSON.parse(raw) as Array<{
    channel: string;
    version: string;
    sha: string;
    artifacts: string[];
    changelog: { note: string | null; commitCount: number };
  }>;
}

describe('deploy-ledger commit-back with bounded re-derive-and-retry (MED-2)', () => {
  it('converges when the other writer lands between this writer\u2019s derive and its push', () => {
    const { origin, seedSha, writerA, writerB } = makeTwoWriterScratch();
    // Writer B's own full record+commit, run from writer B's clone at the
    // exact moment writer A has derived but not yet pushed (onBeforePush).
    const landWriterB = () =>
      commitLedgerWithRetry({
        repoRoot: writerB,
        recordArgv: recordArgv(writerB, {
          channel: 'stable-desktop',
          version: '1.0.0',
          sha: B_SHA,
          artifact: 'github-release:v1.0.0',
        }),
        commitSubject: 'docs(ledger): record stable-desktop 1.0.0',
        env: testEnv(),
      });
    const result = commitLedgerWithRetry({
      repoRoot: writerA,
      recordArgv: recordArgv(writerA, {
        channel: 'stable-npm',
        version: '0.4.1',
        sha: A_SHA,
        artifact: 'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
      }),
      commitSubject: 'docs(ledger): record stable-npm 0.4.1',
      requireAncestorSha: seedSha, // positive control: on-main sha passes the guard
      env: testEnv(),
      onBeforePush: (attempt) => {
        if (attempt === 1) landWriterB();
      },
    });
    // Attempt 1 derived from the pre-B main and was rejected; attempt 2
    // re-derived from post-B main and pushed. That is the convergence.
    expect(result.pushed).toBe(true);
    expect(result.attempts).toBe(2);
    const ledger = originLedger(origin);
    expect(ledger.map((e) => `${e.channel}@${e.version}`)).toEqual([
      'stable-npm@0.4.1',
      'stable-desktop@1.0.0',
      'nightly-android@0.1.2-nightly.2430',
    ]);
    // Neither writer's entry lost fields to the race.
    expect(ledger[0].artifacts).toEqual([
      'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
    ]);
    // History is append-only: the seed commit remains an ancestor of main,
    // and every commit the writers added touches ONLY the ledger files.
    git(writerA, 'fetch', '-q', 'origin');
    expect(() =>
      git(writerA, 'merge-base', '--is-ancestor', seedSha, 'origin/main'),
    ).not.toThrow();
    const changed = git(
      writerA,
      'diff',
      '--name-only',
      `${seedSha}..origin/main`,
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(changed.sort()).toEqual([
      'docs/reference/deploy-ledger.json',
      'docs/reference/deploy-ledger.md',
    ]);
  });

  it('refuses an off-main required ancestor before recording or pushing anything (MED-4)', () => {
    const { origin, writerA } = makeTwoWriterScratch();
    git(writerA, 'checkout', '-q', '-b', 'off-main');
    writeFileSync(join(writerA, 'off-main.txt'), 'tag cut off main\n');
    git(writerA, 'add', 'off-main.txt');
    git(
      writerA,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'off-main commit',
    );
    const offMainSha = git(writerA, 'rev-parse', 'HEAD').trim();
    git(writerA, 'checkout', '-q', 'main');
    const before = git(origin, 'rev-parse', 'main').trim();
    expect(() =>
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgv: recordArgv(writerA, {
          channel: 'stable-desktop',
          version: '1.0.0',
          sha: B_SHA,
          artifact: 'github-release:v1.0.0',
        }),
        commitSubject: 'docs(ledger): record stable-desktop 1.0.0',
        requireAncestorSha: offMainSha,
        env: testEnv(),
      }),
    ).toThrow(/not an ancestor/);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(before);
    // The refusal happened BEFORE the record: the clone's ledger files are
    // still the untouched seed state.
    const cloneLedger = JSON.parse(
      readFileSync(join(writerA, 'docs/reference/deploy-ledger.json'), 'utf8'),
    ) as unknown[];
    expect(cloneLedger).toHaveLength(1);
  });

  it('fails loud after three failed attempts and leaves the summary fallback intact', () => {
    const { root, origin, writerA } = makeTwoWriterScratch();
    const summaryPath = join(root, 'summary.md');
    const before = git(origin, 'rev-parse', 'main').trim();
    // Every push fails: the push URL points nowhere. Fetches still work
    // (they use the origin URL), so the loop genuinely re-derives three
    // times before giving up.
    git(
      writerA,
      'remote',
      'set-url',
      '--push',
      'origin',
      '/nonexistent/repo.git',
    );
    expect(() =>
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgv: recordArgv(writerA, {
          channel: 'stable-npm',
          version: '0.4.1',
          sha: A_SHA,
          artifact: 'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
        }),
        commitSubject: 'docs(ledger): record stable-npm 0.4.1',
        summaryLine: '- recorded: `stable-npm 0.4.1` at `aaaaaaa`',
        env: testEnv(summaryPath),
      }),
    ).toThrow(/after 3 attempts/);
    // The ship IS recorded locally and named in the summary; main is
    // untouched. That is the fail-loud + fallback contract.
    const local = JSON.parse(
      readFileSync(join(writerA, 'docs/reference/deploy-ledger.json'), 'utf8'),
    ) as Array<{ version: string }>;
    expect(local.map((e) => e.version)).toEqual([
      '0.4.1',
      '0.1.2-nightly.2430',
    ]);
    expect(readFileSync(summaryPath, 'utf8')).toContain(
      '- recorded: `stable-npm 0.4.1`',
    );
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it('refuses a true duplicate re-record — the basis of retry safety', () => {
    const { origin, writerA } = makeTwoWriterScratch();
    const argv = recordArgv(writerA, {
      channel: 'stable-npm',
      version: '0.4.1',
      sha: A_SHA,
      artifact: 'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
    });
    expect(
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgv: argv,
        commitSubject: 'docs(ledger): record stable-npm 0.4.1',
        env: testEnv(),
      }).pushed,
    ).toBe(true);
    const before = git(origin, 'rev-parse', 'main').trim();
    // Re-running the same record against main (which now HAS the entry) is
    // refused by the appender's duplicate identity, loudly and without a
    // retry loop that could double-record.
    expect(() =>
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgv: argv,
        commitSubject: 'docs(ledger): record stable-npm 0.4.1',
        env: testEnv(),
      }),
    ).toThrow(/not retryable/);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it('refuses malformed record groups and subject choices before touching git', () => {
    const { origin, writerA } = makeTwoWriterScratch();
    const before = git(origin, 'rev-parse', 'main').trim();
    const helper = resolve(scriptRoot, 'lib/deploy-ledger-commit.mjs');
    const record = recordArgv(writerA, {
      channel: 'stable-npm',
      version: '0.4.1',
      sha: A_SHA,
      artifact: 'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
    });
    for (const [label, args, reason] of [
      [
        'an empty record group',
        ['--subject-run-id', '7', '--record', '--record', ...record],
        /every --record group/,
      ],
      [
        'both subject flags',
        [
          '--commit-subject',
          'docs(ledger): x',
          '--subject-run-id',
          '7',
          '--',
          ...record,
        ],
        /usage/,
      ],
      ['no subject', ['--record', ...record], /usage/],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        [helper, '--repo-root', writerA, ...args],
        { encoding: 'utf8', windowsHide: true, env: testEnv() },
      );
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toMatch(reason);
    }
    expect(() =>
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgvs: [record],
        subjectRunId: '0',
        env: testEnv(),
      }),
    ).toThrow(/positive decimal run id/);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it('refuses a derived subject the head normalizer would not peel, with nothing committed', () => {
    const { origin, writerA } = makeTwoWriterScratch();
    const before = git(origin, 'rev-parse', 'main').trim();
    // A row whose channel the subject shape does not know (a channel added
    // to the ledger without updating GENERATED_LEDGER_SUBJECT): the record
    // writes it, the derived subject cannot peel, and the helper must refuse.
    const writeUnknownChannel = [
      process.execPath,
      '-e',
      `const fs = require('node:fs');
       const path = 'docs/reference/deploy-ledger.json';
       const rows = JSON.parse(fs.readFileSync(path, 'utf8'));
       rows.unshift({ ...rows[0], channel: 'nightly-ios', version: '1.0.0' });
       fs.writeFileSync(path, JSON.stringify(rows, null, 2) + '\\n');
       fs.appendFileSync('docs/reference/deploy-ledger.md', 'ios\\n');`,
    ];
    expect(() =>
      commitLedgerWithRetry({
        repoRoot: writerA,
        recordArgvs: [writeUnknownChannel],
        subjectRunId: '7',
        env: testEnv(),
      }),
    ).toThrow(
      /does not match the shape normalize-deploy-ledger-head\.mjs peels/,
    );
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it("leaves the caller's other tracked edits and untracked files alone, in both modes", () => {
    const { origin, writerA } = makeTwoWriterScratch();
    writeFileSync(join(writerA, 'tracked.txt'), 'committed\n');
    git(writerA, 'add', 'tracked.txt');
    git(
      writerA,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'add a tracked file',
    );
    git(writerA, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    writeFileSync(join(writerA, 'tracked.txt'), 'edited by an earlier step\n');
    writeFileSync(join(writerA, 'untracked.txt'), 'left by an earlier step\n');
    const single = recordArgv(writerA, {
      channel: 'stable-npm',
      version: '0.4.1',
      sha: A_SHA,
      artifact: 'npm:one',
    });
    const multi = recordArgv(writerA, {
      channel: 'stable-desktop',
      version: '1.0.0',
      sha: B_SHA,
      artifact: 'github-release:v1.0.0',
    });
    const modes: Array<
      [
        string,
        Pick<
          Parameters<typeof commitLedgerWithRetry>[0],
          'recordArgv' | 'recordArgvs' | 'commitSubject' | 'subjectRunId'
        >,
      ]
    > = [
      [
        '--commit-subject --',
        {
          recordArgv: single,
          commitSubject: 'docs(ledger): record stable-npm 0.4.1 from run 1',
        },
      ],
      [
        '--subject-run-id --record',
        { recordArgvs: [multi], subjectRunId: '2' },
      ],
    ];
    for (const [label, options] of modes) {
      const before = git(origin, 'rev-parse', 'main').trim();
      expect(
        commitLedgerWithRetry({ repoRoot: writerA, env: testEnv(), ...options })
          .pushed,
        label,
      ).toBe(true);
      expect(readFileSync(join(writerA, 'tracked.txt'), 'utf8'), label).toBe(
        'edited by an earlier step\n',
      );
      expect(readFileSync(join(writerA, 'untracked.txt'), 'utf8'), label).toBe(
        'left by an earlier step\n',
      );
      expect(
        git(origin, 'diff', '--name-only', `${before}..main`)
          .trim()
          .split('\n')
          .sort(),
        label,
      ).toEqual([
        'docs/reference/deploy-ledger.json',
        'docs/reference/deploy-ledger.md',
      ]);
    }
  });
});
