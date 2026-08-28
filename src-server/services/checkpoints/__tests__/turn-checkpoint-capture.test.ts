/**
 * archive#2802 — turn-boundary capture coverage.
 *
 * These tests drive the coordinator and the EventBus wiring with an in-memory
 * ref store double and a REAL CheckpointIndexStore over a temp directory, so
 * every assertion about the durable records exercises the actual persisted
 * shapes. The behavioural contract under test is the one the slice names as
 * its most important: a checkpoint-layer failure must never block, fail, or
 * outlive a turn — it must land as a typed record.
 */

import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../orchestration/event-bus.js';
import { CheckpointIndexStore } from '../checkpoint-index-store.js';
import type { CheckpointCaptureResult } from '../checkpoint-ref-store.js';
import {
  createThreadWorkingDirectoryResolver,
  TurnCheckpointCaptureCoordinator,
  wireTurnCheckpointCapture,
  wireTurnCheckpointCaptureWhenEnabled,
} from '../turn-checkpoint-capture.js';

const tempDirs: string[] = [];

function newIndexStore(): CheckpointIndexStore {
  const dir = mkdtempSync(join(tmpdir(), 'station-turn-cp-'));
  tempDirs.push(dir);
  return new CheckpointIndexStore(dir);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function capturedResult(checkpointId: string): {
  status: 'captured';
  checkpoint: {
    checkpointId: string;
    commitSha: string;
    treeSha: string;
    repoRoot: string;
    capturedAt: string;
  };
} {
  return {
    status: 'captured',
    checkpoint: {
      checkpointId,
      commitSha: `${checkpointId}-commit`,
      treeSha: `${checkpointId}-tree`,
      repoRoot: '/tmp/repo',
      capturedAt: '2026-08-15T00:00:00.000Z',
    },
  };
}

function emitTurnEvent(
  eventBus: EventBus,
  event: Record<string, unknown>,
): void {
  eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event });
}

