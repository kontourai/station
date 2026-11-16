import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import { SCOPE_SENTINELS } from '../test-temp-dir-ratchet.mjs';

/**
 * The real pre-push hook, run by a real `git push` to a local bare remote.
 * The push-range checks (whitespace, test temp dirs, new unnamed exports)
 * and the main-conflict warning are the real scripts. Only the unrelated gates (lint, governance proof,
 * docs freshness, transfer, static gates, SDK barrel, commit subjects) are
 * recorders. Each
 * refusal is asserted on the push's exit status AND on the remote ref never
 * moving.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

// Assembled so this file does not itself contain the call the ratchet counts.
const MK = 'mkdtemp';
const RAW = `const d = ${MK}Sync(join(tmpdir(), 'x-'));\n`;

const HARNESS_SCRIPTS = [
  'prepush-pure-merge.mjs',
  'prepush-main-conflict.mjs',
  'check-prepush-push-range.mjs',
  'diff-whitespace-gate.mjs',
  'test-temp-dir-ratchet.mjs',
  'heavy-check-slot.mjs',
];
const RECORDED_GATES = [
  'scripts/check-prepush-docs-freshness.mjs',
  'scripts/check-prepush-orchestration-transfer.mjs',
  'scripts/check-prepush-static-gates.mjs',
  'scripts/check-prepush-sdk-barrel.mjs',
];

function fixture() {
  const root = realpathSync(makeTempDir('station-prepush-range-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const report = join(root, 'gates.log');
  const env = {
    ...sanitizedGitEnvironment(process.env),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };

  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', remote], {
    env,
    windowsHide: true,
  });
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', remote]);

  // The hook and the scripts it runs, untracked so they are never part of a
  // pushed range.
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
  for (const gate of RECORDED_GATES)
    writeFileSync(
      join(repo, gate),
      `import { appendFileSync, readFileSync } from 'node:fs';\n${gate.includes('docs-freshness') ? 'readFileSync(0);\n' : ''}appendFileSync(${JSON.stringify(report)}, ${JSON.stringify(`${gate}\n`)});\n`,
    );
  writeFileSync(
    join(repo, '.git', 'info', 'exclude'),
    ['.githooks/', '/scripts/*.mjs', '/scripts/lib/', '/packages/shared/'].join(
      '\n',
    ),
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
  // Pass a signal death on as one, the way the hook would see real node die.
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o755 },
  );

  // A small analyzable project: one entry, two modules, one test, and the
  // ratchet's scope sentinels at their baseline.
  commit(
    {
      'package.json': `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'src/index.ts' })}\n`,
      '.fallowrc.json': `${JSON.stringify({
        rules: { 'unused-exports': 'warn', 'unused-types': 'warn' },
        overrides: [
          {
            files: ['**/*.test.ts', 'packages/sdk/src/**'],
            rules: { 'unused-exports': 'off', 'unused-types': 'off' },
          },
        ],
      })}\n`,
      'src/index.ts':
        "import { used } from './a';\nimport { helper } from './b';\nconsole.log(used(), helper());\n",
      'src/a.ts':
        'export function used() {\n  return 1;\n}\nexport function alsoUsed() {\n  return 2;\n}\n',
      'src/b.ts':
        "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\n",
      'src/a.test.ts': "import { used } from './a';\nused();\n",
      'docs/notes.md': 'notes\n',
      ...Object.fromEntries(SCOPE_SENTINELS.map((path) => [path, RAW])),
      'scripts/test-temp-dir-baseline.json': `${JSON.stringify({
        files: Object.fromEntries(SCOPE_SENTINELS.map((path) => [path, 1])),
      })}\n`,
    },
    'chore: root',
  );
  git(['push', '-q', 'origin', 'main']);
  git(['checkout', '-q', '-b', 'feat']);
  git(['fetch', '-q', 'origin']);

  const slotDir = join(root, 'heavy-check-slots');
  const push = (refs = ['feat'], extraEnv: Record<string, string> = {}) => {
    writeFileSync(report, '');
    const pushEnv: NodeJS.ProcessEnv = {
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STATION_HEAVY_CHECK_SLOT_DIR: slotDir,
      ...extraEnv,
    };
    delete pushEnv.CI;
    delete pushEnv.GITHUB_ACTIONS;
    delete pushEnv.STATION_HEAVY_CHECK_SLOT_HELD;
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=.githooks', 'push', '-q', 'origin', ...refs],
      {
        cwd: repo,
        env: pushEnv,
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
      { env, encoding: 'utf8', windowsHide: true },
    ).stdout.trim();
  return { repo, git, write, commit, push, remoteHas };
}

const TIMEOUT = 120_000;

describe.skipIf(process.platform === 'win32')(
  'pre-push push-range checks on the commit being pushed',
  () => {
    it(
      'accepts a clean source push after running every new step against it',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed() + 1;\n}\n",
          },
          'fix: adjust helper',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain('[diff-whitespace] OK');
        expect(result.output).toContain('OK: 3 raw mkdtemp calls');
        expect(result.output).toContain(
          'New exports: 0 new export name(s), each named in another module.',
        );
        expect(result.output).not.toContain('WARNING');
        // The other gates still ran, after the new cheap step.
        expect(result.gates).toEqual([
          'lint:check',
          'proof:repo-governance',
          ...RECORDED_GATES,
          'scripts/commit-message-gate.mjs',
        ]);
      },
      TIMEOUT,
    );

    it(
      'refuses a pushed commit that adds trailing whitespace',
      () => {
        const f = fixture();
        f.commit({ 'docs/notes.md': 'notes\ntrailing space \n' }, 'docs: x');
        const result = f.push();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          'docs/notes.md:2: trailing whitespace.',
        );
        expect(result.output).toContain('[diff-whitespace] FAIL');
        expect(result.output).toContain(
          'FAIL: 1 push-range check(s) found a problem in the pushed commit',
        );
        expect(f.remoteHas('feat')).toBe('');
        // Refused before the heavier lanes started.
        expect(result.gates).not.toContain(RECORDED_GATES[0]);
      },
      TIMEOUT,
    );

    it(
      'refuses a pushed commit that adds a raw mkdtemp to a test file',
      () => {
        const f = fixture();
        f.commit(
          { 'src-server/feature/__tests__/leaky.test.ts': RAW },
          'test: leaky',
        );
        const result = f.push();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          'src-server/feature/__tests__/leaky.test.ts: 1 (baseline 0)',
        );
        expect(result.output).toContain('trackTempDirs()');
        expect(result.output).toMatch(
          /node scripts\/test-temp-dir-ratchet\.mjs --rev=[0-9a-f]{40}/,
        );
        expect(f.remoteHas('feat')).toBe('');
      },
      TIMEOUT,
    );

    it(
      'warns, and still lets the push through, when a pushed commit adds an export no other file names',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function newlyUnused() {\n  return 4;\n}\nconst local = 1;\nexport { local as renamedLocal };\n",
          },
          'feat: add exports nothing names',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          "WARNING: 2 new export(s) that no other module seems to name. This is a heuristic, not CI's code-health gate, which is the judge; the push continues:",
        );
        expect(result.output).toContain(
          '  src/b.ts: export newlyUnused is not named in any other file',
        );
        expect(result.output).toContain(
          '  src/b.ts: export renamedLocal is not named in any other file',
        );
        expect(result.output).toMatch(
          /node scripts\/code-health-gate\.mjs --base=[0-9a-f]{40}/,
        );
        expect(result.output).not.toContain(
          'push-range check(s) found a problem',
        );
        expect(result.gates).toContain(RECORDED_GATES[0]);
      },
      TIMEOUT,
    );

    it(
      'passes a new export that another file names',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function nowUsed() {\n  return 4;\n}\n",
            'src/index.ts':
              "import { used } from './a';\nimport { helper, nowUsed } from './b';\nconsole.log(used(), helper(), nowUsed());\n",
          },
          'feat: add a used export',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'New exports: 1 new export name(s), each named in another module.',
        );
      },
      TIMEOUT,
    );

    it(
      'passes new exports in locations the code-health gate exempts',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/c.test.ts':
              "import { used } from './a';\nexport const testOnly = used();\n",
            'packages/sdk/src/api.ts': 'export const publicApi = 1;\n',
            'src/__tests__/helper.ts': 'export const helperOnly = 1;\n',
          },
          'test: exempt exports',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).not.toContain('is not named in any other file');
      },
      TIMEOUT,
    );

    it(
      'passes an export in a file an entry-point source names',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'tools/tool.mjs': 'export const toolOption = 1;\n',
            'package.json': `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'src/index.ts', scripts: { tool: 'node tools/tool.mjs' } })}\n`,
          },
          'feat: an entry script',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
      },
      TIMEOUT,
    );

    it(
      'passes exports of a module another file imports whole',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/whole.ts': 'export const wholeOne = 1;\n',
            'src/globbed.ts': 'export const globbedOne = 1;\n',
            'src/index.ts':
              "import * as whole from './whole';\nimport { used } from './a';\nimport { helper } from './b';\nconst all = import.meta.glob('./glob*.ts');\nconsole.log(whole, all, used(), helper());\n",
          },
          'feat: namespace and glob imports',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
      },
      TIMEOUT,
    );

    it(
      'is quiet about a type-only export used in its own file, and warns about a value used only there',
      () => {
        const f = fixture();
        f.commit(
          {
            'src/shapes.ts':
              'export type Shape = { side: number };\nexport function area(shape: Shape) {\n  return shape.side ** 2;\n}\nexport const unit = area({ side: 1 });\n',
            'src/index.ts':
              "import { used } from './a';\nimport { helper } from './b';\nimport { unit } from './shapes';\nconsole.log(used(), helper(), unit);\n",
          },
          'feat: a type used in its own file',
        );
        const result = f.push();
        // `area` is used only inside shapes.ts; the analyzer still reports a
        // value export used only in its own file, so it is the one warning.
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          '  src/shapes.ts: export area is not named in any other file',
        );
        expect(result.output).not.toContain('export Shape is not named');
        expect(result.output).not.toContain('export unit is not named');
      },
      TIMEOUT,
    );

    it(
      'warns about an export that another file mentions only in a comment, a type-position import or a destructured dynamic import',
      () => {
        const f = fixture();
        f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function onlyInComments() {\n  return 4;\n}\n",
            'src/index.ts':
              "import { used } from './a';\nimport { helper } from './b';\n// onlyInComments is described here but never called.\n/* nor here: onlyInComments */\ntype B = typeof import('./b');\nconst { helper: again } = await import(\n  './b'\n);\nconsole.log(used(), helper(), again);\n",
          },
          'feat: an export only comments mention',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          '  src/b.ts: export onlyInComments is not named in any other file',
        );
      },
      TIMEOUT,
    );

    it(
      'passes re-exports and default exports',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/barrel.ts':
              "export { used } from './a';\nexport * from './b';\nexport { alsoUsed as renamedAgain } from './a';\n",
            'src/defaulted.ts':
              'export default function () {\n  return 7;\n}\n',
          },
          'feat: re-export and default',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).not.toContain('is not named in any other file');
      },
      TIMEOUT,
    );

    it(
      'passes a new export that a later commit in the same push uses',
      () => {
        const f = fixture();
        f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function usedLater() {\n  return 4;\n}\n",
          },
          'feat: add the export first',
        );
        const head = f.commit(
          {
            'src/index.ts':
              "import { used } from './a';\nimport { helper, usedLater } from './b';\nconsole.log(used(), helper(), usedLater());\n",
          },
          'feat: then use it',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
      },
      TIMEOUT,
    );

    it(
      'judges the pushed commit, not uncommitted or untracked edits',
      () => {
        const f = fixture();
        const head = f.commit(
          { 'docs/notes.md': 'notes, edited\n' },
          'docs: y',
        );
        // Neither of these is part of the push, so neither may refuse it.
        f.write('src-server/feature/__tests__/leaky.test.ts', RAW);
        f.write('docs/notes.md', 'notes, edited \n');
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain('OK: 3 raw mkdtemp calls');
      },
      TIMEOUT,
    );

    it(
      'warns, without refusing, when the pushed commit conflicts with origin/main',
      () => {
        const f = fixture();
        f.git(['checkout', '-q', 'main']);
        f.commit({ 'docs/notes.md': 'main wrote this\n' }, 'docs: main');
        f.git(['push', '-q', 'origin', 'main']);
        f.git(['checkout', '-q', 'feat']);
        const head = f.commit(
          { 'docs/notes.md': 'feat wrote this\n' },
          'docs: feat',
        );
        f.git(['fetch', '-q', 'origin']);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          'WARNING: refs/heads/feat (' +
            head.slice(0, 12) +
            ') does not merge cleanly into origin/main',
        );
        expect(result.output).toContain('  docs/notes.md');
        expect(result.output).toContain(
          'CI will refuse to run source checks on a pull request that conflicts with',
        );
      },
      TIMEOUT,
    );

    it(
      'is silent about main when origin/main is unknown',
      () => {
        const f = fixture();
        f.commit(
          {
            'src/a.ts':
              'export function used() {\n  return 9;\n}\nexport function alsoUsed() {\n  return 2;\n}\n',
          },
          'fix: z',
        );
        f.git(['update-ref', '-d', 'refs/remotes/origin/main']);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).not.toContain('merge cleanly');
        expect(result.output).not.toContain('could not check');
        expect(result.output).toContain(
          'New exports: not checked for refs/heads/feat: there is no origin/main here to compare against',
        );
      },
      TIMEOUT,
    );

    it(
      'passes an export used after a string containing /* (the verifier probe)',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/probe.ts':
              'export function verifyProbeQuiesce() {\n  return 1;\n}\n',
            'src/routes.ts':
              "const shares = '/api/shares/*';\nexport async function route() {\n  const { verifyProbeQuiesce } = await import('./probe.js');\n  return [shares, verifyProbeQuiesce()];\n}\n/* a later block comment */\n",
            'src/index.ts':
              "import { used } from './a';\nimport { helper } from './b';\nimport { route } from './routes';\nconsole.log(used(), helper(), route);\n",
          },
          'feat: a use after a string with a comment opener',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).not.toContain('is not named in any other file');
      },
      TIMEOUT,
    );

    it(
      "passes an export read as P.Name after 'image/*' through a package namespace import",
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'packages/kit/package.json': `${JSON.stringify({ name: '@fixture/kit', exports: { '.': './src/index.ts' } })}\n`,
            'packages/kit/src/index.ts': "export * from './image';\n",
            'packages/kit/src/image.ts': 'export const imageExport = 1;\n',
            'src/index.ts':
              "import { used } from './a';\nimport { helper } from './b';\nconst accept = 'image/*';\nimport * as P from '@fixture/kit';\nconsole.log(used(), helper(), accept, P.imageExport);\n/* trailing */\n",
          },
          'feat: a namespace read after a string with a comment opener',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).not.toContain('is not named in any other file');
      },
      TIMEOUT,
    );

    it(
      "passes a new export in a file its workspace package's package.json names as an entry",
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'packages/toolkit/package.json': `${JSON.stringify({ name: '@fixture/toolkit', exports: { '.': './src/index.ts', './extra': './src/extra.ts' }, bin: { tk: './bin/tk.mjs' } })}\n`,
            'packages/toolkit/src/index.ts': 'export const toolkitEntry = 1;\n',
            'packages/toolkit/src/extra.ts': 'export const toolkitExtra = 1;\n',
            'packages/toolkit/bin/tk.mjs': 'export const toolkitBin = 1;\n',
          },
          'feat: a workspace package',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).not.toContain('is not named in any other file');
      },
      TIMEOUT,
    );

    it(
      'warns and accepts when the export diff is past its capture bound, and still refuses whitespace in the same step',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function unnamedButUnchecked() {\n  return 4;\n}\n",
          },
          'feat: an export behind an oversize diff',
        );
        const bound = { STATION_PREPUSH_EXPORT_DIFF_MAX_BYTES: '64' };
        const accepted = f.push(['feat'], bound);
        expect(accepted.status, accepted.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(accepted.output).toContain(
          'New exports: not checked for refs/heads/feat: git diff',
        );
        expect(accepted.output).toContain(
          "its output passed the capture bound; the range is very large). CI's code-health gate will judge them.",
        );
        f.commit({ 'docs/notes.md': 'notes\ntrailing space \n' }, 'docs: x');
        const refused = f.push(['feat'], bound);
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain('[diff-whitespace] FAIL');
        expect(f.remoteHas('feat')).toBe(head);
      },
      TIMEOUT,
    );

    it(
      'warns and accepts an orphan branch, naming what each check could not do',
      () => {
        const f = fixture();
        f.git(['checkout', '-q', '--orphan', 'orphan']);
        const head = f.commit(
          { 'docs/orphan.md': 'orphan\n' },
          'chore: orphan root',
        );
        const result = f.push(['orphan']);
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('orphan')).toBe(head);
        expect(result.output).toContain(
          'WARNING: whitespace not checked for refs/heads/orphan: the pushed commit shares no history with origin/main (an orphan branch?)',
        );
        expect(result.output).toContain(
          'New exports: not checked for refs/heads/orphan: the pushed commit shares no history with origin/main',
        );
        expect(result.output).not.toContain('no origin/main here');
      },
      TIMEOUT,
    );

    it(
      'names a merged commit origin/main lacks first, still judges whitespace and the ratchet, and checks no exports',
      () => {
        const f = fixture();
        const knownMain = f.git(['rev-parse', 'origin/main']);
        f.commit({ 'docs/branch.md': 'branch work\n' }, 'docs: branch work');
        f.git(['checkout', '-q', 'main']);
        f.commit({ 'docs/main.md': 'main moved\n' }, 'docs: main moved');
        f.git(['push', '-q', 'origin', 'main']);
        f.git(['checkout', '-q', 'feat']);
        f.git(['merge', '-q', '--no-edit', 'main']);
        f.commit(
          {
            'src/b.ts':
              "import { alsoUsed } from './a';\nexport function helper() {\n  return alsoUsed();\n}\nexport function newlyUnused() {\n  return 4;\n}\n",
          },
          'feat: an export a stale base cannot judge',
        );
        f.git(['update-ref', 'refs/remotes/origin/main', knownMain]);
        const accepted = f.push();
        expect(accepted.status, accepted.output).toBe(0);
        const lines = accepted.output.split('\n');
        const hint = lines.findIndex((line) =>
          line.includes('either the local origin/main is behind'),
        );
        const firstCheck = lines.findIndex(
          (line) =>
            line.startsWith('Whitespace:') ||
            line.includes('whitespace not checked'),
        );
        expect(hint).toBeGreaterThanOrEqual(0);
        expect(hint).toBeLessThan(firstCheck);
        expect(accepted.output).toContain(
          'or a branch not yet on main was merged (fetching will not help)',
        );
        expect(accepted.output).toContain(
          'Whitespace: checking refs/heads/feat',
        );
        expect(accepted.output).toContain(
          'New exports: not checked for refs/heads/feat: the pushed range merges 1 commit(s)',
        );
        f.commit(
          { 'src-server/feature/__tests__/leaky.test.ts': RAW },
          'test: leaky',
        );
        const refused = f.push();
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain(
          'src-server/feature/__tests__/leaky.test.ts: 1 (baseline 0)',
        );
      },
      TIMEOUT,
    );

    it(
      "judges whitespace with the pushed commit's attributes, not an uncommitted .gitattributes",
      () => {
        const f = fixture();
        f.commit({ 'docs/notes.md': 'notes\ntrailing space \n' }, 'docs: x');
        f.write('.gitattributes', '* -whitespace\n');
        const result = f.push();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          'docs/notes.md:2: trailing whitespace.',
        );
      },
      TIMEOUT,
    );

    it(
      'warns and accepts when the ratchet cannot run, and still refuses a real finding',
      () => {
        const f = fixture();
        const head = f.commit(
          { 'scripts/test-temp-dir-baseline.json': '{ not json\n' },
          'chore: break the baseline',
        );
        const accepted = f.push();
        expect(accepted.status, accepted.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(accepted.output).toContain(
          'WARNING: test temp dirs not checked for refs/heads/feat: the ratchet did not run (exit 2).',
        );
        f.commit({ 'docs/notes.md': 'notes\ntrailing space \n' }, 'docs: x');
        const refused = f.push();
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain('[diff-whitespace] FAIL');
      },
      TIMEOUT,
    );
    it(
      'is quiet about a renamed file whose exports were already there',
      () => {
        const f = fixture();
        f.commit(
          {
            'src/moved.ts':
              'export const keptA = 1;\nexport const keptB = 2;\n',
          },
          'feat: a module (inherited at the base after the next push)',
        );
        f.git(['push', '-q', 'origin', 'feat:main']);
        f.git(['fetch', '-q', 'origin']);
        f.git(['mv', 'src/moved.ts', 'src/moved-again.ts']);
        f.git(['commit', '-qm', 'chore: rename']);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).not.toContain('keptA');
        expect(result.output).toContain('New exports: 0 new export name(s)');
      },
      TIMEOUT,
    );

    it(
      'collects exports in a path with a space and a non-ASCII name',
      () => {
        const f = fixture();
        f.commit(
          { 'src/odd dir/é.ts': 'export const oddUnused = 1;\n' },
          'feat: an odd path',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          '  src/odd dir/é.ts: export oddUnused is not named in any other file',
        );
      },
      TIMEOUT,
    );

    it(
      'warns, never refuses, about an export const line inside a template literal',
      () => {
        const f = fixture();
        const head = f.commit(
          {
            'src/gen.ts':
              'export function render() {\n  return `\nexport const GENERATED_ONLY = 1;\n`;\n}\n',
            'src/index.ts':
              "import { used } from './a';\nimport { helper } from './b';\nimport { render } from './gen';\nconsole.log(used(), helper(), render());\n",
          },
          'feat: a generator',
        );
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain('export GENERATED_ONLY is not named');
      },
      TIMEOUT,
    );

    it.each([
      ['throws while loading', "throw new Error('load failure');\n", 'exit 1'],
      [
        'is killed by a signal',
        "process.kill(process.pid, 'SIGKILL');\n",
        'exit 137',
      ],
    ])(
      'warns and lets the push through when the push-range step %s',
      (_label, source, status) => {
        const f = fixture();
        const head = f.commit(
          { 'docs/notes.md': 'notes, edited\n' },
          'docs: y',
        );
        f.write('scripts/check-prepush-push-range.mjs', source);
        const result = f.push();
        expect(result.status, result.output).toBe(0);
        expect(f.remoteHas('feat')).toBe(head);
        expect(result.output).toContain(
          `[station pre-push] WARNING: push range did not reach a verdict (${status}); that is not a finding in the pushed commit, so the push continues and CI will judge it.`,
        );
      },
      TIMEOUT,
    );
  },
);
