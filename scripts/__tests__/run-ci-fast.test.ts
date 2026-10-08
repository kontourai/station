import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { checkChangesets } from '../check-changesets.mjs';
import {
  CI_FAST_STEP_MARKER_PATTERN,
  ciFastStepMarker,
} from '../lib/ci-fast-step-marker.mjs';
import { npmInvocation } from '../lib/npm-cli.mjs';
import { CHANGED_DEADLINE_ENV as SELECTOR_DEADLINE_ENV } from '../run-changed-verification.mjs';
import {
  CHANGED_DEADLINE_ENV,
  CHANGESET_STATUS_FAST_COMMAND,
  CI_FAST_INFRASTRUCTURE_EXIT_CODE,
  CI_FAST_NESTED_INFRASTRUCTURE_CAUSE,
  CI_FAST_OWNER_INFRASTRUCTURE_PREFIX,
  CiFastInfrastructureError,
  CONTENT_INTEGRITY_FAST_COMMAND,
  classifyCiFastCommandResult,
  describeCiFastCommand,
  FAST_FEEDBACK_TIMEOUT_MS,
  FAST_SCOPE_ENV,
  FAST_SELECTOR_DISCOVERY_SHARE,
  FAST_STATIC_COMMANDS,
  FAST_STATIC_RESERVE_MS,
  fastBase,
  fastScope,
  formatCiFastElapsedSeconds,
  runCiFast,
  runCiFastCli,
  SELECTOR_DEFERRED_EXIT_CODE,
  SELECTOR_DEFERRED_MESSAGE,
} from '../run-ci-fast.mjs';

const [, contentIntegrityArgs] = CONTENT_INTEGRITY_FAST_COMMAND;
const contentIntegrityScript = contentIntegrityArgs[1];
const contentGateRepos = new Set<string>();
const makeTempDir = trackTempDirs();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of contentGateRepos)
    rmSync(dir, { recursive: true, force: true });
  contentGateRepos.clear();
});

/** The copied gate imports its entry guard from scripts/lib (#2682). */
function copyEntryGuard(dir: string): void {
  copyFileSync(
    join(process.cwd(), 'scripts', 'lib', 'module-entry.mjs'),
    join(dir, 'scripts', 'lib', 'module-entry.mjs'),
  );
}

function contentGateRepo(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-ci-fast-content-gate-'));
  contentGateRepos.add(dir);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'src-server'), { recursive: true });
  copyFileSync(
    join(process.cwd(), 'scripts', 'content-integrity-gate.mjs'),
    join(dir, 'scripts', 'content-integrity-gate.mjs'),
  );
  copyEntryGuard(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        [contentIntegrityScript]: 'node scripts/content-integrity-gate.mjs',
      },
    }),
  );
  writeFileSync(join(dir, 'src-server', 'fixture.ts'), source);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'ci-fast@test.invalid');
  git('config', 'user.name', 'ci-fast');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

function runOnlyFastGate(
  cwd: string,
  gate: readonly [string, readonly string[]] = CONTENT_INTEGRITY_FAST_COMMAND,
): {
  status: number;
  output: string;
} {
  let output = '';
  const status = runCiFast({
    cwd,
    env: { STATION_CI_FAST_BASE: 'fixture-base' },
    execute(command, args, { cwd: childCwd, timeout }) {
      if (command !== gate[0] || args !== gate[1]) return 0;
      const invocation =
        command === 'npm' ? npmInvocation(args) : { command, args };
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: childCwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
      });
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      return result.status ?? 1;
    },
  });
  return { status, output };
}