describe('TurnCheckpointCaptureCoordinator', () => {
  it('returns before ANY capture work runs — nothing synchronous inside the emit (fix round H2)', async () => {
    const indexStore = newIndexStore();
    const capture = vi.fn(async (input: { checkpointId: string }) =>
      capturedResult(input.checkpointId),
    );
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: { capture },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
    });

    const pending = coordinator.captureForTurn(
      'thread-1',
      'turn-1',
      'baseline',
    );
    // The call above has returned; NOTHING may have run yet — not the
    // index read, not the git capture. The listener that calls us runs
    // INLINE inside a turn's event emit on the EventBus, so any
    // synchronous prefix (the pre-fix first-capture-for-a-thread path)
    // put whole-file JSON I/O inside the emit itself.
    expect(capture).not.toHaveBeenCalled();
    expect(indexStore.readTurn('thread-1', 'turn-1')).toBeUndefined();
    await pending;
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('captures a baseline and a settle for a turn and records both', async () => {
    const indexStore = newIndexStore();
    const captures: Array<{ threadId: string; kind: string; turnId: string }> =
      [];
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (input) => {
          captures.push({
            threadId: input.threadId,
            kind: input.kind,
            turnId: input.turnId,
          });
          return capturedResult(input.checkpointId);
        },
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
      newCheckpointId: () => `cp-${captures.length + 1}`,
    });

    await coordinator.captureForTurn('thread-1', 'turn-1', 'baseline');
    await coordinator.captureForTurn('thread-1', 'turn-1', 'settle');

    expect(captures.map((entry) => entry.kind)).toEqual(['baseline', 'settle']);
    // The turnId is handed to the ref store — the durable link the git
    // side records in its commit message (M6).
    expect(captures[0]?.turnId).toBe('turn-1');
    const record = indexStore.readTurn('thread-1', 'turn-1');
    expect(record?.baseline?.status).toBe('captured');
    expect(record?.settle?.status).toBe('captured');
    if (record?.baseline?.status === 'captured') {
      expect(record.baseline.commitSha).toBe('cp-1-commit');
    }
  });

  it('records not_applicable — distinguishable from captured and from never observed', async () => {
    const indexStore = newIndexStore();
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (input) => capturedResult(input.checkpointId),
      },
      indexStore,
      resolveWorkingDirectory: () => undefined,
      logger: { debug: () => {}, warn: () => {} },
    });

    await coordinator.captureForTurn('thread-1', 'turn-no-dir', 'baseline');

    // never-observed turn: no record AT ALL
    expect(indexStore.readTurn('thread-1', 'turn-never-seen')).toBeUndefined();
    // no-directory turn: a typed not_applicable record, not an absence
    const record = indexStore.readTurn('thread-1', 'turn-no-dir');
    expect(record?.baseline).toEqual({
      status: 'not_applicable',
      reason: 'no_project_working_directory',
      recordedAt: expect.any(String),
    });

    // And a captured turn on another thread is a third, distinct shape.
    const withDir = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (input) => capturedResult(input.checkpointId),
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
    });
    await withDir.captureForTurn('thread-2', 'turn-2', 'baseline');
    const capturedRecord = indexStore.readTurn('thread-2', 'turn-2');
    expect(capturedRecord?.baseline?.status).toBe('captured');
    expect(capturedRecord?.baseline?.status).not.toBe(record?.baseline?.status);
  });

  it('folds a throwing ref store into a failed record and never rejects', async () => {
    const indexStore = newIndexStore();
    const warn = vi.fn();
    let callCount = 0;
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async () => {
          callCount += 1;
          throw new Error('git exploded');
        },
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn },
    });

    // THE slice-2 contract: resolves (does not reject) despite the throw.
    await expect(
      coordinator.captureForTurn('thread-1', 'turn-1', 'baseline'),
    ).resolves.toBeUndefined();

    const record = indexStore.readTurn('thread-1', 'turn-1');
    expect(record?.baseline?.status).toBe('failed');
    if (record?.baseline?.status === 'failed') {
      expect(record.baseline.error).toContain('git exploded');
    }
    expect(warn).toHaveBeenCalled();

    // The coordinator keeps working for later turns.
    await coordinator.captureForTurn('thread-1', 'turn-2', 'baseline');
    expect(callCount).toBe(2);
    expect(indexStore.readTurn('thread-1', 'turn-2')?.baseline?.status).toBe(
      'failed',
    );
  });

  it('never rejects and never wedges when the INDEX write itself throws (fix round M4)', async () => {
    // The full-disk shape: every recordTurnPhase throws (ENOSPC). The
    // pre-fix code called recordTurnPhase outside any try/catch — a throw
    // escaped captureOnce, rejected the raw chain handed to the caller,
    // and left the thread with ZERO records ("never observed") while
    // poisoning nothing else only by luck of the tail's catch.
    const warn = vi.fn();
    const throwingIndexStore = {
      readTurn: () => undefined,
      recordTurnPhase: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      listThread: () => [],
    } as unknown as CheckpointIndexStore;
    let captureCalls = 0;
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (input) => {
          captureCalls += 1;
          return capturedResult(input.checkpointId);
        },
      },
      indexStore: throwingIndexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn },
    });

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        coordinator.captureForTurn('thread-1', 'turn-1', 'baseline'),
      ).resolves.toBeUndefined();
      // Not_applicable branches (unbound chats) hit the same throwing
      // write through a different path.
      const unbound = new TurnCheckpointCaptureCoordinator({
        refStore: {
          capture: async (input) => capturedResult(input.checkpointId),
        },
        indexStore: throwingIndexStore,
        resolveWorkingDirectory: () => undefined,
        logger: { debug: () => {}, warn: warn },
      });
      await expect(
        unbound.captureForTurn('thread-1', 'turn-2', 'baseline'),
      ).resolves.toBeUndefined();

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'turn-checkpoint: index record write threw',
        expect.objectContaining({ threadId: 'thread-1', turnId: 'turn-1' }),
      );
      // The thread is not wedged: a later boundary still reaches the ref
      // store (capture attempted again, record best-effort again).
      await coordinator.captureForTurn('thread-1', 'turn-3', 'settle');
      expect(captureCalls).toBe(2);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('records typed skips for degraded repository states', async () => {
    const indexStore = newIndexStore();
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (): Promise<CheckpointCaptureResult> => ({
          status: 'degraded',
          reason: 'unborn_head',
        }),
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
    });
    await coordinator.captureForTurn('thread-1', 'turn-1', 'settle');
    const record = indexStore.readTurn('thread-1', 'turn-1');
    expect(record?.settle).toEqual({
      status: 'skipped',
      reason: 'unborn_head',
      recordedAt: expect.any(String),
    });
  });

  it('treats a replayed boundary as a duplicate instead of capturing twice', async () => {
    const indexStore = newIndexStore();
    const capture = vi.fn(async (input: { checkpointId: string }) =>
      capturedResult(input.checkpointId),
    );
    const outcomes: string[] = [];
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: { capture },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
      onOutcome: (outcome) => outcomes.push(outcome.outcome),
    });

    await coordinator.captureForTurn('thread-1', 'turn-1', 'settle');
    await coordinator.captureForTurn('thread-1', 'turn-1', 'settle');

    expect(capture).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['captured', 'duplicate']);
  });

  it('serializes captures within one thread so turns cannot race', async () => {
    const indexStore = newIndexStore();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async (input) => {
          events.push(`start:${input.kind}`);
          if (input.kind === 'baseline') {
            await new Promise<void>((resolveRelease) => {
              release = resolveRelease;
            });
          }
          events.push(`end:${input.kind}`);
          return capturedResult(input.checkpointId);
        },
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
    });

    const baseline = coordinator.captureForTurn(
      'thread-1',
      'turn-1',
      'baseline',
    );
    // Let the baseline start and park on its deferred release.
    await new Promise((resolve) => setImmediate(resolve));
    const settle = coordinator.captureForTurn('thread-1', 'turn-2', 'settle');
    await new Promise((resolve) => setImmediate(resolve));

    // The settle has NOT started while the thread's baseline is in flight.
    expect(events).toEqual(['start:baseline']);
    release?.();
    await Promise.all([baseline, settle]);
    expect(events).toEqual([
      'start:baseline',
      'end:baseline',
      'start:settle',
      'end:settle',
    ]);
  });
});

