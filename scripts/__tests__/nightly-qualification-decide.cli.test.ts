import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

/**
 * Runs the qualified-Nightly decide script as the workflow does: a child
 * process in a real git checkout, reading the ledger from `origin/main` and
 * peeling generated ledger commit-backs with git. The properties under test
 * are the exit status and what reaches `$GITHUB_OUTPUT`.
 */

const SCRIPT = join(process.cwd(), 'scripts/nightly-qualification-decide.mjs');
const LEDGER = 'docs/reference/deploy-ledger.json';
const LEDGER_MD = 'docs/reference/deploy-ledger.md';
const makeTempDir = trackTempDirs();

function fixture() {
  const repo = makeTempDir('nightly-qualification-decide-');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
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
  git('init', '--quiet', '--initial-branch=main');
  const commit = (rows: unknown[], subject: string) => {
    mkdirSync(join(repo, 'docs/reference'), { recursive: true });
    writeFileSync(join(repo, LEDGER), `${JSON.stringify(rows, null, 2)}\n`);
    writeFileSync(join(repo, LEDGER_MD), `${subject}\n`);
    git('add', '--', LEDGER, LEDGER_MD);
    git('commit', '--quiet', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  const run = (source: string, reservations = '') => {
    const out = makeTempDir('nightly-qualification-decide-out-');
    const output = join(out, 'output');
    const refs = join(out, 'refs');
    writeFileSync(output, '');
    writeFileSync(refs, reservations);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--source-sha', source, '--reservation-refs', refs],
      {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(output, 'utf8'),
    };
  };
  return { git, commit, run };
}

const row = (channel: string, sha: string, timestampUtc: string) => ({
  timestampUtc,
  channel,
  version: '0.1.11-nightly.2466.3',
  sha,
  workflowRunUrl: 'https://github.com/kontourai/station/actions/runs/1',
  artifacts: ['x'],
  gateResult: 'native cohort final receipt complete',
  notes: null,
});

describe('nightly-qualification-decide CLI against a git repository', () => {
  it('reads origin/main, peels the ship’s own ledger commit-backs, and publishes a newer source', () => {
    const { git, commit, run } = fixture();
    const source = commit([], 'feat: a source change');
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    // The cohort's record job writes the row as a ledger-only commit-back.
    const ledgerBack = commit(
      [
        row('nightly-android', source, longAgo),
        row('nightly-desktop', source, longAgo),
      ],
      'docs(ledger): record nightly-android 0.1.11-nightly.2466.3 from run 37021990417',
    );

    // No origin/main: refuse rather than read the checkout.
    const missing = run(ledgerBack);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`git show origin/main:${LEDGER}`);
    expect(missing.output).toBe('');

    git('update-ref', 'refs/remotes/origin/main', ledgerBack);
    // Qualifying the commit-back must not republish the source it records.
    const idle = run(ledgerBack);
    expect(idle.status, idle.stderr).toBe(0);
    expect(idle.output).toBe('publish=false\n');
    expect(idle.stdout).toContain(`already published`);

    // A real change after the ship, two days later: publish.
    writeFileSync(join(git('rev-parse', '--show-toplevel'), 'src.txt'), 'x\n');
    git('add', 'src.txt');
    git('commit', '--quiet', '-m', 'fix: a real change');
    const change = git('rev-parse', 'HEAD');
    const fresh = run(change);
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.output).toBe('publish=true\n');

    // The same change, already reserved by a Nightly that did not finish.
    const reserved = run(
      change,
      `${change}\trefs/tags/nightly-version-code/246700\n`,
    );
    expect(reserved.status, reserved.stderr).toBe(0);
    expect(reserved.output).toBe('publish=false\n');
  });
});
