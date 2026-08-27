import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'vitest';

import { BILLING_WAIVER_MAX_EXPIRY_ISO } from '../../station-dogfood-reconcile.mjs';

export const CANDIDATE = 'a'.repeat(40);
export const PREVIOUS = 'b'.repeat(40);
export const OLDER = 'd'.repeat(40);
export const NOW = Date.parse('2026-07-10T12:00:00.000Z');

// The zero-step billing CI waiver's absolute maximum expiry (#347, re-sunset by
// the owner on 2026-08-01 per #1443) and the values derived from it. Every test
// derives these from the reconciler's exported constant instead of restating a
// date: a hardcoded copy is exactly what turned the installer-level
// `billing-policy` case into a wall-clock time bomb that detonated at the
// policy's own sunset instant (#1432).
export { BILLING_WAIVER_MAX_EXPIRY_ISO };
export const WAIVER_SUNSET_MS = Date.parse(BILLING_WAIVER_MAX_EXPIRY_ISO);
/** The strongest expiry the policy accepts: exactly the maximum, normalized. */
export const MAX_WAIVER_EXPIRY = new Date(WAIVER_SUNSET_MS).toISOString();
/** One millisecond past the maximum — must always be refused. */
export const OVERLONG_WAIVER_EXPIRY = new Date(
  WAIVER_SUNSET_MS + 1,
).toISOString();
export const LEGACY_IDENTITY = {
  sha: PREVIOUS,
  instanceId: 'dogfood',
  bootId: '11111111-1111-4111-8111-111111111111',
};
const temporaryRoots: string[] = [];

export function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'station-dogfood-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rmSync } = await import('node:fs');
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// This fixture executes the real zsh/macOS LaunchAgent installer with controlled
// host-command stubs. Portable helper and rollback tests remain enabled on Linux;
// only this OS integration boundary requires Darwin and /bin/zsh semantics.
export const macosInstallerTest = process.platform === 'darwin' ? it : it.skip;

export type FakeOptions = {
  active?: boolean;
  buildFailure?: boolean;
  billing?:
    | 'valid'
    | 'steps'
    | 'nonbilling'
    | 'missing-annotation'
    | 'extra-annotation'
    | 'duplicate-run'
    | 'cancelled-job'
    | 'no-failed'
    | 'malformed-jobs'
    | 'malformed-annotations';
  ci?:
    | 'success'
    | 'pending'
    | 'cancelled'
    | 'failed'
    | 'malformed'
    | 'absent'
    | 'wrong-sha'
    | 'pr-only'
    | 'wrong-workflow';
  configOrigin?: string;
  current?: boolean;
  currentUnhealthy?: boolean;
  dirty?: 'before' | 'after';
  installFailure?: boolean;
  failedListener?: 'api' | 'terminal' | 'voice' | 'ui';
  recoveryFailure?: boolean;
  recoveryHistoryLength?: number;
  localFailure?: boolean;
  minimumHealthTimeoutMs?: number;
  legacyActive?: boolean;
  legacyCommit?: 'fetch' | 'missing' | 'unreachable';
  legacyHeadSha?: string;
  legacyHost?: string;
  legacyIdentityChangesDuringBuild?: boolean;
  legacyOrigin?: string;
  provenanceMismatch?: boolean;
  protectedApiIdentity?: boolean;
  rollbackFailure?: boolean;
  stopFailure?: boolean;
  stagedCandidate?: boolean;
  tailnetFailure?: boolean;
  tailnetReadinessFailure?: boolean;
  tailnetRequiresStateHealth?: boolean;
  tailnetRollbackFailure?: boolean;
};

export type FixtureConfig = {
  version: number;
  repo: string;
  githubRepo: string;
  instance: string;
  stationHome: string;
  supportDir: string;
  logDir: string;
  serverPort: number;
  uiPort: number;
  tailnetUrl: string;
};

export type FixtureCommandCall = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type FixtureCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type ListenerName = 'api' | 'terminal' | 'voice' | 'ui';

export interface ReconcileFixtureCapabilities {
  calls: FixtureCommandCall[];
  config: FixtureConfig;
  forceStartStates: unknown[];
  failListener(name: ListenerName): void;
  readonly runningSha: string | null;
  readonly statusChecks: number;
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): FixtureCommandResult;
  state(): ReturnType<typeof JSON.parse>;
}

