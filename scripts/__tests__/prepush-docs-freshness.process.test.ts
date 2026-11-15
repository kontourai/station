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
  'scripts/check-prepush-code-health.mjs',
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

  const push = () => {
    writeFileSync(report, '');
    const env: NodeJS.ProcessEnv = {
      ...(withoutFreshnessEnv(
        sanitizedGitEnvironment(process.env),
      ) as NodeJS.ProcessEnv),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STATION_HEAVY_CHECK_SLOT_DIR: join(root, 'heavy-check-slots'),
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
        'feat',
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
  return { ...f, repo, push, remoteHas, brokenCheck, installRealCheck };
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

describe.skipIf(process.platform === 'win32')(
  'pre-push documentation freshness: warn until the branch records reviews',
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
          "WARNING: CI's statics job will fail on these until they are reviewed. The push is allowed because this branch has not recorded any review yet.",
        );
        expect(result.output).toContain('review docs/a.md; changed: src/a.ts');
        expect(result.output).toMatch(
          /Scoped against origin\/main at [0-9a-f]{40}, committed \d{4}-/,
        );
        expect(result.output).toContain(
          'If the list names files this branch did not change, run `git fetch origin main` and push again.',
        );
        // The later gates still ran.
        expect(result.gates).toContain(
          'scripts/check-prepush-orchestration-transfer.mjs',
        );
      },
      TIMEOUT,
    );

    it(
      'refuses a push whose recorded note a later edit of the cited source outdated',
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
          /FAIL: this branch records documentation reviews \(\d+ ledger file\(s\) since its merge base\)/,
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
        expect(result.output).not.toContain("WARNING: CI's statics job");
        expect(result.output).not.toContain('needs refresh');
      },
      TIMEOUT,
    );

    it(
      'refuses, saying the check could not run, when the check crashes',
      () => {
        const f = hookFixture();
        changeSource(f, 'export const a = 2;\n');
        f.brokenCheck();
        const result = f.push();
        expect(result.status).not.toBe(0);
        expect(f.remoteHas('feat')).toBe('');
        expect(result.output).toContain(
          'FAIL: the documentation freshness check could not run (exited 1 without a result: TypeError: simulated crash)',
        );
        expect(result.output).not.toContain('needs refresh');
        expect(result.output).not.toContain("WARNING: CI's statics job");
      },
      TIMEOUT,
    );

    it(
      'names a stale local origin/main when the branch merged a newer main',
      () => {
        const f = hookFixture();
        const knownMain = git(f.repo, ['rev-parse', 'origin/main']);
        // A commit of the branch's own, so the merge below is a real merge.
        f.write('notes.txt', 'branch work\n');
        commit(f.repo, 'chore: branch work');
        // Main moves on, changing a cited source without a note (main's
        // merge queue runs freshness as advisory, so this can land).
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
        // The local origin/main never learned of it.
        git(f.repo, ['update-ref', 'refs/remotes/origin/main', knownMain]);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain('review docs/b.md; changed: src/b.ts');
        expect(result.output).toMatch(
          /This branch merges 1 commit\(s\) origin\/main here does not contain \([0-9a-f]{12}\)\. If that was main, the local origin\/main is stale/,
        );
      },
      TIMEOUT,
    );
  },
);