describe('wireTurnCheckpointCapture', () => {
  it('stays dormant unless the workspaceCheckpoints setting is explicitly true (fix round H3)', async () => {
    const coordinator = {
      captureForTurn: vi.fn(async () => {}),
    } as unknown as TurnCheckpointCaptureCoordinator;
    const eventBus = new EventBus();
    const unsubscribe = wireTurnCheckpointCaptureWhenEnabled(undefined, {
      eventBus,
      coordinator,
      logger: { warn: () => {} },
    });
    expect(typeof unsubscribe).toBe('function');

    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    emitTurnEvent(eventBus, {
      method: 'turn.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Absent config, `false`, and every non-true value all mean OFF: no
    // subscription was registered, no git call, no index write, no .git
    // growth. The setting defaults to off, so a stock Station never
    // captures unless its owner flipped it.
    expect(coordinator.captureForTurn).not.toHaveBeenCalled();
    unsubscribe();

    // `true` (and only true) arms the listener.
    const armed = wireTurnCheckpointCaptureWhenEnabled(
      { workspaceCheckpoints: true },
      {
        eventBus,
        coordinator,
        logger: { warn: () => {} },
      },
    );
    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-2',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-2',
      'baseline',
    );
    armed();

    // `false` is explicitly off, not "defaults to on".
    const refused = wireTurnCheckpointCaptureWhenEnabled(
      { workspaceCheckpoints: false },
      {
        eventBus,
        coordinator,
        logger: { warn: () => {} },
      },
    );
    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-3',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.captureForTurn).toHaveBeenCalledTimes(1);
    refused();
  });

  it('dispatches baseline on turn.started and settle on turn.completed/aborted, synchronously', async () => {
    const coordinator = {
      captureForTurn: vi.fn(async () => {}),
    } as unknown as TurnCheckpointCaptureCoordinator;
    const eventBus = new EventBus();
    wireTurnCheckpointCapture(eventBus, coordinator, { warn: () => {} });

    // The emit itself must complete without awaiting anything — capture
    // dispatch is fire-and-forget by contract.
    expect(() => {
      emitTurnEvent(eventBus, {
        method: 'turn.started',
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      emitTurnEvent(eventBus, {
        method: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      emitTurnEvent(eventBus, {
        method: 'turn.aborted',
        threadId: 'thread-1',
        turnId: 'turn-2',
      });
    }).not.toThrow();

    expect(coordinator.captureForTurn).toHaveBeenCalledTimes(3);
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'baseline',
    );
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'settle',
    );
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-2',
      'settle',
    );
  });

  // archive#3451 finding 5: a turn that ends only in `runtime.error` never
  // reached the settle arm — its baseline checkpoint was captured on
  // `turn.started` but no settle snapshot ever followed.
  it('captures settle on a genuine (non-deferred) runtime.error', async () => {
    const coordinator = {
      captureForTurn: vi.fn(async () => {}),
    } as unknown as TurnCheckpointCaptureCoordinator;
    const eventBus = new EventBus();
    wireTurnCheckpointCapture(eventBus, coordinator, { warn: () => {} });

    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    emitTurnEvent(eventBus, {
      method: 'runtime.error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      provider: 'codex',
      retriable: false,
    });

    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'baseline',
    );
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'settle',
    );
  });

  // A codex deferred-retriable runtime.error is not a terminal outcome yet —
  // no settle capture until a real terminal event arrives.
  it('does not capture settle on a codex deferred-retriable runtime.error', async () => {
    const coordinator = {
      captureForTurn: vi.fn(async () => {}),
    } as unknown as TurnCheckpointCaptureCoordinator;
    const eventBus = new EventBus();
    wireTurnCheckpointCapture(eventBus, coordinator, { warn: () => {} });

    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    emitTurnEvent(eventBus, {
      method: 'runtime.error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      provider: 'codex',
      retriable: true,
    });

    expect(coordinator.captureForTurn).toHaveBeenCalledTimes(1);
    expect(coordinator.captureForTurn).toHaveBeenCalledWith(
      'thread-1',
      'turn-1',
      'baseline',
    );
  });

  it('ignores steer input, non-turn events, and events without turn ids', async () => {
    const coordinator = {
      captureForTurn: vi.fn(async () => {}),
    } as unknown as TurnCheckpointCaptureCoordinator;
    const eventBus = new EventBus();
    wireTurnCheckpointCapture(eventBus, coordinator, { warn: () => {} });

    emitTurnEvent(eventBus, {
      method: 'turn.started',
      threadId: 't',
      turnId: 'turn-1',
      inputKind: 'steer',
    });
    emitTurnEvent(eventBus, { method: 'content.text-delta', threadId: 't' });
    emitTurnEvent(eventBus, { method: 'turn.completed', threadId: 't' });
    emitTurnEvent(eventBus, { method: 'session.started', turnId: 'x' });
    eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { notAnEvent: true });
    eventBus.emit('some-other-event' as never, {});

    expect(coordinator.captureForTurn).not.toHaveBeenCalled();
  });

  it('keeps the subscription alive and completes the turn when captures throw', async () => {
    const indexStore = newIndexStore();
    const coordinator = new TurnCheckpointCaptureCoordinator({
      refStore: {
        capture: async () => {
          throw new Error('checkpoint layer broken');
        },
      },
      indexStore,
      resolveWorkingDirectory: () => '/tmp/repo',
      logger: { debug: () => {}, warn: () => {} },
    });
    const eventBus = new EventBus();
    const warn = vi.fn();
    wireTurnCheckpointCapture(eventBus, coordinator, { warn });

    // A full turn lifecycle with a broken checkpoint layer: the emits
    // complete (this is the turn completing), nothing throws, and no
    // unhandled rejection escapes.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => {
        emitTurnEvent(eventBus, {
          method: 'turn.started',
          threadId: 't',
          turnId: 'turn-1',
        });
        emitTurnEvent(eventBus, {
          method: 'turn.completed',
          threadId: 't',
          turnId: 'turn-1',
        });
      }).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
      const record = indexStore.readTurn('t', 'turn-1');
      expect(record?.baseline?.status).toBe('failed');
      expect(record?.settle?.status).toBe('failed');

      // The subscription survived: a later good capture still lands.
      const goodCoordinator = new TurnCheckpointCaptureCoordinator({
        refStore: {
          capture: async (input) => capturedResult(input.checkpointId),
        },
        indexStore,
        resolveWorkingDirectory: () => '/tmp/repo',
        logger: { debug: () => {}, warn: () => {} },
      });
      // Re-wire the good coordinator on the same bus to prove the bus
      // itself is healthy; the original listener's throws were swallowed.
      wireTurnCheckpointCapture(eventBus, goodCoordinator, { warn });
      emitTurnEvent(eventBus, {
        method: 'turn.started',
        threadId: 't',
        turnId: 'turn-2',
      });
      await goodCoordinator.captureForTurn('t', 'turn-3', 'baseline');
      expect(indexStore.readTurn('t', 'turn-3')?.baseline?.status).toBe(
        'captured',
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('createThreadWorkingDirectoryResolver', () => {
  it('resolves a bound project\u2019s working directory, tilde-expanded', () => {
    const resolver = createThreadWorkingDirectoryResolver(
      { resolveSessionProjectSlug: () => 'my-project' },
      () => [{ slug: 'my-project', workingDirectory: '~/dev/repo' }],
    );
    expect(resolver('thread-1')).toBe(resolve(homedir(), 'dev/repo'));
  });

  it('returns undefined for unbound sessions, directory-less projects, and broken reads', () => {
    const resolver = createThreadWorkingDirectoryResolver(
      { resolveSessionProjectSlug: () => undefined },
      () => [],
    );
    expect(resolver('thread-1')).toBeUndefined();

    const directoryLess = createThreadWorkingDirectoryResolver(
      { resolveSessionProjectSlug: () => 'default' },
      () => [{ slug: 'default' }],
    );
    expect(directoryLess('thread-1')).toBeUndefined();

    const throwing = createThreadWorkingDirectoryResolver(
      {
        resolveSessionProjectSlug: () => {
          throw new Error('store unavailable');
        },
      },
      () => [],
    );
    expect(throwing('thread-1')).toBeUndefined();
  });
});