export function createFixture(
  options: FakeOptions = {},
): ReconcileFixtureCapabilities {
  const root = fixtureRoot();
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'station-home');
  const supportDir = path.join(root, 'support');
  const logDir = path.join(root, 'logs');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const config: FixtureConfig = {
    version: 1,
    repo,
    githubRepo: 'kontourai/station',
    instance: 'dogfood',
    stationHome: home,
    supportDir,
    logDir,
    serverPort: 3141,
    uiPort: 3000,
    tailnetUrl: 'https://station.example.ts.net',
  };
  const calls: FixtureCommandCall[] = [];
  const statuses = { candidate: 0 };
  const forceStartStates: unknown[] = [];
  const initialActiveSha =
    options.current || options.currentUnhealthy ? CANDIDATE : PREVIOUS;
  let runningSha =
    options.active === false && !options.legacyActive ? null : initialActiveSha;
  const listenerHealth = {
    api: !(options.currentUnhealthy || options.failedListener === 'api'),
    terminal: options.failedListener !== 'terminal',
    voice: options.failedListener !== 'voice',
    ui: options.failedListener !== 'ui',
  };
  let statusChecks = 0;
  let bootCounter = 1;
  let runningBootId = '11111111-1111-4111-8111-111111111111';
  let candidateWasStarted = false;

  if (options.active !== false || options.legacyActive) {
    const previousPath = path.join(supportDir, 'releases', initialActiveSha);
    mkdirSync(previousPath, { recursive: true });
    mkdirSync(path.join(previousPath, 'dist-server-dogfood'), {
      recursive: true,
    });
    writeFileSync(
      path.join(previousPath, 'dist-server-dogfood/station-build.json'),
      JSON.stringify({
        sha: initialActiveSha,
        branch: 'main',
        builtAt: '2026-07-10T00:00:00.000Z',
      }),
    );
    mkdirSync(path.join(previousPath, '.station', 'instances'), {
      recursive: true,
    });
    writeFileSync(
      path.join(previousPath, '.station', 'instances', 'dogfood.json'),
      JSON.stringify({
        instanceId: 'dogfood',
        bootId: '11111111-1111-4111-8111-111111111111',
        build: { sha: initialActiveSha },
        serverPid: 1001,
        serverPort: config.serverPort,
        uiPort: config.uiPort,
        host: options.legacyHost ?? '127.0.0.1',
      }),
      { mode: 0o600 },
    );
    mkdirSync(supportDir, { recursive: true });
    chmodSync(supportDir, 0o700);
    writeFileSync(
      path.join(supportDir, 'state.json'),
      `${JSON.stringify({
        version: 1,
        active:
          options.active === false
            ? null
            : { sha: initialActiveSha, path: previousPath },
        previous: null,
        failedCandidates: [],
        recoveryHistory: Array.from(
          { length: options.recoveryHistoryLength ?? 0 },
          (_, index) => ({
            sha: initialActiveSha,
            outcome: 'recovered',
            detectedAt: new Date(NOW - (index + 1) * 1_000).toISOString(),
          }),
        ),
      })}\n`,
    );
  }
  if (options.stagedCandidate) {
    const candidatePath = path.join(supportDir, 'releases', CANDIDATE);
    mkdirSync(path.join(candidatePath, 'dist-server-dogfood'), {
      recursive: true,
    });
    writeFileSync(
      path.join(candidatePath, 'dist-server-dogfood/station-build.json'),
      JSON.stringify({
        sha: CANDIDATE,
        branch: 'main',
        builtAt: '2026-07-10T00:00:00.000Z',
      }),
    );
    const statePath = path.join(supportDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.reconciliation = {
      desired: { sha: CANDIDATE },
      source: { sha: CANDIDATE, repo },
      built: { sha: CANDIDATE, path: candidatePath, complete: true },
      running: { sha: initialActiveSha },
      phase: 'built',
      updatedAt: new Date(NOW - 1_000).toISOString(),
      failure: null,
    };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  function result(status = 0, stdout = '', stderr = '') {
    return { status, stdout, stderr };
  }

  function run(
    command: string,
    args: string[],
    runOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    calls.push({ command, args: [...args], ...runOptions });
    if (command === 'git' && args.includes('get-url')) {
      const commandRepo = runOptions.cwd ?? args[args.indexOf('-C') + 1];
      if (options.configOrigin && commandRepo === config.repo) {
        return result(0, `${options.configOrigin}\n`);
      }
      if (options.legacyOrigin && path.basename(commandRepo) === PREVIOUS) {
        return result(0, `${options.legacyOrigin}\n`);
      }
      return result(0, 'git@github.com:kontourai/station.git\n');
    }
    if (command === 'git' && args.includes('fetch')) {
      return options.legacyCommit === 'fetch'
        ? result(1, '', 'network unavailable')
        : result();
    }
    if (command === 'git' && args.includes('cat-file')) {
      return options.legacyCommit === 'missing'
        ? result(1, '', 'unknown revision')
        : result();
    }
    if (command === 'git' && args.includes('merge-base')) {
      return options.legacyCommit === 'unreachable'
        ? result(1, '', 'not an ancestor')
        : result();
    }
    if (command === 'git' && args.at(-2) === 'rev-parse') {
      const target = args.at(-1);
      const cwd = args[args.indexOf('-C') + 1];
      const headSha =
        options.legacyHeadSha && path.basename(cwd) === PREVIOUS
          ? options.legacyHeadSha
          : path.basename(cwd).split('--')[0];
      return result(0, `${target === 'HEAD' ? headSha : CANDIDATE}\n`);
    }
    if (command === 'git' && args.includes('worktree')) {
      if (args.includes('add')) {
        mkdirSync(args.at(-2) as string, { recursive: true });
      } else if (args.includes('remove')) {
        rmSync(args.at(-1) as string, { recursive: true, force: true });
      }
      return result();
    }
    if (command === 'git' && args.includes('symbolic-ref')) return result(1);
    if (command === 'git' && args.includes('status')) {
      statuses.candidate += 1;
      if (options.dirty === 'before' && statuses.candidate === 1) {
        return result(0, '?? unexpected.txt\n');
      }
      if (options.dirty === 'after' && statuses.candidate === 2) {
        return result(0, ' M package-lock.json\n');
      }
      return result();
    }
    if (command === 'gh') {
      const ci = options.ci ?? 'success';
      if (args[0] === 'run' && args[1] === 'view') {
        if (options.billing === 'malformed-jobs') return result(0, '{');
        const conclusion =
          options.billing === 'cancelled-job' ? 'cancelled' : 'failure';
        const jobs =
          options.billing === 'no-failed'
            ? [
                {
                  databaseId: 92,
                  name: 'Full Playwright',
                  conclusion: 'skipped',
                  steps: [],
                },
              ]
            : [
                {
                  databaseId: 91,
                  name: 'Test',
                  conclusion,
                  steps:
                    options.billing === 'steps'
                      ? [{ name: 'Checkout', conclusion: 'success' }]
                      : [],
                },
                {
                  databaseId: 92,
                  name: 'Full Playwright',
                  conclusion: 'skipped',
                  steps: [],
                },
              ];
        return result(0, JSON.stringify({ jobs }));
      }
      if (args[0] === 'api') {
        if (options.billing === 'malformed-annotations') return result(0, '{');
        if (options.billing === 'missing-annotation') return result(0, '[]');
        const exact = {
          annotation_level: 'failure',
          message:
            options.billing === 'nonbilling'
              ? 'The job failed because tests failed.'
              : "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
        };
        return result(
          0,
          JSON.stringify(
            options.billing === 'extra-annotation'
              ? [exact, { annotation_level: 'warning', message: 'extra' }]
              : [exact],
          ),
        );
      }
      if (ci === 'malformed') return result(0, '{');
      if (ci === 'absent') return result(0, '[]');
      const record = {
        databaseId: 42,
        headSha: ci === 'wrong-sha' ? PREVIOUS : CANDIDATE,
        status: ci === 'pending' ? 'in_progress' : 'completed',
        conclusion:
          ci === 'failed'
            ? 'failure'
            : ci === 'cancelled'
              ? 'cancelled'
              : ci === 'pending'
                ? ''
                : 'success',
        event: ci === 'pr-only' ? 'pull_request' : 'push',
        workflowName: ci === 'wrong-workflow' ? 'Publish Packages' : 'CI',
        url: 'https://github.example/runs/42',
      };
      return result(
        0,
        JSON.stringify(
          options.billing === 'duplicate-run'
            ? [record, { ...record, databaseId: 43 }]
            : [record],
        ),
      );
    }
    if (command === 'npm') {
      return options.installFailure
        ? result(1, '', 'dependency install failed')
        : result();
    }
    if (command === './station') {
      const action = args[0];
      const releaseSha = path.basename(runOptions.cwd as string).split('--')[0];
      if (action === 'build') {
        mkdirSync(path.join(runOptions.cwd as string, 'dist-server-dogfood'), {
          recursive: true,
        });
        writeFileSync(
          path.join(
            runOptions.cwd as string,
            'dist-server-dogfood/station-build.json',
          ),
          JSON.stringify({
            sha: releaseSha,
            branch: 'main',
            builtAt: '2026-07-10T00:00:00.000Z',
          }),
        );
        if (options.legacyIdentityChangesDuringBuild) {
          const legacyStatePath = path.join(
            supportDir,
            'releases',
            PREVIOUS,
            '.station',
            'instances',
            'dogfood.json',
          );
          const legacyState = JSON.parse(readFileSync(legacyStatePath, 'utf8'));
          legacyState.bootId = '99999999-1111-4111-8111-111111111111';
          writeFileSync(legacyStatePath, JSON.stringify(legacyState), {
            mode: 0o600,
          });
        }
        return options.buildFailure ? result(1, '', 'build failed') : result();
      }
      if (action === 'stop') {
        if (options.stopFailure && runningSha === CANDIDATE) {
          return result(1, '', 'managed process still running');
        }
        runningSha = null;
        return result();
      }
      if (action === 'start') {
        if (args.includes('--force')) {
          forceStartStates.push(
            JSON.parse(
              readFileSync(path.join(supportDir, 'state.json'), 'utf8'),
            ),
          );
        }
        if (
          options.stopFailure &&
          runningSha === CANDIDATE &&
          args.includes('--force')
        ) {
          return result(1, '', 'managed process still running');
        }
        if (options.rollbackFailure && releaseSha === PREVIOUS) {
          return result(1, '', 'rollback start failed');
        }
        if (args.includes('--rotate-log-on-restart')) {
          const runtimeLog = path.join(config.logDir, 'station-runtime.log');
          if (existsSync(runtimeLog)) {
            renameSync(runtimeLog, `${runtimeLog}.previous`);
            writeFileSync(runtimeLog, '', { mode: 0o600 });
          }
        }
        runningSha = releaseSha;
        if (releaseSha === CANDIDATE) candidateWasStarted = true;
        bootCounter += 1;
        runningBootId = `${String(bootCounter).padStart(8, '0')}-1111-4111-8111-111111111111`;
        mkdirSync(
          path.join(runOptions.cwd as string, '.station', 'instances'),
          {
            recursive: true,
          },
        );
        writeFileSync(
          path.join(
            runOptions.cwd as string,
            '.station',
            'instances',
            'dogfood.json',
          ),
          JSON.stringify({
            instanceId: 'dogfood',
            bootId: runningBootId,
            build: { sha: releaseSha },
            serverPid: 1000 + bootCounter,
            serverPort: config.serverPort,
            uiPort: config.uiPort,
            host: '127.0.0.1',
          }),
          { mode: 0o600 },
        );
        if (!options.recoveryFailure) {
          listenerHealth.api = true;
          listenerHealth.terminal = true;
          listenerHealth.voice = true;
          listenerHealth.ui = true;
        }
        return result();
      }
    }
    if (command === process.execPath) {
      if (String(args[0]).endsWith('station-dogfood-health.mjs')) {
        statusChecks += 3;
        const failedChecks = Object.entries(listenerHealth)
          .filter(([, healthy]) => !healthy || !runningSha)
          .map(([name]) => name);
        const timeoutMs = Number(
          args.find((arg) => arg.startsWith('--timeout-ms='))?.split('=')[1],
        );
        if (
          options.minimumHealthTimeoutMs &&
          timeoutMs < options.minimumHealthTimeoutMs
        ) {
          failedChecks.push('probe-budget');
        }
        if (
          options.localFailure &&
          runningSha === CANDIDATE &&
          !failedChecks.includes('api')
        ) {
          failedChecks.push('api');
        }
        const stateArg = args.find((arg) =>
          arg.startsWith('--instance-state='),
        );
        const state = stateArg
          ? JSON.parse(
              readFileSync(stateArg.slice('--instance-state='.length), 'utf8'),
            )
          : null;
        const hostAccepted =
          (state?.host === '127.0.0.1' &&
            !args.includes('--allow-wildcard-host')) ||
          (state?.host === '0.0.0.0' && args.includes('--allow-wildcard-host'));
        if (!hostAccepted) failedChecks.push('instance-host');
        const payload = {
          healthy: failedChecks.length === 0,
          identity: {
            instanceId: state?.instanceId,
            sha: state?.build?.sha,
            bootId: state?.bootId,
          },
          pid: state?.serverPid,
          failedChecks,
        };
        return result(
          failedChecks.length === 0 ? 0 : 1,
          JSON.stringify(payload),
          failedChecks.join(', '),
        );
      }
      throw new Error(`unexpected node command: ${args.join(' ')}`);
    }
    if (command === 'curl') {
      statusChecks += 1;
      const url = args.at(-1) as string;
      if (
        url === `http://127.0.0.1:${config.serverPort}/api/system/status` &&
        (!runningSha ||
          !listenerHealth.api ||
          (options.localFailure && runningSha === CANDIDATE))
      ) {
        return result(22, '', 'local unavailable');
      }
      if (
        url === `http://127.0.0.1:${config.uiPort}` &&
        (!runningSha || !listenerHealth.ui)
      ) {
        return result(22, '', 'ui unavailable');
      }
      if (
        ((options.tailnetFailure && runningSha === CANDIDATE) ||
          (options.tailnetRollbackFailure &&
            candidateWasStarted &&
            runningSha === PREVIOUS)) &&
        url.startsWith('https://')
      ) {
        return result(22, '', 'tailnet unavailable');
      }
      if (
        options.tailnetReadinessFailure &&
        runningSha === CANDIDATE &&
        url.endsWith('/api/system/readiness')
      ) {
        return result(22, '', 'tailnet readiness unavailable');
      }
      if (
        options.protectedApiIdentity &&
        url.endsWith('/api/system/identity')
      ) {
        return result(22, '', 'remote authentication denied');
      }
      if (
        url.endsWith('/api/system/identity') ||
        url.endsWith('/__station/identity')
      ) {
        return result(
          0,
          JSON.stringify({
            instanceId: config.instance,
            sha:
              options.provenanceMismatch && runningSha === CANDIDATE
                ? PREVIOUS
                : runningSha,
            bootId: runningBootId,
          }),
        );
      }
      if (url.endsWith('/api/system/readiness')) {
        if (options.tailnetRequiresStateHealth) {
          const supervisor = JSON.parse(
            readFileSync(path.join(supportDir, 'state.json'), 'utf8'),
          );
          if (
            supervisor.health?.status !== 'ready' ||
            supervisor.health?.sha !== runningSha
          ) {
            return result(22, '', 'tailnet readiness unavailable');
          }
        }
        return result(0, JSON.stringify({ ready: true, status: 'ready' }));
      }
      return result(
        0,
        JSON.stringify({
          success: true,
          data: {
            ready: true,
            build: {
              sha:
                options.provenanceMismatch && runningSha === CANDIDATE
                  ? PREVIOUS
                  : runningSha,
            },
          },
        }),
      );
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  }

  return {
    calls,
    config,
    forceStartStates,
    failListener(name: keyof typeof listenerHealth) {
      listenerHealth[name] = false;
    },
    get runningSha() {
      return runningSha;
    },
    get statusChecks() {
      return statusChecks;
    },
    run,
    state() {
      return JSON.parse(
        readFileSync(path.join(supportDir, 'state.json'), 'utf8'),
      );
    },
  };
}
