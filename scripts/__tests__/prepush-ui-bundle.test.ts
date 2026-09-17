import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUILD_FAILURE_NOTE,
  changedPathsSince,
  decideBundleScope,
  describeMatches,
  isUiBuildInput,
  PREPUSH_BUILD_DIR,
  UI_BUILD_INPUT_PREFIXES,
  uiBuildInputs,
} from '../check-prepush-ui-bundle.mjs';

describe('UI build input detection', () => {
  it('recognizes every source root the Vite build reads', () => {
    // These are exactly the roots vite.config.ts resolves: `root: ./src-ui`,
    // the `@shared` alias, and the three workspace packages aliased to source.
    for (const path of [
      'src-ui/src/App.tsx',
      'src-ui/index.html',
      'src-shared/types.ts',
      'packages/sdk/src/index.ts',
      'packages/connect/src/core/healthProbe.ts',
      'packages/contracts/src/provider.ts',
    ]) {
      expect(isUiBuildInput(path), path).toBe(true);
    }
  });

  it('recognizes the manifests, because a dependency bump moves the bundle', () => {
    // The failure this gate exists for has arrived this way: no source file
    // changed, the entry chunk grew anyway, and nobody owned the bytes.
    for (const path of [
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/dependency.patch',
    ])
      expect(isUiBuildInput(path)).toBe(true);
    expect(isUiBuildInput('package.json')).toBe(true);
    expect(isUiBuildInput('vite.config.ts')).toBe(true);
  });

  it('recognizes the ceiling itself, so a lowered ceiling is measured', () => {
    expect(isUiBuildInput('scripts/ui-bundle-budget.json')).toBe(true);
    expect(isUiBuildInput('scripts/ui-bundle-budget.mjs')).toBe(true);
  });

  it('leaves a server-only push alone', () => {
    for (const path of [
      'src-server/routes/operations/insights.ts',
      'src-desktop/src/main.rs',
      'docs/guides/testing.md',
      'scripts/run-ci-fast.mjs',
      'packages/cli/src/commands/lifecycle.ts',
      'tests/e2e/product.spec.ts',
    ]) {
      expect(isUiBuildInput(path), path).toBe(false);
    }
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    // Without the trailing slash on every prefix, each of these reads as a hit
    // and every push pays for a build it does not need.
    expect(isUiBuildInput('src-uix/thing.ts')).toBe(false);
    expect(isUiBuildInput('src-shared-fixtures/thing.ts')).toBe(false);
    expect(isUiBuildInput('packages/sdk/README.md')).toBe(false);
    expect(isUiBuildInput('packages/sdkx/src/index.ts')).toBe(false);
    expect(isUiBuildInput('packages/contracts/package.json')).toBe(false);
  });

  it('does not match a UI path that is merely a substring', () => {
    expect(isUiBuildInput('docs/src-ui/notes.md')).toBe(false);
    expect(isUiBuildInput('examples/plugin/package.json')).toBe(false);
  });

  it('normalizes Windows separators', () => {
    expect(isUiBuildInput('src-ui\\src\\App.tsx')).toBe(true);
  });

  it('ignores empty entries from a -z split', () => {
    expect(isUiBuildInput('')).toBe(false);
  });

  it('every declared prefix ends in a slash', () => {
    for (const prefix of UI_BUILD_INPUT_PREFIXES) {
      expect(prefix.endsWith('/'), prefix).toBe(true);
    }
  });

  it('filters a mixed change set down to the inputs', () => {
    expect(
      uiBuildInputs([
        'src-server/index.ts',
        'src-ui/src/App.tsx',
        'docs/README.md',
        'package-lock.json',
      ]),
    ).toEqual(['src-ui/src/App.tsx', 'package-lock.json']);
  });
});

describe('scope decision', () => {
  it('skips a push that changes nothing the UI build reads', () => {
    const decision = decideBundleScope({
      baseSha: 'abc',
      changedPaths: ['src-server/index.ts', 'docs/README.md'],
    });
    expect(decision.measure).toBe(false);
    expect(decision.reason).toContain('2 path(s)');
  });

  it('measures a push that touches one UI build input', () => {
    const decision = decideBundleScope({
      baseSha: 'abc',
      changedPaths: ['src-server/index.ts', 'src-ui/src/App.tsx'],
    });
    expect(decision.measure).toBe(true);
    expect(decision.matched).toEqual(['src-ui/src/App.tsx']);
    expect(decision.reason).toContain('src-ui/src/App.tsx');
  });

  it('measures when the scope cannot be computed at all', () => {
    // "I could not look" must not resolve to the same answer as "nothing
    // changed" — that permissive default is the one this repo names as a
    // smell, and here it would let an over-ceiling tree out unmeasured.
    const decision = decideBundleScope({ baseSha: null, changedPaths: [] });
    expect(decision.measure).toBe(true);
    expect(decision.reason).toContain('cannot be scoped');
  });

  it('skips an empty change set only when the base was resolvable', () => {
    expect(
      decideBundleScope({ baseSha: 'abc', changedPaths: [] }).measure,
    ).toBe(false);
  });

  it('names the matches without printing an unbounded list', () => {
    const many = [
      'src-ui/a.ts',
      'src-ui/b.ts',
      'src-ui/c.ts',
      'src-ui/d.ts',
      'src-ui/e.ts',
    ];
    expect(describeMatches(many)).toBe(
      'src-ui/a.ts, src-ui/b.ts, src-ui/c.ts, +2 more',
    );
    expect(describeMatches(['src-ui/a.ts'])).toBe('src-ui/a.ts');
  });
});

