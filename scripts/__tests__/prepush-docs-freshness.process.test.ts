import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutFreshnessEnv } from '../lib/documentation-freshness.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import {
  commit,
  fixture,
  git,
  makeTempDir,
  record_,
  run,
} from './helpers/documentation-freshness-fixture.js';

/**
 * The real pre-push hook, run by a real `git push`, over a fixture repository
 * with a real review ledger (the freshness suite's own fixture, migrated to
 * the notes layout). The docs-freshness step is the real decision script
 * calling the real `docs:freshness:check`; notes are recorded with the real
 * `docs:review:record`. Only the unrelated gates are recorders.
 *
 * docs/a.md cites src/a.ts in the fixture ledger.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const REAL_CHECK = join(REPO_ROOT, 'scripts/check-documentation-freshness.mjs');

const HARNESS_SCRIPTS = [
  'prepush-pure-merge.mjs',
  'prepush-main-conflict.mjs',
  'heavy-check-slot.mjs',
  'check-prepush-docs-freshness.mjs',
];
const RECORDED_GATES = [
  'scripts/check-prepush-push-range.mjs',
  'scripts/check-prepush-orchestration-transfer.mjs',
  'scripts/check-prepush-static-gates.mjs',
  'scripts/check-prepush-sdk-barrel.mjs',
];

function hookFixture() {
  const f = fixture();
  const repo = f.root;
  expect(run(repo, 'migrate-review-ledger.mjs', ['--path-only']).status).toBe(
    0,
  );
  commit(repo, 'migrate review ledger');
  const root = realpathSync(makeTempDir('station-prepush-docs-'));
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const report = join(root, 'gates.log');
  git(root, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main']);
  git(repo, ['switch', '-qc', 'feat']);
  git(repo, ['fetch', '-q', 'origin']);

  mkdirSync(join(repo, '.githooks'));
  writeFileSync(
    join(repo, '.githooks', 'pre-push'),
    readFileSync(join(REPO_ROOT, '.githooks/pre-push')),
    { mode: 0o755 },
  );
  cpSync(join(REPO_ROOT, 'scripts/lib'), join(repo, 'scripts/lib'), {
    recursive: true,
  });
  for (const script of HARNESS_SCRIPTS)
    writeFileSync(
      join(repo, 'scripts', script),
      readFileSync(join(REPO_ROOT, 'scripts', script)),
    );
  for (const shared of [
    'packages/shared/src/process-identity.mjs',
    'packages/shared/src/windows-system-utility.mjs',
  ]) {
    mkdirSync(join(repo, shared, '..'), { recursive: true });
    writeFileSync(join(repo, shared), readFileSync(join(REPO_ROOT, shared)));
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(repo, 'node_modules'));
  // The real check, run against this fixture as its working directory, the
  // way the freshness suite runs it.
  const installRealCheck = () =>
    writeFileSync(
      join(repo, 'scripts/check-documentation-freshness.mjs'),
      `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, [${JSON.stringify(REAL_CHECK)}, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });\nprocess.exit(r.status ?? 1);\n`,
    );
  installRealCheck();
  for (const gate of RECORDED_GATES)
    writeFileSync(
      join(repo, gate),
      `import { appendFileSync, readFileSync } from 'node:fs';\n${gate.includes('push-range') ? 'readFileSync(0);\n' : ''}appendFileSync(${JSON.stringify(report)}, ${JSON.stringify(`${gate}\n`)});\n`,
    );
  writeFileSync(
    join(repo, '.git', 'info', 'exclude'),
    ['.githooks/', '/scripts/', '/packages/', '/node_modules'].join('\n'),
  );
  mkdirSync(bin);
  const record = `require('node:fs').appendFileSync(${JSON.stringify(report)}, gate + '\\n');`;
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}\nconst gate = process.argv.at(-1);\n${record}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'node'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'scripts/commit-message-gate.mjs') {
  const gate = args[0];
  ${record}
  require('node:fs').readFileSync(0);
} else {
  const result = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o755 },
  );

  const push = (
    extraEnv: Record<string, string> = {},
    refs: string[] = ['feat'],
  ) => {
    writeFileSync(report, '');
    const env: NodeJS.ProcessEnv = {
      ...(withoutFreshnessEnv(
        sanitizedGitEnvironment(process.env),
      ) as NodeJS.ProcessEnv),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STATION_HEAVY_CHECK_SLOT_DIR: join(root, 'heavy-check-slots'),
      ...extraEnv,
    };
    for (const key of [
      'CI',
      'GITHUB_ACTIONS',
      'GITHUB_EVENT_NAME',
      'STATION_HEAVY_CHECK_SLOT_HELD',
    ])
      delete env[key];
    for (const key of Object.keys(env))
      if (key.startsWith('GIT_')) delete env[key];
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_CONFIG_NOSYSTEM = '1';
    const result = spawnSync(
      'git',
      [
        '-c',
        'core.hooksPath=.githooks',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'push',
        '-q',
        'origin',
        ...refs,
      ],
      {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 90_000,
      },
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      gates: readFileSync(report, 'utf8').trim().split('\n').filter(Boolean),
    };
  };
  const remoteHas = (branch: string) =>
    spawnSync(
      'git',
      ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`],
      { encoding: 'utf8', windowsHide: true },
    ).stdout.trim();
  const brokenCheck = () =>
    writeFileSync(
      join(repo, 'scripts/check-documentation-freshness.mjs'),
      "console.error('TypeError: simulated crash');\nprocess.exit(1);\n",
    );
  const writeCheck = (source: string) =>
    writeFileSync(
      join(repo, 'scripts/check-documentation-freshness.mjs'),
      source,
    );
  return {
    ...f,
    repo,
    push,
    remoteHas,
    brokenCheck,
    installRealCheck,
    writeCheck,
  };
}

const TIMEOUT = 120_000;
const changeSource = (f: ReturnType<typeof hookFixture>, text: string) => {
  f.write('src/a.ts', text);
  return commit(f.repo, 'change a cited source');
};
const recordNote = (f: ReturnType<typeof hookFixture>) => {
  expect(
    record_(f.repo, ['docs/a.md', '--note', 'Reviewed the changed source.'])
      .status,
  ).toBe(0);
  return commit(f.repo, 'docs(ledger): review docs/a.md');
};

const ACCEPTED_ONLY_WARNS =
  "The push continues; CI's docs:truth:gate will judge it.";

describe.skipIf(process.platform === 'win32')(
  'pre-push documentation freshness: refuse only on a verdict about the pushed commit',
  () => {
    it(
      'warns and accepts a push whose cited source changed when the branch has recorded no review',
      () => {
        const f = hookFixture();
        const head = changeSource(f, 'export const a = 2;\n');
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          "WARNING: documentation freshness: only a warning because this branch has not recorded any review yet; CI's statics job will fail on these until they are reviewed.",
        );
        expect(result.output).toContain('review docs/a.md; changed: src/a.ts');
        expect(result.output).toMatch(
          /Scoped against origin\/main at [0-9a-f]{40}, committed \d{4}-/,
        );
        expect(result.gates).toContain(
          'scripts/check-prepush-orchestration-transfer.mjs',
        );
      },
      TIMEOUT,
    );

    it(
      'refuses a clean checkout of the pushed commit whose recorded note a later edit outdated',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        recordNote(f);
        changeSource(f, 'export const a = 3;\n');
        const result = f.push();
        expect(result.status).not.toBe(0);
        expect(f.remoteHas('feat')).toBe('');
        expect(result.output).toContain('Documentation review needs refresh');
        expect(result.output).toContain('review docs/a.md; changed: src/a.ts');
        expect(result.output).toContain(
          'npm run docs:review:record -- <path> --note',
        );
        expect(result.output).toMatch(
          /FAIL: this branch records documentation reviews \(\d+ ledger file\(s\) since its merge base\), and the pushed commit, checked out with no uncommitted or untracked ledger changes, leaves the reviews above stale\. CI's docs:truth:gate refuses the same commit\./,
        );
        expect(result.gates).not.toContain(
          'scripts/check-prepush-orchestration-transfer.mjs',
        );
      },
      TIMEOUT,
    );

    it(
      'passes silently when the branch has recorded notes and every review is current',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        const head = recordNote(f);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toMatch(
          /Documentation freshness: \d+ reviews and \d+ captures current\./,
        );
        expect(result.output).not.toContain('WARNING: documentation freshness');
      },
      TIMEOUT,
    );

    it(
      'only warns when an uncommitted edit makes a recorded review stale',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        const head = recordNote(f);
        f.write('src/a.ts', 'export const a = 9;\n');
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'WARNING: documentation freshness: only a warning because the check read a working tree with uncommitted changes, so this list may not describe the pushed commit.',
        );
        expect(result.output).not.toContain('refuses the same commit');
      },
      TIMEOUT,
    );

    it(
      'says it did not check, rather than reporting the checked-out commit, when another commit is pushed',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        const fresh = recordNote(f);
        git(f.repo, ['switch', '-qc', 'other']);
        changeSource(f, 'export const a = 3;\n');
        const result = f.push({}, ['feat']);
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(fresh);
        expect(result.output).toContain(
          'WARNING: documentation freshness: not checked: the commit being pushed is not the checked-out commit',
        );
        expect(result.output).not.toMatch(
          /Documentation freshness: \d+ reviews/,
        );
        expect(result.output).not.toContain('refuses the same commit');
      },
      TIMEOUT,
    );

    it(
      'warns and accepts, saying the check could not run, when the check crashes',
      () => {
        const f = hookFixture();
        const head = changeSource(f, 'export const a = 2;\n');
        f.brokenCheck();
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'WARNING: documentation freshness: not checked: the check could not run (exited 1 without a result: TypeError: simulated crash).',
        );
        expect(result.output).toContain(ACCEPTED_ONLY_WARNS);
        expect(result.output).not.toContain('needs refresh');
      },
      TIMEOUT,
    );

    it(
      'warns and accepts, naming the bound, when the check does not finish in time',
      () => {
        const f = hookFixture();
        const head = changeSource(f, 'export const a = 2;\n');
        f.writeCheck('setTimeout(() => {}, 30_000);\n');
        // The hook scales the bound by host pressure (at most 8x), so a
        // 1s base stays far below the stub's 30s.
        const result = f.push({
          STATION_PREPUSH_DOCS_FRESHNESS_TIMEOUT_MS: '1000',
        });
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toMatch(
          /WARNING: documentation freshness: not checked: the check could not run \(did not finish within [1-8]s\)/,
        );
      },
      TIMEOUT,
    );

    it(
      'warns and accepts when there is no origin/main to scope against',
      () => {
        const f = hookFixture();
        const head = changeSource(f, 'export const a = 2;\n');
        git(f.repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'WARNING: documentation freshness: not checked: there is no origin/main here to compare against',
        );
      },
      TIMEOUT,
    );

    it(
      'warns and accepts an orphan branch, which has no merge base',
      () => {
        const f = hookFixture();
        git(f.repo, ['switch', '-q', '--orphan', 'orphan']);
        git(f.repo, ['checkout', '-q', 'feat', '--', '.']);
        const head = commit(f.repo, 'chore: orphan root');
        const result = f.push({}, ['orphan']);
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('orphan')).toBe(head);
        expect(result.output).toContain(
          'not checked: the pushed commit shares no history with origin/main (an orphan branch?)',
        );
      },
      TIMEOUT,
    );

    it(
      "says so when the check's human report does not repeat its stale verdict",
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        // Stale in its JSON form, then clean when re-run for the report.
        f.writeCheck(
          `if (process.argv.includes('--json')) {\n  console.log(JSON.stringify({ mode: 'scoped', reason: 'fixture', base: 'origin/main', mergeBase: null, reviews: 1, captures: 0, blocking: [{ kind: 'review', path: 'docs/a.md', changed: ['src/a.ts'], rule: 'stale' }], advisory: [] }));\n  process.exit(1);\n}\nconsole.log('Documentation freshness (scoped): fine');\n`,
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          "(The check's human report did not repeat the stale verdict: exit 0. Run npm run docs:freshness:check.)",
        );
      },
      TIMEOUT,
    );

    it(
      'caps a long stale report at 30 entries and counts the rest',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        const entries = Array.from(
          { length: 45 },
          (_, i) => `  review docs/page-${i}.md; changed: src/a.ts`,
        ).join('\\n');
        f.writeCheck(
          `if (process.argv.includes('--json')) {\n  console.log(JSON.stringify({ mode: 'scoped', reason: 'fixture', base: 'origin/main', mergeBase: null, reviews: 45, captures: 0, blocking: [{ kind: 'review', path: 'docs/a.md', changed: ['src/a.ts'], rule: 'stale' }], advisory: [] }));\n  process.exit(1);\n}\nconsole.error('Documentation review needs refresh (scoped: fixture):\\n${entries}\\nReview the changed claims.');\nprocess.exit(1);\n`,
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('  review docs/page-29.md;');
        expect(result.output).not.toContain('  review docs/page-30.md;');
        expect(result.output).toContain(
          '  … and 15 more; run npm run docs:freshness:check for the full list',
        );
      },
      TIMEOUT,
    );

    it(
      'names a stale local origin/main first and judges nothing when the branch merged a newer main',
      () => {
        const f = hookFixture();
        const knownMain = git(f.repo, ['rev-parse', 'origin/main']);
        // A commit of the branch's own, so the merge below is a real merge.
        f.write('notes.txt', 'branch work\n');
        commit(f.repo, 'chore: branch work');
        // Main moves on, changing a cited source without a note.
        git(f.repo, ['switch', '-q', 'main']);
        f.write('src/b.ts', 'export const b = 2;\n');
        commit(f.repo, 'change b on main');
        git(f.repo, [
          '-c',
          'core.hooksPath=/dev/null',
          'push',
          '-q',
          'origin',
          'main',
        ]);
        git(f.repo, ['switch', '-q', 'feat']);
        git(f.repo, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'merge',
          '-q',
          '--no-edit',
          'main',
        ]);
        // Record a note too, so a judged verdict would have refused.
        changeSource(f, 'export const a = 2;\n');
        recordNote(f);
        changeSource(f, 'export const a = 3;\n');
        // The local origin/main never learned of main's new commit.
        git(f.repo, ['update-ref', 'refs/remotes/origin/main', knownMain]);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toMatch(
          /WARNING: documentation freshness: not checked: the pushed range merges 1 commit\(s\) the local origin\/main does not contain \([0-9a-f]{12}\): either the local origin\/main is behind \(`git fetch origin main` fixes that\) or a branch not yet on main was merged \(fetching will not help\)/,
        );
        expect(result.output).not.toContain(
          'Documentation review needs refresh',
        );
      },
      TIMEOUT,
    );
    it(
      'says it did not check a fresh pushed commit that is not checked out',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        const fresh = recordNote(f);
        git(f.repo, ['switch', '-qc', 'elsewhere']);
        f.write('notes.txt', 'elsewhere\n');
        commit(f.repo, 'chore: elsewhere moves on');
        const result = f.push({}, ['feat']);
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(fresh);
        expect(result.output).toContain(
          'not checked: the commit being pushed is not the checked-out commit',
        );
        expect(result.output).not.toMatch(
          /Documentation freshness: \d+ reviews/,
        );
      },
      TIMEOUT,
    );

    it(
      'only warns when an untracked file under the review ledger is present',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        recordNote(f);
        // A fresh, correct commit on a branch that records reviews, plus an
        // untracked record (as the verifier did): a copy of docs/a.md's
        // record retargeted at a page that does not exist.
        const record = 'docs/learn/review-ledger/records/docs/a.md.json';
        f.write(
          'docs/learn/review-ledger/records/docs/a-copy.md.json',
          f
            .read(record)
            .replace('"path": "docs/a.md"', '"path": "docs/a-copy.md"'),
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          'untracked files under the review ledger',
        );
        expect(result.output).not.toContain('refuses the same commit');
      },
      TIMEOUT,
    );

    it(
      'reports a check killed by a signal as killed, not as a timeout',
      () => {
        const f = hookFixture();
        const head = changeSource(f, 'export const a = 2;\n');
        f.writeCheck("process.kill(process.pid, 'SIGKILL');\n");
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'not checked: the check could not run (was terminated by SIGKILL)',
        );
        expect(result.output).not.toContain('did not finish within');
      },
      TIMEOUT,
    );

    it(
      'lets a branch that records reviews push work in progress with STATION_DOCS_FRESHNESS=advisory',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        recordNote(f);
        const head = changeSource(f, 'export const a = 3;\n');
        const result = f.push({ STATION_DOCS_FRESHNESS: 'advisory' });
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toMatch(
          /WARNING: documentation freshness: ran in advisory mode \(.*\), so \d+ stale entr\(ies\) were reported as advisory and nothing was judged\./,
        );
      },
      TIMEOUT,
    );
  },
);
