import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decideTypecheckScope,
  isTypecheckInput,
  runTypecheckCommands,
  TYPECHECK_FAILURE_NOTE,
  TYPECHECK_INPUT_PREFIXES,
  TYPECHECK_PREPUSH_COMMANDS,
  typecheckInputs,
} from '../check-prepush-typecheck.mjs';
import { FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';

describe('typecheck input detection', () => {
  it('recognizes what a tsc project compiles', () => {
    for (const path of [
      'src-server/routes/agents/index.ts',
      'src-ui/src/components/Button.tsx',
      'packages/sdk/src/queries.ts',
      'scripts/__tests__/gate-for.test.ts',
      'tests/helpers/touch-target.ts',
      'src-shared/monitoring-keys.mts',
      'packages/contracts/src/legacy.cts',
      'src-server/types/ambient.d.ts',
    ]) {
      expect(isTypecheckInput(path), path).toBe(true);
    }
  });

  /**
   * A config, a manifest or a patch changes what the projects resolve without
   * touching a source file, and the aggregate's own catalog changes which
   * projects run at all.
   */
  it('recognizes configs, manifests, patches and the lane catalog', () => {
    for (const path of [
      'tsconfig.json',
      'tsconfig.scripts.json',
      'packages/sdk/tsconfig.tests.json',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches/vite@7.0.0.patch',
      'scripts/typecheck-aggregate.mjs',
      'scripts/lib/npm-lane-aggregate.mjs',
    ]) {
      expect(isTypecheckInput(path), path).toBe(true);
    }
  });

  /**
   * `tsconfig.scripts.json` sets `checkJs: false` and every project's
   * `include` lists only the four TypeScript extensions, so an ordinary `.mjs`
   * edit cannot produce a type error. The pair below is the discriminating
   * one: two files in the same directory, one an input because the aggregate
   * reads it as its catalog, the other not.
   */
  it('ignores paths no typecheck lane compiles', () => {
    for (const path of [
      'docs/guides/testing.md',
      '.github/workflows/ci.yml',
      'scripts/run-ci-fast.mjs',
      'src-ui/src/views/HomeView.css',
      'src-desktop/src/main.rs',
      'schemas/agent-plugins/1.0.0/plugin.schema.json',
    ]) {
      expect(isTypecheckInput(path), path).toBe(false);
    }
    expect(isTypecheckInput('scripts/typecheck-aggregate.mjs')).toBe(true);
  });

  it('does not match a sibling directory sharing a prefix', () => {
    expect(isTypecheckInput('patches-old/vite.patch')).toBe(false);
    for (const prefix of TYPECHECK_INPUT_PREFIXES) {
      expect(prefix.endsWith('/'), prefix).toBe(true);
    }
  });

  it('filters a mixed changed set down to the inputs', () => {
    expect(
      typecheckInputs([
        'docs/glossary.md',
        'src-server/routes/me/personal-layouts.ts',
        'scripts/check-prepush-typecheck.mjs',
        'tsconfig.tests.json',
      ]),
    ).toEqual([
      'src-server/routes/me/personal-layouts.ts',
      'tsconfig.tests.json',
    ]);
  });
});

describe('scope decision', () => {
  it('runs when the base cannot be resolved', () => {
    // "I could not look" must not resolve to the same answer as "nothing
    // changed" — that turns a broken assumption into a silent pass.
    const decision = decideTypecheckScope({ baseSha: '', changedPaths: [] });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('could not be resolved');
  });

  it('skips only when the scope was computed and held no input', () => {
    const decision = decideTypecheckScope({
      baseSha: 'abc1234',
      changedPaths: ['docs/guides/testing.md', '.github/workflows/ci.yml'],
    });
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('none of the 2 path(s)');
  });

  it('names the inputs it matched', () => {
    const decision = decideTypecheckScope({
      baseSha: 'abc1234',
      changedPaths: ['README.md', 'src-ui/src/App.tsx'],
    });
    expect(decision.run).toBe(true);
    expect(decision.matched).toEqual(['src-ui/src/App.tsx']);
    expect(decision.reason).toContain('src-ui/src/App.tsx');
  });
});

describe('command chain', () => {
  /**
   * `runTypecheckCommands` reads only `status` and `error` off a spawn result,
   * so a stand-in supplies those two and nothing else; the cast is what says
   * the rest of `SpawnSyncReturns` is deliberately absent.
   */
  const stubSpawn = (
    handler: (command: string) => { status?: number; error?: Error },
  ): typeof spawnSync => handler as unknown as typeof spawnSync;

  /**
   * The hook and `ci:fast` must measure with the same aggregate. If they ever
   * drifted, a push could pass here and fail the required lane on the same
   * tree for reasons that have nothing to do with the code.
   */
  it('runs the same aggregate command the ci:fast lane runs', () => {
    const aggregate = TYPECHECK_PREPUSH_COMMANDS.at(-1);
    expect(
      FAST_STATIC_COMMANDS.map((entry: readonly unknown[]) =>
        JSON.stringify(entry),
      ),
    ).toContain(JSON.stringify(aggregate));
  });

  it('stops at the first failing command', () => {
    const calls: string[] = [];
    const status = runTypecheckCommands(
      [
        ['first', ['a']],
        ['second', ['b']],
        ['third', ['c']],
      ],
      stubSpawn((command) => {
        calls.push(command);
        return { status: command === 'second' ? 2 : 0 };
      }),
    );
    // `third` never runs: a broken precondition must report as itself, not as
    // a dozen lanes of `Cannot find module`.
    expect(calls).toEqual(['first', 'second']);
    expect(status).toBe(2);
  });

  it('returns zero only when every command passed', () => {
    const calls: string[] = [];
    const status = runTypecheckCommands(
      [
        ['first', ['a']],
        ['second', ['b']],
      ],
      stubSpawn((command) => {
        calls.push(command);
        return { status: 0 };
      }),
    );
    expect(calls).toEqual(['first', 'second']);
    expect(status).toBe(0);
  });

  it('treats a command that could not start as a fault, not a pass', () => {
    expect(() =>
      runTypecheckCommands(
        [['missing', []]],
        stubSpawn(() => ({ error: new Error('ENOENT') })),
      ),
    ).toThrow('ENOENT');
  });

  it('does not claim a cause the aggregate has not reported', () => {
    expect(TYPECHECK_FAILURE_NOTE).toContain('this push is refused');
    expect(TYPECHECK_FAILURE_NOTE).not.toMatch(/you (added|introduced)/i);
  });
});

/**
 * The pure functions above cannot see the part that refuses a push: `main()`
 * sets `process.exitCode` rather than calling `process.exit`, and nothing else
 * proves that still leaves the process non-zero.
 *
 * Both directions are covered, but not by the same mechanism. The refusal runs
 * as a real child against a stub `npm`, so the exit status is the assertion.
 * The all-passing direction is covered by the skip case below plus
 * `runTypecheckCommands`'s own zero-status test, because the real chain is
 * ~91 seconds — that is the one seam a test here does not execute end to end.
 */
describe('exit status (executed, not inspected)', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'exits non-zero and prints the note when a command fails',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-prepush-typecheck-'));
      roots.push(root);
      const argvLog = join(root, 'argv.txt');
      writeFileSync(
        join(root, 'npm'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit 1\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/check-prepush-typecheck.mjs'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH ?? ''}`,
            // Unresolvable base: the "cannot scope this push" case, which must
            // reach the commands rather than skip them.
            STATION_BASE_REF: 'refs/heads/station-prepush-no-such-ref',
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Typecheck: checking');
      expect(result.stderr).toContain(
        'FAIL: at least one `typecheck:*` lane did not pass',
      );
      // Failed at the first command, so the 82-second aggregate never started.
      expect(readFileSync(argvLog, 'utf8').split('\n')).toContain(
        'build:connect',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'exits zero without running anything when nothing it reads changed',
    () => {
      const result = spawnSync(
        process.execPath,
        ['scripts/check-prepush-typecheck.mjs'],
        {
          encoding: 'utf8',
          // HEAD against HEAD: a computed scope with an empty changed set.
          env: { ...process.env, STATION_BASE_REF: 'HEAD' },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Typecheck: skipped');
      expect(result.stderr).not.toContain('FAIL');
    },
  );
});

describe('repo hook wiring', () => {
  const hook = readFileSync('.githooks/pre-push', 'utf8');
  const commands = hook
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('runs governance, readiness and the scoped typecheck at push time', () => {
    expect(commands).toContain('lint:check');
    expect(commands).toContain('proof:repo-governance');
    expect(commands).toContain('veritas:readiness');
    expect(commands).toContain('check-prepush-typecheck.mjs');
  });

  /**
   * Readiness re-executes the governance proof as a routed evidence-check, so
   * running it first would report a governance break half a minute late and
   * under the wrong name.
   */
  it('reports the governance proof before the readiness run that re-executes it', () => {
    expect(commands.indexOf('proof:repo-governance')).toBeLessThan(
      commands.indexOf('veritas:readiness'),
    );
  });

  /**
   * The aggregate is ~82s. Unconditionally it would break the hook's own
   * stated doctrine, so the hook must reach it through the scope guard.
   */
  it('reaches the aggregate only through the scope guard', () => {
    expect(commands).not.toContain('typecheck-aggregate.mjs');
    expect(commands).not.toMatch(/npm run (--silent )?typecheck\b/);
  });

  it('leaves moving-main composition freshness to the required merge queue', () => {
    expect(commands).not.toContain('git fetch');
    expect(commands).not.toContain('check-merge-base-fresh.mjs');
    expect(commands).not.toContain('STATION_ALLOW_STALE_BASE');
  });

  it('keeps the hook to seconds-scale checks', () => {
    // full:regression stays the sole completion receipt and ci:fast stays the
    // bounded feedback lane; a hook that runs either becomes a hook people
    // route around with --no-verify. Comments may name them; commands may not.
    // The UI bundle build left the hook for the same reason (#1703): CI's
    // candidate budget step and the merge queue already enforce it.
    expect(commands).not.toMatch(
      /full:regression|ci:fast|test:full|verify:static|build:ui/,
    );
  });
});