describe('branch-delta scoping', () => {
  it('asks git for the branch delta against the base, not the whole tree', () => {
    const calls: string[][] = [];
    const paths = changedPathsSince('origin/main', (args) => {
      calls.push(args);
      return 'src-ui/src/App.tsx\0src-server/index.ts\0';
    });
    expect(calls).toEqual([
      ['diff', '--name-only', '-z', 'origin/main...HEAD'],
    ]);
    expect(paths).toEqual(['src-ui/src/App.tsx', 'src-server/index.ts']);
  });

  it('drops the trailing empty field -z always produces', () => {
    expect(changedPathsSince('origin/main', () => 'a.ts\0')).toEqual(['a.ts']);
    expect(changedPathsSince('origin/main', () => '')).toEqual([]);
  });
});

describe('failure output', () => {
  it('points at the budget gate rather than restating its guidance', () => {
    expect(BUILD_FAILURE_NOTE).toContain('scripts/ui-bundle-budget.mjs');
    expect(BUILD_FAILURE_NOTE).toContain(
      `STATION_BUILD_UI_DIR=${PREPUSH_BUILD_DIR} npm run build:ui`,
    );
    // build:ui also fails for reasons that are not the ceiling; the note must
    // not assert a cause it does not know.
    expect(BUILD_FAILURE_NOTE).not.toMatch(
      /exceeds|de-hoist|raise the ceiling/,
    );
  });
});

/**
 * The pure functions above cannot see the part that actually refuses a push:
 * `main()` sets `process.exitCode` rather than calling `process.exit`, and
 * nothing else here proves that still leaves the process non-zero — the exact
 * uncovered-rejection-path shape scripts/__tests__/guardrail-known-bad-fixtures
 * exists for. So run the guardrail as a child process against a stub `npm`,
 * and assert on its real exit status in both directions.
 */
describe('exit status (executed, not inspected)', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function runWithStubbedBuild(buildExitCode: number) {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-bundle-'));
    roots.push(root);
    const argvLog = join(root, 'argv.txt');
    const stub = join(root, 'npm');
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit ${buildExitCode}\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/check-prepush-ui-bundle.mjs'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ''}`,
          // An unresolvable base is the "cannot scope this push" case, which
          // must reach the build rather than skip it.
          STATION_BASE_REF: 'refs/heads/station-prepush-no-such-ref',
        },
      },
    );
    return { result, argvLog };
  }

  it.skipIf(process.platform === 'win32')(
    'exits non-zero and prints the note when the build fails',
    () => {
      const { result, argvLog } = runWithStubbedBuild(1);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('UI bundle: measuring');
      expect(result.stderr).toContain(
        'FAIL: `npm run build:ui` did not pass, so this push is refused.',
      );
      // Delegated to the repo's own build command, not a second vite call.
      expect(readFileSync(argvLog, 'utf8').split('\n')).toContain('build:ui');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'exits zero when the same build passes',
    () => {
      // Binds the failure above to the build result rather than to the
      // harness: only the stub's exit code differs between these two cases.
      const { result } = runWithStubbedBuild(0);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('FAIL');
    },
  );
});

describe('repo hook wiring', () => {
  const hook = readFileSync('.githooks/pre-push', 'utf8');

  it('runs the cheap checks in the pre-push hook', () => {
    expect(hook).toContain('lint:check');
    expect(hook).toContain('check-prepush-ui-bundle.mjs');
  });

  it('leaves moving-main composition freshness to the required merge queue', () => {
    const commands = hook
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('git fetch');
    expect(commands).not.toContain('check-merge-base-fresh.mjs');
    expect(commands).not.toContain('STATION_ALLOW_STALE_BASE');
  });

  it('keeps the hook to seconds-scale checks', () => {
    // full:regression stays the sole completion receipt and ci:fast stays the
    // bounded feedback lane; a hook that runs either becomes a hook people
    // route around with --no-verify. Comments may name them; commands may not.
    const commands = hook
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toMatch(
      /full:regression|ci:fast|test:full|verify:static/,
    );
  });

  it('builds into a directory that is not the served build output', () => {
    expect(PREPUSH_BUILD_DIR).not.toBe('dist-ui');
    expect(readFileSync('.gitignore', 'utf8')).toContain('dist-ui-*/');
  });

  it('measures with the repo build command rather than a second one', () => {
    // If this gate ever grew its own vite invocation it would drift from the
    // command everyone else measures with, and the numbers would disagree.
    const source = readFileSync('scripts/check-prepush-ui-bundle.mjs', 'utf8');
    expect(source).toContain("'run', '--silent', 'build:ui'");
    expect(source).not.toContain('vite build');
  });
});