describe('bounded ci:fast runner', () => {
  it.skipIf(process.platform !== 'win32')(
    'reports an unavailable npm launcher as infrastructure through the real CLI owner',
    () => {
      const root = makeTempDir('station-ci-fast-missing-npm-');
      mkdirSync(join(root, 'scripts'));
      writeFileSync(
        join(root, 'scripts', 'node-runtime-contract.mjs'),
        'process.exit(0);',
      );
      vi.stubEnv('npm_execpath', join(root, 'absent npm', 'npm-cli.js'));
      let errorOutput = '';

      const status = runCiFastCli({
        run: () =>
          runCiFast({
            cwd: root,
            env: { [FAST_SCOPE_ENV]: 'statics' },
            report: () => {},
          }),
        error: (message) => {
          errorOutput += message;
        },
      });

      expect(status).toBe(CI_FAST_INFRASTRUCTURE_EXIT_CODE);
      expect(errorOutput).toContain(CI_FAST_OWNER_INFRASTRUCTURE_PREFIX);
      expect(errorOutput).toContain('cannot resolve npm CLI as a local file');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'runs a required npm invariant through the selected CLI and propagates its failure',
    () => {
      const root = makeTempDir('station-ci-fast-npm-');
      const cliDir = join(root, 'selected npm & cli');
      const marker = join(root, 'npm-argv.json');
      mkdirSync(join(root, 'scripts'));
      mkdirSync(cliDir);
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module' }),
      );
      writeFileSync(
        join(root, 'scripts', 'node-runtime-contract.mjs'),
        'process.exit(0);',
      );
      const cli = join(cliDir, 'npm-cli.js');
      writeFileSync(
        cli,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); process.exit(23);`,
      );
      vi.stubEnv('npm_execpath', cli);

      const status = runCiFast({
        cwd: root,
        env: { [FAST_SCOPE_ENV]: 'statics' },
        report: () => {},
      });

      expect(status).toBe(23);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual([
        'run',
        'dependencies:verify',
      ]);
    },
  );

  it('runs the affected selector before the fixed static invariant set', () => {
    const calls: Array<{ command: string; args: string[]; timeout: number }> =
      [];
    const status = runCiFast({
      cwd: '/fixture',
      env: { STATION_CI_FAST_BASE: 'base-sha' },
      now: () => 1_000,
      execute(command, args, { timeout }) {
        calls.push({ command, args, timeout });
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ['scripts/run-changed-verification.mjs', '--base=base-sha'],
        timeout: FAST_FEEDBACK_TIMEOUT_MS - FAST_STATIC_RESERVE_MS,
      },
      ...FAST_STATIC_COMMANDS.map(([command, args]) => ({
        command,
        args,
        timeout: FAST_FEEDBACK_TIMEOUT_MS,
      })),
    ]);
  });

  it('hands only the selector the end of its allowance (#2855)', () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    runCiFast({
      cwd: '/fixture',
      env: { STATION_CI_FAST_BASE: 'base-sha' },
      now: () => 1_000,
      execute(_command, args, { env }) {
        calls.push({ args, env });
        return 0;
      },
    });
    // 900s lane - 220s static reserve = the selector's 680s allowance, of
    // which related discovery may use a pinned quarter: 170s.
    expect(calls[0].env).toEqual({
      STATION_CI_FAST_BASE: 'base-sha',
      [CHANGED_DEADLINE_ENV]: String(1_000 + 170_000),
    });
    expect(FAST_FEEDBACK_TIMEOUT_MS - FAST_STATIC_RESERVE_MS).toBe(680_000);
    expect(FAST_SELECTOR_DISCOVERY_SHARE).toBe(0.25);
    for (const call of calls.slice(1)) expect(call.env).toBeUndefined();
    // The runner restates the name it cannot import; pin the two equal.
    expect(CHANGED_DEADLINE_ENV).toBe(SELECTOR_DEADLINE_ENV);
  });

  it('drops only the selector when scoped to statics (#2709), and refuses any other scope', () => {
    const calls: Array<{ command: string; args: string[]; timeout: number }> =
      [];
    const status = runCiFast({
      cwd: '/fixture',
      env: { STATION_CI_FAST_BASE: 'base-sha', [FAST_SCOPE_ENV]: 'statics' },
      now: () => 1_000,
      execute(command, args, { timeout }) {
        calls.push({ command, args, timeout });
        return 0;
      },
    });
    expect(status).toBe(0);
    // Every static invariant, in order, each with the whole budget: the
    // selector's reserve applies only to the selector itself.
    expect(calls).toEqual(
      FAST_STATIC_COMMANDS.map(([command, args]) => ({
        command,
        args,
        timeout: FAST_FEEDBACK_TIMEOUT_MS,
      })),
    );
    expect(fastScope({})).toBe('all');
    expect(fastScope({ [FAST_SCOPE_ENV]: '' })).toBe('all');
    for (const scope of ['static', 'STATICS', 'selection', 'all'])
      expect(() => fastScope({ [FAST_SCOPE_ENV]: scope }), scope).toThrow(
        `${FAST_SCOPE_ENV} must be unset or 'statics'`,
      );
    expect(
      runCiFastCli({
        run: () =>
          runCiFast({
            env: { [FAST_SCOPE_ENV]: 'selection' },
            execute: () => 0,
          }),
        error: () => {},
      }),
    ).toBe(2);
  });

  it('pins a small static invariant allowlist with no broad static or full Vitest lane', () => {
    expect(FAST_STATIC_COMMANDS).toEqual([
      [process.execPath, ['scripts/node-runtime-contract.mjs']],
      ['npm', ['run', 'dependencies:verify']],
      ['npm', ['run', 'lockfile-sync:gate']],
      [process.execPath, ['scripts/check-changesets.mjs']],
      [process.execPath, ['scripts/code-health-gate.mjs']],
      [process.execPath, ['scripts/test-realtime-wait-gate.mjs']],
      ['npm', ['run', 'channel-ports:check']],
      ['npm', ['run', 'gate:workflows']],
      // #2922: verify:static gates that otherwise first fail in the queue.
      ['npm', ['run', 'gate:evidence-check-execution']],
      ['npm', ['run', 'install-script:check']],
      ['npm', ['run', 'mobile:permissions:gate']],
      // #3149: a renderer-wide scan no path edge can select.
      ['npm', ['run', 'native-platform:ratchet']],
      ['npm', ['run', 'agent-plugin:validators:gate']],
      ['npm', ['run', 'settings:registry:gate']],
      ['npm', ['run', 'content:integrity']],
      ['npm', ['run', 'content:excluded-names']],
      // CLI help ↔ docs/reference/cli.md parity: a help topic without a
      // reference heading must red the PR lane, not the nightly (the `open`
      // verb shipped green and failed Nightly a day later).
      ['npm', ['run', 'docs:cli-parity:check']],
      ['npm', ['run', 'docs:reference:gate']],
      ['npm', ['run', 'docs:links:check']],
      // Docs-only edits these reject must red fast-checks, not the queue.
      ['npm', ['run', 'docs:public:hygiene']],
      ['npm', ['run', 'docs:issue-lifecycle:check']],
      ['npm', ['run', 'docs:public:contract-examples']],
      // The git-ignored Basis MCP app bundles are generated, not checked:
      // nothing is tracked, so the only freshness question is "does the
      // generator succeed on this tree", and the typecheck aggregate below
      // resolves its output.
      [process.execPath, ['scripts/generate-basis-mcp-apps.mjs']],
      ['npm', ['run', 'verification:policy:gate']],
      // The governance proof, biome, and Veritas readiness. Each was
      // composed only by the nightly full-regression gate or by a per-machine
      // pre-push hook, so a violation of any of the three could not be
      // observed on a pull request; two governance breaks reached main on
      // 2026-09-14 while the Nightly that owned them was itself red.
      ['npm', ['run', 'proof:repo-governance']],
      ['npm', ['run', 'lint:check']],
      // Ordered after the two evidence-checks it re-executes, so a failure in
      // either reports under its own name first.
      ['npm', ['run', 'veritas:readiness', '--', '--format', 'json']],
      // station#4273: the typecheck invariant, and `build:connect` as its
      // stated precondition (typecheck:ui resolves @kontourai/station-connect
      // through packages/connect/dist). The aggregate is invoked DIRECTLY
      // rather than via `npm run typecheck`, which chains dist:freshness
      // ahead of the lanes and would fail on an unbuilt packages/cli/dist
      // before any lane ran.
      ['npm', ['run', 'build:connect']],
      [process.execPath, ['scripts/typecheck-aggregate.mjs']],
    ]);
    expect(JSON.stringify(FAST_STATIC_COMMANDS)).not.toMatch(
      /verify:static|test:full|vitest-corpus/,
    );
  });

  it('fails the fixed static lane for a tracked source hidden by a literal NUL', () => {
    const nul = String.fromCharCode(0);
    const repo = contentGateRepo(`export const key = "left${nul}right";\n`);

    const result = runOnlyFastGate(repo);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'tracked file(s) contain control characters',
    );
    expect(result.output).toContain('src-server/fixture.ts');
  });

  it('accepts a conformant tracked source through the same fixed static lane', () => {
    const repo = contentGateRepo('export const key = "left\\0right";\n');

    const result = runOnlyFastGate(repo);

    expect(result.status).toBe(0);
    expect(result.output).toContain('OK: no control characters');
  });

  it('continues after an explicit selector deferral without treating it as completion', () => {
    const calls: string[] = [];
    const reports: string[] = [];
    let clock = 1_000;
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        now: () => clock,
        execute(command) {
          calls.push(command);
          clock += 1_500;
          return calls.length === 1 ? SELECTOR_DEFERRED_EXIT_CODE : 0;
        },
        report(message) {
          reports.push(message);
        },
      }),
    ).toBe(0);
    expect(calls).toEqual([
      process.execPath,
      ...FAST_STATIC_COMMANDS.map(([command]) => command),
    ]);
    // Each command is announced by its step marker and followed by one
    // timing line, in order; the deferral notice follows the selector's own
    // timing line.
    const [selectorCommand, selectorArgs] = [
      process.execPath,
      ['scripts/run-changed-verification.mjs', '--base=base-sha'],
    ];
    expect(reports).toEqual([
      ciFastStepMarker(selectorCommand, selectorArgs),
      `[ci:fast] ${describeCiFastCommand(selectorCommand, selectorArgs)} 1.5s\n`,
      SELECTOR_DEFERRED_MESSAGE,
      ...FAST_STATIC_COMMANDS.flatMap(([command, args]) => [
        ciFastStepMarker(command, [...args]),
        `[ci:fast] ${describeCiFastCommand(command, args)} 1.5s\n`,
      ]),
    ]);
  });

  it('prints one per-step timing line naming the command and its elapsed seconds', () => {
    const reports: string[] = [];
    let clock = 0;
    runCiFast({
      env: { STATION_CI_FAST_BASE: 'base-sha' },
      now: () => clock,
      execute() {
        clock += 2_340;
        return 0;
      },
      report(message) {
        reports.push(message);
      },
    });
    const timings = reports.filter(
      (line) => !CI_FAST_STEP_MARKER_PATTERN.test(line.trimEnd()),
    );
    expect(timings[0]).toBe(
      `[ci:fast] ${describeCiFastCommand(process.execPath, [
        'scripts/run-changed-verification.mjs',
        '--base=base-sha',
      ])} 2.3s\n`,
    );
    expect(timings).toHaveLength(1 + FAST_STATIC_COMMANDS.length);
    for (const line of timings)
      expect(line).toMatch(/^\[ci:fast\] .+ \d+\.\ds\n$/);
  });

  it('announces each step before running it, so a failing direct node step is attributable', () => {
    const events: string[] = [];
    const failing = FAST_STATIC_COMMANDS.findIndex(([, args]) =>
      args.includes('scripts/code-health-gate.mjs'),
    );
    expect(failing).toBeGreaterThan(0);
    const status = runCiFast({
      env: { STATION_CI_FAST_BASE: 'base-sha' },
      execute(command, args) {
        events.push(`run ${describeCiFastCommand(command, args)}`);
        return events.filter((event) => event.startsWith('run ')).length ===
          failing + 2
          ? 1
          : 0;
      },
      report(message) {
        if (CI_FAST_STEP_MARKER_PATTERN.test(message.trimEnd()))
          events.push(message.trimEnd());
      },
    });
    expect(status).toBe(1);
    // The last announcement before the failing run names that step.
    const lastRun = events.findLastIndex((event) => event.startsWith('run '));
    expect(events[lastRun - 1]).toBe(
      '[ci:fast] step scripts/code-health-gate.mjs',
    );
    expect(events[lastRun]).toContain('scripts/code-health-gate.mjs');
  });

  it('formats a command label and elapsed seconds', () => {
    expect(describeCiFastCommand('npm', ['run', 'veritas:readiness'])).toBe(
      'npm run veritas:readiness',
    );
    expect(formatCiFastElapsedSeconds(82_950)).toBe('83.0');
    expect(formatCiFastElapsedSeconds(0)).toBe('0.0');
  });

  it('preserves the product-law infrastructure exit for the coordinator to classify', () => {
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        execute(_command, args) {
          return args[1] === 'verification:policy:gate'
            ? CI_FAST_INFRASTRUCTURE_EXIT_CODE
            : 0;
        },
      }),
    ).toBe(CI_FAST_INFRASTRUCTURE_EXIT_CODE);
  });

  it.each([
    'selector command timed out',
    'ci:fast command could not start: spawn EACCES',
  ])('renders %s as a classified infrastructure exit', (cause) => {
    const output: string[] = [];
    expect(
      runCiFastCli({
        run: () => {
          throw new CiFastInfrastructureError(cause);
        },
        error: (message) => output.push(message),
      }),
    ).toBe(CI_FAST_INFRASTRUCTURE_EXIT_CODE);
    expect(output).toEqual([
      `${CI_FAST_OWNER_INFRASTRUCTURE_PREFIX}${cause}\n`,
    ]);
  });

  it('classifies a signal-terminated nested command as infrastructure', () => {
    expect(() =>
      classifyCiFastCommandResult({ status: null, signal: 'SIGTERM' }),
    ).toThrow('ci:fast command terminated by signal SIGTERM');
  });

  it('emits a final owner marker when a nested command returns exit 80', () => {
    const output: string[] = [];
    expect(
      runCiFastCli({
        run: () => CI_FAST_INFRASTRUCTURE_EXIT_CODE,
        error: (message) => output.push(message),
      }),
    ).toBe(CI_FAST_INFRASTRUCTURE_EXIT_CODE);
    expect(output).toEqual([
      `${CI_FAST_OWNER_INFRASTRUCTURE_PREFIX}${CI_FAST_NESTED_INFRASTRUCTURE_CAUSE}\n`,
    ]);
  });

  it('keeps exit 2 for policy errors', () => {
    const output: string[] = [];
    expect(
      runCiFastCli({
        run: () => {
          throw new Error('invalid ci-fast policy');
        },
        error: (message) => output.push(message),
      }),
    ).toBe(2);
    expect(output).toEqual(['invalid ci-fast policy\n']);
  });

  it('fails closed for an option-like base and a non-deferred child failure', () => {
    expect(() => fastBase({ STATION_CI_FAST_BASE: '--bad' })).toThrow(
      'must be a Git ref',
    );
    let calls = 0;
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        execute() {
          calls += 1;
          return 1;
        },
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });

  it('reserves time for static invariants and passes the remaining budget to each command', () => {
    let clock = 1_000;
    const calls: number[] = [];
    expect(
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        now: () => clock,
        execute(_command, _args, { timeout }) {
          calls.push(timeout);
          clock += 12_345;
          return 0;
        },
      }),
    ).toBe(0);
    expect(calls).toEqual([
      FAST_FEEDBACK_TIMEOUT_MS - FAST_STATIC_RESERVE_MS,
      ...FAST_STATIC_COMMANDS.map(
        (_, index) => FAST_FEEDBACK_TIMEOUT_MS - 12_345 * (index + 1),
      ),
    ]);
  });

  it('does not launch the next child after the fifteen-minute budget is exhausted', () => {
    let clock = 1_000;
    let calls = 0;
    expect(() =>
      runCiFast({
        env: { STATION_CI_FAST_BASE: 'base-sha' },
        now: () => clock,
        execute() {
          calls += 1;
          clock += FAST_FEEDBACK_TIMEOUT_MS;
          return 0;
        },
      }),
    ).toThrow('exceeded its 15-minute feedback budget');
    expect(calls).toBe(1);
  });
});

describe('Changesets workspace validation through ci:fast', () => {
  it.each(['@fixture/published', '@fixture/root', 'empty'])(
    'checks native release planning for %s',
    async (target) => {
      const dir = mkdtempSync(join(tmpdir(), 'station-changeset-gate-'));
      contentGateRepos.add(dir);
      mkdirSync(join(dir, 'packages', 'published'), { recursive: true });
      mkdirSync(join(dir, '.changeset'));
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
      copyFileSync(
        join(process.cwd(), 'scripts', 'check-changesets.mjs'),
        join(dir, 'scripts', 'check-changesets.mjs'),
      );
      copyEntryGuard(dir);
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@fixture/root',
          private: true,
          version: '1.0.0',
          scripts: { changeset: 'changeset' },
        }),
      );
      writeFileSync(
        join(dir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      writeFileSync(
        join(dir, 'packages', 'published', 'package.json'),
        JSON.stringify({ name: '@fixture/published', version: '1.0.0' }),
      );
      writeFileSync(
        join(dir, '.changeset', 'config.json'),
        JSON.stringify({
          changelog: false,
          fixed: [],
          linked: [],
          access: 'public',
          baseBranch: 'main',
          updateInternalDependencies: 'patch',
          ignore: [],
          privatePackages: true,
        }),
      );
      writeFileSync(
        join(dir, '.changeset', 'fixture.md'),
        target === 'empty'
          ? '---\n---\n\nRoot-only acknowledgement.\n'
          : `---\n"${target}": patch\n---\n\nFixture release note.\n`,
      );
      symlinkSync(
        join(process.cwd(), 'node_modules'),
        join(dir, 'node_modules'),
        'junction',
      );
      const result = runOnlyFastGate(
        dir,
        CHANGESET_STATUS_FAST_COMMAND as readonly [string, readonly string[]],
      );
      if (target !== '@fixture/root') {
        const plan = await checkChangesets(dir);
        expect(plan.packages).toEqual(
          target === 'empty' ? [] : ['@fixture/published'],
        );
        expect(result.status, result.output).toBe(0);
        expect(result.output).toContain(
          target === 'empty' ? '(none)' : '@fixture/published',
        );
      } else {
        await expect(checkChangesets(dir)).rejects.toThrow(
          'package @fixture/root which is not in the workspace',
        );
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          'package @fixture/root which is not in the workspace',
        );
      }
    },
  );
});
