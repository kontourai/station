import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveVerificationToolchain } from '../lib/test-reliability.mjs';
import { createVerificationRequest } from '../lib/verification-receipt.mjs';
import { verificationRetentionInventory } from '../lib/verification-retention-inventory.mjs';
import {
  __verificationSubmissionInternals,
  runSubmittedVerification,
  submitVerification,
  sweepTerminalSubmissionHandoffs,
  verificationSubmissionStatus,
} from '../lib/verification-submission.mjs';
import {
  classifyCoordinatingWorker,
  createWorkerIdentityProbe,
} from '../lib/verification-worker-identity.mjs';

function provenance(worktree: string, identity = 'stable') {
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const toolchain = resolveVerificationToolchain({ cwd: worktree });
  return {
    repositoryId: hash('repository'),
    worktree,
    headSha: 'b'.repeat(40),
    workspaceDigest: hash(`workspace-${identity}`),
    environmentDigest: 'e'.repeat(64),
    dependencyDigest: 'c'.repeat(64),
    nodeVersion: process.version,
    toolchain: toolchain.toolchain,
    toolchainIdentity: toolchain.identity,
    platform: process.platform,
    arch: process.arch,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-submission-'));
  const worktree = join(root, 'worktree');
  mkdirSync(worktree);
  return {
    root,
    worktree,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('verification submission handoff', () => {
  test('continues submission when best-effort GC summary persistence fails', async () => {
    const temp = fixture();
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      unref: () => undefined,
      disconnect: () => undefined,
      send: (_message: unknown, callback: (error?: Error) => void) =>
        callback(),
    });
    try {
      const result = await submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => provenance(temp.worktree),
        spawnWorker: (_command: string, args: string[]) => {
          queueMicrotask(() => {
            child.emit('message', {
              type: 'verification-submission-ready',
              worker: {
                pid: child.pid,
                nonce: 'worker',
                launchToken: args
                  .at(-1)
                  ?.slice('--verification-launch-token='.length),
              },
            });
          });
          return child;
        },
        maintenanceHooks: {
          writeSummary: () => {
            throw new Error('summary replacement failed');
          },
        },
      });

      expect(result).toMatchObject({ status: 'accepted' });
      expect(
        verificationRetentionInventory({ root: temp.root }).lastSweep,
      ).toBe(null);
    } finally {
      temp.remove();
    }
  });

  test('uses the destination-retire fallback only for a GC summary, never a handoff update', () => {
    const temp = fixture();
    const request = createVerificationRequest(
      'full-regression',
      provenance(temp.worktree),
    );
    let retirements = 0;
    let failFirstReplacement = true;
    try {
      writeFileSync(
        join(temp.root, 'terminal-handoff-gc.json'),
        JSON.stringify({
          at: 1,
          removed: 0,
          skipped: 0,
          truncated: false,
          nonactionable: false,
        }),
      );
      sweepTerminalSubmissionHandoffs({
        root: temp.root,
        gcHooks: {
          platform: 'win32',
          renameSync: (from: string, to: string) => {
            if (
              failFirstReplacement &&
              from.includes('.tmp') &&
              to.endsWith('terminal-handoff-gc.json')
            ) {
              failFirstReplacement = false;
              throw Object.assign(new Error('occupied destination'), {
                code: 'EPERM',
              });
            }
            renameSync(from, to);
          },
          onSummaryDestinationRetire: () => {
            retirements += 1;
          },
        },
      });
      expect(retirements).toBe(1);
      expect(
        verificationRetentionInventory({ root: temp.root }).lastSweep,
      ).toMatchObject({ removed: 0, nonactionable: false });

      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const handoffFile = join(acquired.directory, 'handoff.json');
      const before = readFileSync(handoffFile, 'utf8');
      const renameCalls: Array<[string, string]> = [];
      expect(() =>
        __verificationSubmissionInternals.writeJsonAtomic(
          handoffFile,
          { ...JSON.parse(before), state: 'awaiting_readiness' },
          {
            rename: (from: string, to: string) => {
              renameCalls.push([from, to]);
              throw Object.assign(new Error('occupied handoff'), {
                code: 'EPERM',
              });
            },
          },
        ),
      ).toThrow('occupied handoff');
      expect(readFileSync(handoffFile, 'utf8')).toBe(before);
      expect(
        renameCalls.some(
          ([from, to]) =>
            from === handoffFile && to.startsWith(`${handoffFile}.previous-`),
        ),
      ).toBe(false);
      expect(
        readdirSync(acquired.directory).filter((entry) =>
          entry.includes('.tmp'),
        ),
      ).toEqual([]);
      __verificationSubmissionInternals.updateHandoff(acquired.directory, {
        state: 'awaiting_readiness',
      });
      expect(retirements).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('starts one detached worker, waits for readiness, and joins an exact handoff', async () => {
    const temp = fixture();
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      unref: () => undefined,
      disconnect: () => undefined,
      send: (_message: unknown, callback: (error?: Error) => void) =>
        callback(),
    });
    let spawns = 0;
    const spawnWorker = (_command: string, args: string[], options: object) => {
      spawns += 1;
      expect(options).toMatchObject({
        cwd: temp.worktree,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      expect(args.at(-1)).toMatch(/^--verification-launch-token=[a-f0-9]{32}$/);
      queueMicrotask(() => {
        child.emit('message', {
          type: 'verification-submission-ready',
          worker: {
            pid: child.pid,
            nonce: 'worker',
            launchToken: args
              .at(-1)
              ?.slice('--verification-launch-token='.length),
            identity: { bootId: 'boot', process: { token: 'birth' } },
          },
        });
      });
      return child;
    };
    try {
      const first = await submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => provenance(temp.worktree),
        spawnWorker,
      });
      const second = await submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => provenance(temp.worktree),
        spawnWorker,
        identityProbe: () => ({
          bootId: 'boot',
          process: { pid: child.pid, token: 'birth' },
        }),
      });

      expect(first).toMatchObject({
        status: 'accepted',
        evidence: false,
        disposition: 'submitted',
      });
      expect(first).not.toHaveProperty('receipt');
      expect(second).toMatchObject({
        status: 'accepted',
        evidence: false,
        disposition: 'joined',
        requestKey: first.requestKey,
      });
      expect(spawns).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('fails closed before execution when the worker re-derives a different request', async () => {
    const temp = fixture();
    const first = provenance(temp.worktree, 'before');
    const request = createVerificationRequest('full-regression', first);
    let coordinateCalls = 0;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const outcome = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => provenance(temp.worktree, 'after'),
        coordinate: async () => {
          coordinateCalls += 1;
          return { disposition: 'executed' };
        },
        send: () => undefined,
      });

      expect(outcome.state).toBe('stale_before_execution');
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({ state: 'stale_before_execution' });
    } finally {
      temp.remove();
    }
    expect(coordinateCalls).toBe(0);
  });

  test('fails closed before execution when the bound executable identity changes', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree, 'toolchain-before');
    const request = createVerificationRequest('full-regression', before);
    let coordinateCalls = 0;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const outcome = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => ({
          ...before,
          toolchainIdentity: { digest: 'e'.repeat(64) },
        }),
        coordinate: async () => {
          coordinateCalls += 1;
          return { disposition: 'executed' };
        },
        send: () => undefined,
      });

      expect(outcome.state).toBe('stale_before_execution');
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({ state: 'stale_before_execution' });
    } finally {
      temp.remove();
    }
    expect(coordinateCalls).toBe(0);
  });

  test('does not accept a pre-ack handoff before it is coordinating', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let spawnCalls = 0;
    let clock = 0;
    let releaseWait: (() => void) | undefined;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      let settled = false;
      const joined = submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => before,
        spawnWorker: () => {
          spawnCalls += 1;
          throw new Error('joiner must not start a worker');
        },
        readinessTimeoutMs: 100,
        now: () => clock,
        wait: () =>
          new Promise<void>((resolveWait) => {
            releaseWait = resolveWait;
          }),
      }).then((result) => {
        settled = true;
        return result;
      });

      expect(settled).toBe(false);
      expect(releaseWait).toBeTypeOf('function');
      __verificationSubmissionInternals.updateHandoff(acquired.directory, {
        state: 'coordinating',
        worker: {
          pid: 4321,
          nonce: 'ready',
          launchToken: acquired.handoff.launchToken,
        },
      });
      clock = 100;
      releaseWait?.();
      await expect(joined).resolves.toMatchObject({
        status: 'accepted',
        disposition: 'joined',
      });
      expect(spawnCalls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test.each([
    ['failed_to_start', 'fixture worker failed'],
    ['stale_before_execution', 'fixture worktree changed'],
  ])(
    'returns %s terminal handoffs as nonaccepted states',
    async (state, error) => {
      const temp = fixture();
      const before = provenance(temp.worktree);
      const request = createVerificationRequest('full-regression', before);
      try {
        const acquired = __verificationSubmissionInternals.acquireHandoff({
          root: temp.root,
          request,
        });
        __verificationSubmissionInternals.updateHandoff(acquired.directory, {
          state,
          error,
        });
        const result = await submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => before,
          spawnWorker: () => {
            throw new Error('terminal handoff must not restart');
          },
        });

        expect(result).toMatchObject({
          status: state,
          evidence: false,
          error,
        });
      } finally {
        temp.remove();
      }
    },
  );

  test('releases a failed readiness handshake IPC handle without signaling its worker', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    let disconnects = 0;
    let unrefs = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      disconnect: () => {
        disconnects += 1;
      },
      unref: () => {
        unrefs += 1;
      },
    });
    try {
      await expect(
        submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => before,
          spawnWorker: () => child,
          readinessTimeoutMs: 1,
        }),
      ).rejects.toThrow('readiness handshake timed out');
      expect(disconnects).toBe(1);
      expect(unrefs).toBe(1);
      const [handoff] = verificationSubmissionStatus({
        root: temp.root,
      }).submissions;
      expect(handoff).toMatchObject({ state: 'failed_to_start' });
    } finally {
      temp.remove();
    }
  });

  test('reports the persisted handoff state through submit-status', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      expect(
        verificationSubmissionStatus({
          root: temp.root,
          requestKey: request.key,
        }),
      ).toEqual({
        submissions: [
          expect.objectContaining({
            requestKey: request.key,
            state: 'launching',
          }),
        ],
        truncated: false,
        retention: expect.objectContaining({
          terminal: { retained: 0, eligible: 0, complete: true },
          handoffs: { launching: 1, coordinating: 0, retryClaims: 0 },
        }),
      });
    } finally {
      temp.remove();
    }
  });

  // station#3584: the full-regression handoff a caller submits and then
  // polls is precisely where "re-run rather than diagnose" matters most —
  // dropping indeterminate here left the one surface a submit caller reads
  // unable to tell an unsupported false from a genuine one.
  test('carries terminal.indeterminate through submit-status when the settled receipt is indeterminate', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(acquired.directory, {
        state: 'settled',
        terminal: {
          status: 'completed',
          exitCode: 0,
          passed: false,
          indeterminate: true,
        },
      });
      expect(
        verificationSubmissionStatus({
          root: temp.root,
          requestKey: request.key,
        }).submissions,
      ).toEqual([
        expect.objectContaining({
          state: 'settled',
          terminal: {
            status: 'completed',
            passed: false,
            indeterminate: true,
          },
        }),
      ]);
    } finally {
      temp.remove();
    }
  });

  test('does not carry indeterminate through submit-status for a genuine (non-indeterminate) failure', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(acquired.directory, {
        state: 'settled',
        terminal: { status: 'failed', exitCode: 1, passed: false },
      });
      const [submission] = verificationSubmissionStatus({
        root: temp.root,
        requestKey: request.key,
      }).submissions;
      expect(submission.terminal).toEqual({ status: 'failed', passed: false });
      expect(submission.terminal).not.toHaveProperty('indeterminate');
    } finally {
      temp.remove();
    }
  });

  test('does not coordinate until the parent acknowledges worker readiness', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let coordinateCalls = 0;
    let releaseAcknowledgement!: () => void;
    let readyWorker:
      | { pid: number; nonce: string; startedAt: number; launchToken: string }
      | undefined;
    const acknowledgement = new Promise<void>((resolveAcknowledgement) => {
      releaseAcknowledgement = resolveAcknowledgement;
    });
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const worker = runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => before,
        awaitAcknowledgement: () => acknowledgement,
        coordinate: async () => {
          coordinateCalls += 1;
          return { disposition: 'executed' };
        },
        send: (message: {
          worker?: {
            pid: number;
            nonce: string;
            startedAt: number;
            launchToken: string;
          };
        }) => {
          readyWorker = message.worker;
        },
      });

      await new Promise((resolveWait) => setImmediate(resolveWait));
      expect(coordinateCalls).toBe(0);
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({ state: 'launching' });
      expect(readyWorker).toMatchObject({ pid: process.pid });
      __verificationSubmissionInternals.coordinateReadyWorker(
        acquired.directory,
        readyWorker,
      );
      releaseAcknowledgement();
      await expect(worker).resolves.toMatchObject({ state: 'settled' });
      expect(coordinateCalls).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('does not coordinate after a readiness acknowledgment failure', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let coordinateCalls = 0;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const outcome = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => before,
        awaitAcknowledgement: async () => {
          throw new Error('fixture acknowledgment timeout');
        },
        coordinate: async () => {
          coordinateCalls += 1;
          return { disposition: 'executed' };
        },
        send: () => undefined,
      });

      expect(outcome.state).toBe('failed_to_start');
      expect(coordinateCalls).toBe(0);
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        state: 'failed_to_start',
        error: 'fixture acknowledgment timeout',
      });
    } finally {
      temp.remove();
    }
  });

  test('persists worker identity and the handoff settlement without exposing receipt evidence', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const expectedRequests: unknown[] = [];
      const outcome = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => before,
        coordinate: async (options: { expectedRequest: unknown }) => {
          expectedRequests.push(options.expectedRequest);
          return { disposition: 'joined' };
        },
        send: () => undefined,
        awaitAcknowledgement: async ({ worker }) => {
          __verificationSubmissionInternals.coordinateReadyWorker(
            acquired.directory,
            worker,
          );
        },
      });

      expect(outcome.state).toBe('settled');
      expect(expectedRequests).toEqual([request]);
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        state: 'settled',
        request,
        worker: { pid: process.pid },
        disposition: 'joined',
      });
    } finally {
      temp.remove();
    }
  });

  test('retries one settled cap rejection as a fresh exact-key generation', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    const rejectedTerminal = {
      status: 'rejected',
      exitCode: null,
      passed: false,
    };
    const passedTerminal = {
      status: 'completed',
      exitCode: 0,
      passed: true,
    };
    let retryCoordinateCalls = 0;
    let retryWorker: Promise<unknown> | undefined;
    let releaseFreshRetry!: () => void;
    const freshRetryGate = new Promise<void>((resolveFreshRetry) => {
      releaseFreshRetry = resolveFreshRetry;
    });
    let retryAcknowledged!: () => void;
    const retryAcknowledgement = new Promise<void>((resolveAcknowledged) => {
      retryAcknowledged = resolveAcknowledged;
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      unref: () => undefined,
      disconnect: () => undefined,
      send: (message: { type?: string }, callback: (error?: Error) => void) => {
        if (message.type === 'verification-submission-ack') retryAcknowledged();
        callback();
      },
    });
    let spawns = 0;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const rejected = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => before,
        coordinate: async () => {
          return {
            disposition: 'executed',
            receipt: { terminal: rejectedTerminal },
          };
        },
        send: () => undefined,
        awaitAcknowledgement: async ({ worker }) => {
          __verificationSubmissionInternals.coordinateReadyWorker(
            acquired.directory,
            worker,
          );
        },
      });
      expect(rejected).toMatchObject({ state: 'settled' });
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        state: 'settled',
        generation: 1,
        terminal: rejectedTerminal,
      });
      expect(
        verificationSubmissionStatus({
          root: temp.root,
          requestKey: request.key,
        }).submissions,
      ).toEqual([
        expect.objectContaining({
          state: 'settled',
          terminal: { status: 'rejected', passed: false },
        }),
      ]);

      const spawnWorker = (
        _command: string,
        args: string[],
        _options: object,
      ) => {
        spawns += 1;
        const directory = args.at(-2)!;
        const launchToken =
          args.at(-1)?.slice('--verification-launch-token='.length) ?? '';
        queueMicrotask(() => {
          retryWorker = runSubmittedVerification({
            directory,
            launchToken,
            platform: 'linux',
            cwd: temp.worktree,
            collectProvenance: () => before,
            coordinate: async () => {
              retryCoordinateCalls += 1;
              await freshRetryGate;
              return {
                disposition: 'executed',
                receipt: { terminal: passedTerminal },
              };
            },
            send: (message: object) => child.emit('message', message),
            awaitAcknowledgement: () => retryAcknowledgement,
          });
        });
        return child;
      };
      const [firstRetry, concurrentRetry] = await Promise.all([
        submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => before,
          spawnWorker,
        }),
        submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => before,
          spawnWorker,
        }),
      ]);
      expect(firstRetry).toMatchObject({
        status: 'accepted',
        disposition: 'submitted',
      });
      expect(concurrentRetry).toMatchObject({
        status: 'accepted',
        disposition: 'joined',
      });
      expect(spawns).toBe(1);
      releaseFreshRetry();
      await expect(retryWorker).resolves.toMatchObject({ state: 'settled' });
      expect(retryCoordinateCalls).toBe(1);
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        state: 'settled',
        generation: 2,
        terminal: passedTerminal,
      });
    } finally {
      releaseFreshRetry?.();
      temp.remove();
    }
  });

  test('keeps the canonical handoff available while a retry claim is interleaved', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let contender: Promise<unknown> | undefined;
    let attemptedWorkers = 0;
    let clock = 0;
    let releaseRetryWait: (() => void) | undefined;
    try {
      const initial = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(initial.directory, {
        state: 'settled',
        terminal: { status: 'rejected', exitCode: null, passed: false },
      });
      const winner = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
        retryHooks: {
          afterRetryClaim: () => {
            contender = submitVerification({
              laneId: 'full-regression',
              cwd: temp.worktree,
              root: temp.root,
              collectProvenance: () => before,
              readinessTimeoutMs: 100,
              identityProbe: () => ({
                bootId: 'boot',
                process: { pid: 4321, token: 'birth' },
              }),
              now: () => clock,
              wait: () =>
                new Promise<void>((resolveWait) => {
                  releaseRetryWait = resolveWait;
                }),
              spawnWorker: () => {
                attemptedWorkers += 1;
                throw new Error('interleaved contender must join the winner');
              },
            });
          },
        },
      });
      expect(winner).toMatchObject({
        acquired: true,
        handoff: { generation: 2 },
      });
      __verificationSubmissionInternals.coordinateReadyWorker(
        winner.directory,
        {
          pid: 4321,
          nonce: 'winner',
          launchToken: winner.handoff.launchToken,
          identity: { bootId: 'boot', process: { token: 'birth' } },
        },
      );
      expect(releaseRetryWait).toBeTypeOf('function');
      clock = 100;
      releaseRetryWait?.();
      await expect(contender).resolves.toMatchObject({
        status: 'accepted',
        disposition: 'joined',
      });
      expect(attemptedWorkers).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('classifies production-shaped live, dead, recycled, rebooted, and unavailable workers', () => {
    const worker = {
      pid: 42,
      identity: { bootId: 'boot', process: { token: 'linux:12345' } },
    };
    const live = createWorkerIdentityProbe({
      platform: 'linux',
      kill: () => undefined,
      readFile: (path: string) =>
        path === '/proc/sys/kernel/random/boot_id'
          ? 'boot\n'
          : `42 (worker locale )) R ${Array.from({ length: 18 }, () => '0').join(' ')} 12345`,
    });
    const dead = createWorkerIdentityProbe({
      platform: 'linux',
      readFile: () => 'boot\n',
      kill: () => {
        throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      },
    });
    const unavailable = createWorkerIdentityProbe({
      platform: 'linux',
      readFile: () => 'boot\n',
      kill: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      },
    });
    expect(classifyCoordinatingWorker(worker, live)).toBe('live');
    expect(dead(42)).toEqual({ bootId: 'boot', process: null });
    expect(classifyCoordinatingWorker(worker, dead)).toBe('recoverable');
    expect(unavailable(42)).toEqual({ bootId: 'boot', process: undefined });
    expect(classifyCoordinatingWorker(worker, unavailable)).toBe('ambiguous');
    const reusedPid = createWorkerIdentityProbe({
      platform: 'linux',
      kill: () => undefined,
      readFile: (path: string) =>
        path === '/proc/sys/kernel/random/boot_id'
          ? 'boot\n'
          : `42 (different locale) R ${Array.from({ length: 18 }, () => '0').join(' ')} 12346`,
    });
    expect(classifyCoordinatingWorker(worker, reusedPid)).toBe('recoverable');
    const rebootedWithUnavailableProcess = createWorkerIdentityProbe({
      platform: 'darwin',
      kill: () => undefined,
      spawn: () => ({ status: 0, stdout: 'replacement-boot\n' }),
    });
    expect(rebootedWithUnavailableProcess(42)).toEqual({
      bootId: 'replacement-boot',
      process: undefined,
    });
    expect(
      classifyCoordinatingWorker(worker, rebootedWithUnavailableProcess),
    ).toBe('recoverable');
    expect(
      classifyCoordinatingWorker(worker, () => ({
        bootId: 'boot',
        process: { pid: 42, token: 'replacement-birth' },
      })),
    ).toBe('recoverable');
    expect(
      classifyCoordinatingWorker(worker, () => ({
        bootId: 'replacement-boot',
        process: null,
      })),
    ).toBe('recoverable');
    expect(classifyCoordinatingWorker(worker, () => null)).toBe('ambiguous');
    expect(
      classifyCoordinatingWorker(worker, () => {
        throw new Error('probe unavailable');
      }),
    ).toBe('ambiguous');
    expect(
      createWorkerIdentityProbe({
        platform: 'win32',
        kill: () => {
          throw new Error('Windows probing must remain unavailable');
        },
      })(42),
    ).toBe(null);
  });

  test('caches the bounded boot probe when its process identity is unavailable', () => {
    let bootReads = 0;
    const timeouts: number[] = [];
    const probe = createWorkerIdentityProbe({
      platform: 'darwin',
      spawn: (
        command: string,
        _args: string[],
        options: { timeout: number },
      ) => {
        timeouts.push(options.timeout);
        expect(command).toBe('sysctl');
        bootReads += 1;
        return { status: null, stdout: '', error: { code: 'ETIMEDOUT' } };
      },
      kill: () => undefined,
    });
    expect(probe(42)).toBe(null);
    expect(probe(43)).toBe(null);
    expect(bootReads).toBe(1);
    expect(timeouts).toEqual([250]);
  });

  test('classifies a Darwin launch-token command match, mismatch, and timeout', () => {
    const launchToken = 'a'.repeat(32);
    const worker = {
      pid: 42,
      launchToken,
      identity: {
        bootId: 'mac-boot',
        process: { token: `launch:${launchToken}` },
      },
    };
    const macProbe = (command: string) =>
      createWorkerIdentityProbe({
        platform: 'darwin',
        kill: () => undefined,
        spawn: (binary: string) =>
          binary === 'sysctl'
            ? { status: 0, stdout: 'mac-boot\n' }
            : { status: 0, stdout: command },
      });
    expect(
      classifyCoordinatingWorker(
        worker,
        macProbe(
          `/usr/local/bin/node worker --verification-launch-token=${launchToken}`,
        ),
      ),
    ).toBe('live');
    expect(
      classifyCoordinatingWorker(
        worker,
        macProbe(
          `/usr/local/bin/node worker --verification-launch-token=${'b'.repeat(32)}`,
        ),
      ),
    ).toBe('recoverable');
    expect(
      classifyCoordinatingWorker(
        worker,
        macProbe(
          `/usr/local/bin/node --verification-launch-token=${launchToken} --verification-launch-token=${launchToken}`,
        ),
      ),
    ).toBe('recoverable');
    const timeouts: number[] = [];
    const timedOut = createWorkerIdentityProbe({
      platform: 'darwin',
      kill: () => undefined,
      spawn: (
        binary: string,
        _args: string[],
        options: { timeout: number },
      ) => {
        timeouts.push(options.timeout);
        return binary === 'sysctl'
          ? { status: 0, stdout: 'mac-boot\n' }
          : { status: null, stdout: '', error: { code: 'ETIMEDOUT' } };
      },
    });
    expect(classifyCoordinatingWorker(worker, timedOut)).toBe('ambiguous');
    expect(timeouts).toEqual([250, 250]);
  });

  test('joins a launch-token-bound Darwin worker without spawning a contender', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    const launchToken = 'c'.repeat(32);
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(acquired.directory, {
        state: 'coordinating',
        launchToken,
        worker: {
          pid: 42,
          nonce: 'mac-worker',
          launchToken,
          identity: {
            bootId: 'mac-boot',
            process: { token: `launch:${launchToken}` },
          },
        },
      });
      const macProbe = createWorkerIdentityProbe({
        platform: 'darwin',
        kill: () => undefined,
        spawn: (binary: string) =>
          binary === 'sysctl'
            ? { status: 0, stdout: 'mac-boot\n' }
            : {
                status: 0,
                stdout: `/usr/local/bin/node --verification-launch-token=${launchToken}`,
              },
      });
      await expect(
        submitVerification({
          laneId: 'full-regression',
          cwd: temp.worktree,
          root: temp.root,
          collectProvenance: () => before,
          identityProbe: macProbe,
          spawnWorker: () => {
            throw new Error('live Mac worker must be joined');
          },
        }),
      ).resolves.toMatchObject({ status: 'accepted', disposition: 'joined' });
    } finally {
      temp.remove();
    }
  });

  test('joins a Darwin worker when its probe command derives from the spawned argv', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const child = Object.assign(new EventEmitter(), {
      pid: 4322,
      unref: () => undefined,
      disconnect: () => undefined,
      send: (_message: unknown, callback: (error?: Error) => void) =>
        callback(),
    });
    let workerCommand = '';
    try {
      const first = await submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => before,
        spawnWorker: (_command: string, args: string[]) => {
          const invocation =
            __verificationSubmissionInternals.parseWorkerInvocation(
              args.slice(1),
            );
          expect(invocation).not.toBe(null);
          workerCommand = `/usr/local/bin/node ${args.join(' ')}`;
          queueMicrotask(() => {
            child.emit('message', {
              type: 'verification-submission-ready',
              worker: {
                pid: child.pid,
                nonce: 'darwin-worker',
                launchToken: invocation?.launchToken,
                identity: {
                  bootId: 'mac-boot',
                  process: { token: `launch:${invocation?.launchToken}` },
                },
              },
            });
          });
          return child;
        },
      });
      const macProbe = createWorkerIdentityProbe({
        platform: 'darwin',
        kill: () => undefined,
        spawn: (binary: string) =>
          binary === 'sysctl'
            ? { status: 0, stdout: 'mac-boot\n' }
            : { status: 0, stdout: workerCommand },
      });
      const second = await submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => before,
        identityProbe: macProbe,
        spawnWorker: () => {
          throw new Error('Darwin live worker must be joined');
        },
      });
      expect(first).toMatchObject({
        status: 'accepted',
        disposition: 'submitted',
      });
      expect(second).toMatchObject({
        status: 'accepted',
        disposition: 'joined',
      });
    } finally {
      temp.remove();
    }
  });

  test('rejects missing and mismatched worker launch tokens without exposing them', async () => {
    const temp = fixture();
    const request = createVerificationRequest(
      'full-regression',
      provenance(temp.worktree),
    );
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      expect(() =>
        __verificationSubmissionInternals.coordinateReadyWorker(
          acquired.directory,
          { pid: 42, nonce: 'missing' },
        ),
      ).toThrow('launch token did not match');
      const mismatch = 'd'.repeat(32);
      expect(() =>
        __verificationSubmissionInternals.coordinateReadyWorker(
          acquired.directory,
          { pid: 42, nonce: 'mismatch', launchToken: mismatch },
        ),
      ).toThrow('launch token did not match');
      const outcome = await runSubmittedVerification({
        directory: acquired.directory,
        launchToken: mismatch,
        cwd: temp.worktree,
        collectProvenance: () => provenance(temp.worktree),
        send: () => undefined,
      });
      expect(outcome).toMatchObject({ state: 'failed_to_start' });
      expect(JSON.stringify(outcome)).not.toContain(mismatch);
      expect(
        JSON.stringify(
          verificationSubmissionStatus({
            root: temp.root,
            requestKey: request.key,
          }),
        ),
      ).not.toContain(mismatch);
      const darwinRequest = createVerificationRequest(
        'full-regression',
        provenance(temp.worktree, 'darwin'),
      );
      const darwin = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request: darwinRequest,
      });
      const darwinOutcome = await runSubmittedVerification({
        directory: darwin.directory,
        launchToken: darwin.handoff.launchToken,
        cwd: temp.worktree,
        collectProvenance: () => provenance(temp.worktree, 'darwin'),
        platform: 'darwin',
        workerIdentityFn: () => ({
          bootId: 'mac-boot',
          process: { token: 'launch:mismatch' },
        }),
        send: () => undefined,
      });
      expect(darwinOutcome).toMatchObject({ state: 'failed_to_start' });
      expect(JSON.stringify(darwinOutcome)).not.toContain(
        darwin.handoff.launchToken,
      );
    } finally {
      temp.remove();
    }
  });

  test('parses only a complete worker launch-token invocation', () => {
    const launchToken = 'e'.repeat(32);
    expect(
      __verificationSubmissionInternals.parseWorkerInvocation([
        '--worker',
        '/tmp/handoff',
        '--verification-launch-token=not-a-token',
      ]),
    ).toBe(null);
    expect(
      __verificationSubmissionInternals.parseWorkerInvocation([
        '--worker',
        '/tmp/handoff',
        '--launch-token',
        'not-a-token',
      ]),
    ).toBe(null);
    expect(
      __verificationSubmissionInternals.parseWorkerInvocation([
        '--worker',
        '/tmp/handoff',
        `--verification-launch-token=${launchToken}`,
      ]),
    ).toEqual({ directory: '/tmp/handoff', launchToken });
    expect(
      __verificationSubmissionInternals.parseWorkerInvocation([
        '--worker',
        '/tmp/handoff',
        `--verification-launch-token=${launchToken}`,
        '--unexpected',
      ]),
    ).toBe(null);
  });

  test('recovers a rebooted coordinating handoff once and fences its old worker', () => {
    const temp = fixture();
    const request = createVerificationRequest(
      'full-regression',
      provenance(temp.worktree),
    );
    let canonicalWasPresent = false;
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.coordinateReadyWorker(
        acquired.directory,
        {
          pid: 42,
          nonce: 'old',
          launchToken: acquired.handoff.launchToken,
          identity: { bootId: 'old-boot', process: { token: 'old-birth' } },
        },
      );
      const recovered =
        __verificationSubmissionInternals.recoverCoordinatingHandoff({
          directory: acquired.directory,
          request,
          identityProbe: () => ({
            bootId: 'new-boot',
            process: { pid: 42, token: 'old-birth' },
          }),
          recoveryHooks: {
            beforeRecoveryPublication: () => {
              canonicalWasPresent =
                readFileSync(join(acquired.directory, 'handoff.json'), 'utf8')
                  .length > 0;
            },
          },
        });
      expect(recovered).toMatchObject({
        acquired: true,
        recovered: true,
        handoff: { generation: 2, state: 'launching' },
      });
      expect(canonicalWasPresent).toBe(true);
      expect(
        __verificationSubmissionInternals.recoverCoordinatingHandoff({
          directory: acquired.directory,
          request,
          identityProbe: () => null,
        }),
      ).toMatchObject({ unavailable: true });
      expect(() =>
        __verificationSubmissionInternals.updateCoordinatingWorkerHandoff({
          directory: acquired.directory,
          workerGeneration: 1,
          workerNonce: 'old',
          update: { state: 'settled' },
        }),
      ).toThrow('no longer owns the handoff');
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({ generation: 2, state: 'launching' });
      __verificationSubmissionInternals.coordinateReadyWorker(
        acquired.directory,
        {
          pid: 43,
          nonce: 'old',
          launchToken: recovered.handoff.launchToken,
          identity: { bootId: 'new-boot', process: { token: 'new-birth' } },
        },
      );
      expect(() =>
        __verificationSubmissionInternals.updateCoordinatingWorkerHandoff({
          directory: acquired.directory,
          workerGeneration: 1,
          workerNonce: 'old',
          update: { state: 'settled' },
        }),
      ).toThrow('no longer owns the handoff');
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        generation: 2,
        state: 'coordinating',
        worker: { nonce: 'old' },
      });
      expect(
        readdirSync(join(temp.root, 'submissions')).filter((entry) =>
          entry.includes('.recovery-'),
        ),
      ).toEqual([]);
    } finally {
      temp.remove();
    }
  });

  test('lets one explicit submit recover a dead coordinator while a contender joins', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    const child = Object.assign(new EventEmitter(), {
      pid: 4322,
      unref: () => undefined,
      disconnect: () => undefined,
      send: (_message: unknown, callback: (error?: Error) => void) =>
        callback(),
    });
    let spawns = 0;
    let contender: Promise<unknown> | undefined;
    const submit = () =>
      submitVerification({
        laneId: 'full-regression',
        cwd: temp.worktree,
        root: temp.root,
        collectProvenance: () => before,
        identityProbe: () => ({ bootId: 'new-boot', process: null }),
        recoveryHooks: {
          beforeRecoveryPublication: () => {
            contender = submitVerification({
              laneId: 'full-regression',
              cwd: temp.worktree,
              root: temp.root,
              collectProvenance: () => before,
              identityProbe: () => ({
                bootId: 'new-boot',
                process: { pid: child.pid, token: 'replacement-birth' },
              }),
              spawnWorker: () => {
                throw new Error('contender must join the recovering submit');
              },
            });
          },
        },
        spawnWorker: (_command: string, args: string[]) => {
          spawns += 1;
          queueMicrotask(() => {
            child.emit('message', {
              type: 'verification-submission-ready',
              worker: {
                pid: child.pid,
                nonce: 'replacement',
                launchToken: args
                  .at(-1)
                  ?.slice('--verification-launch-token='.length),
                identity: {
                  bootId: 'new-boot',
                  process: { token: 'replacement-birth' },
                },
              },
            });
          });
          return child;
        },
      });
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.coordinateReadyWorker(
        acquired.directory,
        {
          pid: 42,
          nonce: 'old',
          launchToken: acquired.handoff.launchToken,
          identity: { bootId: 'old-boot', process: { token: 'old-birth' } },
        },
      );

      await expect(submit()).resolves.toMatchObject({
        status: 'accepted',
        disposition: 'submitted',
      });
      await expect(contender).resolves.toMatchObject({
        status: 'accepted',
        disposition: 'joined',
      });
      expect(spawns).toBe(1);
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        generation: 2,
        state: 'coordinating',
        worker: { nonce: 'replacement' },
      });
    } finally {
      temp.remove();
    }
  });

  test('fails closed for unavailable coordinating worker identity', () => {
    const temp = fixture();
    const request = createVerificationRequest(
      'full-regression',
      provenance(temp.worktree),
    );
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.coordinateReadyWorker(
        acquired.directory,
        {
          pid: 42,
          nonce: 'old',
          launchToken: acquired.handoff.launchToken,
          identity: { bootId: 'boot', process: { token: 'birth' } },
        },
      );
      expect(
        __verificationSubmissionInternals.recoverCoordinatingHandoff({
          directory: acquired.directory,
          request,
          identityProbe: () => null,
        }),
      ).toMatchObject({ unavailable: true });
      expect(
        verificationSubmissionStatus({
          root: temp.root,
          requestKey: request.key,
          identityProbe: () => null,
        }).submissions,
      ).toEqual([
        expect.objectContaining({
          state: 'coordinating',
          recovery: 'identity_unavailable',
        }),
      ]);
    } finally {
      temp.remove();
    }
  });

  test('reclaims a dead retry claim and advances the rejected generation', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      const initial = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(initial.directory, {
        state: 'settled',
        terminal: { status: 'rejected', exitCode: null, passed: false },
      });
      const claim = __verificationSubmissionInternals.retryClaimDirectory(
        initial.directory,
      );
      mkdirSync(claim);
      writeFileSync(
        join(claim, 'lease.json'),
        JSON.stringify({
          owner: { pid: 999_999_999, processStart: null, nonce: 'dead' },
          createdAt: Date.now(),
        }),
      );
      expect(
        __verificationSubmissionInternals.acquireHandoff({
          root: temp.root,
          request,
        }),
      ).toMatchObject({ acquired: true, handoff: { generation: 2 } });
    } finally {
      temp.remove();
    }
  });

  test('publishes at most one retry claim when a contender arrives before publication', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let contender: unknown;
    try {
      const initial = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(initial.directory, {
        state: 'settled',
        terminal: { status: 'rejected', exitCode: null, passed: false },
      });
      const first = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
        retryHooks: {
          afterRetryClaimStaged: () => {
            contender = __verificationSubmissionInternals.acquireHandoff({
              root: temp.root,
              request,
            });
          },
        },
      });
      expect(contender).toMatchObject({
        acquired: true,
        handoff: { generation: 2 },
      });
      expect(first).toMatchObject({ acquired: false });
      expect(
        __verificationSubmissionInternals.readHandoff(initial.directory),
      ).toMatchObject({ state: 'launching', generation: 2 });
    } finally {
      temp.remove();
    }
  });

  test('does not delete a successor while reclaiming a dead retry claim', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    try {
      const initial = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.updateHandoff(initial.directory, {
        state: 'settled',
        terminal: { status: 'rejected', exitCode: null, passed: false },
      });
      const claim = __verificationSubmissionInternals.retryClaimDirectory(
        initial.directory,
      );
      mkdirSync(claim);
      writeFileSync(
        join(claim, 'lease.json'),
        JSON.stringify({
          owner: { pid: 999_999_999, processStart: null, nonce: 'dead' },
          createdAt: Date.now(),
        }),
      );
      const result = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
        retryHooks: {
          beforeRetryClaimQuarantine: ({ claimDirectory }) => {
            const replaced = `${claimDirectory}.replacement`;
            renameSync(claimDirectory, replaced);
            mkdirSync(claimDirectory);
            writeFileSync(
              join(claimDirectory, 'lease.json'),
              JSON.stringify({
                owner: {
                  pid: process.pid,
                  processStart: null,
                  nonce: 'successor',
                },
                createdAt: Date.now(),
              }),
            );
            rmSync(replaced, { recursive: true, force: true });
          },
        },
      });
      expect(result).toMatchObject({ acquired: false, retrying: true });
      expect(
        JSON.parse(readFileSync(join(claim, 'lease.json'), 'utf8')),
      ).toMatchObject({ owner: { nonce: 'successor' } });
    } finally {
      temp.remove();
    }
  });

  test('does not let a late worker revive a parent readiness timeout', async () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    let coordinateCalls = 0;
    let releaseAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolveAcknowledgement) => {
      releaseAcknowledgement = resolveAcknowledgement;
    });
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      const worker = runSubmittedVerification({
        directory: acquired.directory,
        launchToken: acquired.handoff.launchToken,
        platform: 'linux',
        cwd: temp.worktree,
        collectProvenance: () => before,
        awaitAcknowledgement: () => acknowledgement,
        coordinate: async () => {
          coordinateCalls += 1;
          return { disposition: 'executed' };
        },
        send: () => undefined,
      });

      await new Promise((resolveWait) => setImmediate(resolveWait));
      __verificationSubmissionInternals.failHandoff(
        acquired.directory,
        new Error('parent readiness timeout'),
      );
      releaseAcknowledgement();

      await expect(worker).resolves.toMatchObject({ state: 'failed_to_start' });
      expect(
        __verificationSubmissionInternals.readHandoff(acquired.directory),
      ).toMatchObject({
        state: 'failed_to_start',
        error: 'parent readiness timeout',
      });
      expect(coordinateCalls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('rejects traversal request keys before constructing a submit-status path', () => {
    const temp = fixture();
    try {
      expect(() =>
        verificationSubmissionStatus({
          root: temp.root,
          requestKey: '../outside',
        }),
      ).toThrow('request key must be 64 lowercase hexadecimal characters');
    } finally {
      temp.remove();
    }
  });

  test('redacts persisted and displayed handoff errors', () => {
    const temp = fixture();
    const before = provenance(temp.worktree);
    const request = createVerificationRequest('full-regression', before);
    const raw = 'Bearer super-secret-token at /Users/brian/private-token.txt';
    try {
      const acquired = __verificationSubmissionInternals.acquireHandoff({
        root: temp.root,
        request,
      });
      __verificationSubmissionInternals.failHandoff(
        acquired.directory,
        new Error(raw),
      );
      const stored = __verificationSubmissionInternals.readHandoff(
        acquired.directory,
      );
      const [status] = verificationSubmissionStatus({
        root: temp.root,
        requestKey: request.key,
      }).submissions;

      expect(stored.error).not.toContain('super-secret-token');
      expect(stored.error).not.toContain('/Users/brian');
      expect(status.error).toBe(stored.error);
    } finally {
      temp.remove();
    }
  });
});
