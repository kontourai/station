import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EventStore, type PersistedRuntimeEvent } from '../event-store.js';

describe('EventStore high-cardinality batched projection', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-batched-projection-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedProjectionThread(threadId: string): void {
    const base = '2026-08-20T00:00:00.000Z';
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: base,
      updatedAt: base,
    });
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'claude', userId: 'owner-user' },
    });
    store.appendEvent({
      eventId: `${threadId}-configured`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.configured',
      sessionId: threadId,
      model: 'claude-sonnet-4-5',
    });
    store.appendEvent({
      eventId: `${threadId}-flow-attached`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'flow.run-attached',
      runId: `run-${threadId}`,
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn1-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.started',
      prompt: `prompt for ${threadId}`,
    });
    store.appendEvent({
      eventId: `${threadId}-turn1-completed`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.completed',
      finishReason: 'stop',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-request-opened`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'request.opened',
      requestId: `${threadId}-req-1`,
      kind: 'approval',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn2-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: base,
      method: 'turn.started',
      prompt: `follow-up for ${threadId}`,
    });
  }

  function withoutObservedAt(
    events: readonly PersistedRuntimeEvent[],
  ): unknown[] {
    return events.map(({ observedAt: _observedAt, ...rest }) => rest);
  }

  function expectBatchedMatchesIndividual(threadId: string): void {
    const individual = store.listSessionProjectionEvents(threadId);
    const batched = store
      .listSessionProjectionEventsForThreads([threadId])
      .get(threadId);
    expect(withoutObservedAt(batched ?? [])).toEqual(
      withoutObservedAt(individual),
    );
  }

  // archive#4466 review remediation: id/thread/pair lists are chunked at 500.
  // The complete seed, batched read, and comparisons retain the original 10s
  // product-law bound; isolation moves no setup into a wider hook allowance.
  test('a population crossing the 500-id chunk boundary is folded completely and correctly', async () => {
    const startedAt = performance.now();
    let phase = 'profiler';
    const trace = (
      event: string,
      details: Record<string, string | number> = {},
    ): void => {
      writeSync(
        1,
        `@@LARGE_PROJECTION_DIAGNOSTIC@@${JSON.stringify({
          phase,
          event,
          elapsedMs: performance.now() - startedAt,
          ...details,
        })}@@END_LARGE_PROJECTION_DIAGNOSTIC@@\n`,
      );
    };
    const profiler = new Session();
    const hostTmp = process.env.STATION_VITEST_HOST_TMPDIR;
    const declaredRunRoot = process.env.STATION_VITEST_RUN_ROOT;
    if (
      !hostTmp ||
      !declaredRunRoot ||
      !isAbsolute(hostTmp) ||
      !isAbsolute(declaredRunRoot) ||
      !process.getuid
    ) {
      throw new Error('Profile retention requires owned host and run roots.');
    }
    const ownerUid = process.getuid();
    const hostRoot = realpathSync(hostTmp);
    const runRoot = realpathSync(declaredRunRoot);
    const containsPath = (parent: string, child: string): boolean => {
      const suffix = relative(parent, child);
      return (
        suffix === '' ||
        (!isAbsolute(suffix) &&
          suffix !== '..' &&
          !suffix.startsWith(`..${sep}`))
      );
    };
    const hostIdentity = statSync(hostRoot);
    const runIdentity = statSync(runRoot);
    if (
      !hostIdentity.isDirectory() ||
      !runIdentity.isDirectory() ||
      hostIdentity.uid !== ownerUid ||
      runIdentity.uid !== ownerUid ||
      containsPath(runRoot, hostRoot) ||
      !containsPath(hostRoot, runRoot) ||
      realpathSync(tmpdir()) !== runRoot ||
      !containsPath(runRoot, realpathSync(dir))
    ) {
      throw new Error(
        'Profile host/run root ownership or containment mismatch.',
      );
    }
    const profileDirectory = mkdtempSync(
      join(hostRoot, 'station-large-projection-profile-'),
    );
    const directoryIdentity = lstatSync(profileDirectory);
    if (
      !directoryIdentity.isDirectory() ||
      directoryIdentity.uid !== ownerUid ||
      realpathSync(profileDirectory) !== profileDirectory ||
      !containsPath(hostRoot, profileDirectory) ||
      containsPath(runRoot, profileDirectory)
    ) {
      throw new Error(
        'Profile directory is not an owned durable host artifact.',
      );
    }
    const profilePath = join(profileDirectory, 'projection.cpuprofile');
    const retainProfile = (profileBytes: Buffer): void => {
      const currentDirectory = lstatSync(profileDirectory);
      if (
        !currentDirectory.isDirectory() ||
        currentDirectory.uid !== ownerUid ||
        currentDirectory.dev !== directoryIdentity.dev ||
        currentDirectory.ino !== directoryIdentity.ino ||
        realpathSync(profileDirectory) !== profileDirectory
      ) {
        throw new Error('Profile artifact directory identity changed.');
      }
      writeFileSync(profilePath, profileBytes, { flag: 'wx', mode: 0o600 });
      const fileIdentity = lstatSync(profilePath);
      const retainedBytes = readFileSync(profilePath);
      if (
        !fileIdentity.isFile() ||
        fileIdentity.uid !== ownerUid ||
        fileIdentity.nlink !== 1 ||
        fileIdentity.size !== profileBytes.length ||
        !retainedBytes.equals(profileBytes)
      ) {
        throw new Error('Profile artifact file ownership or bytes mismatch.');
      }
      trace('exit', {
        profilePath,
        profileBytes: retainedBytes.length,
        profileSHA256: createHash('sha256').update(retainedBytes).digest('hex'),
        fileDevice: fileIdentity.dev,
        fileInode: fileIdentity.ino,
        ownerUid: fileIdentity.uid,
      });
    };
    let profiling = false;
    try {
      trace('entry', {
        hostRoot,
        runRoot,
        profilePath,
        ownerUid,
        workerPid: process.pid,
        directoryDevice: directoryIdentity.dev,
        directoryInode: directoryIdentity.ino,
      });
      profiler.connect();
      await profiler.post('Profiler.enable');
      await profiler.post('Profiler.start');
      profiling = true;
      trace('exit');
      phase = 'seed';
      trace('entry');
      const totalThreads = 1200;
      const threadIds = Array.from(
        { length: totalThreads },
        (_, index) => `batch-equiv-chunk-${index}`,
      );
      threadIds.forEach((threadId, index) => {
        seedProjectionThread(threadId);
        if ((index + 1) % 200 === 0) {
          trace('progress', { completedSessions: index + 1 });
        }
      });
      trace('exit', { completedSessions: threadIds.length });

      phase = 'batched-read';
      trace('entry');
      const batched = store.listSessionProjectionEventsForThreads(threadIds);
      trace('exit', { resultSize: batched.size });
      expect(batched.size).toBe(totalThreads);
      phase = 'comparisons';
      trace('entry');
      for (const index of [0, 1, 250, 499, 500, 501, 750, 999, 1199]) {
        trace('sample-entry', { index });
        expectBatchedMatchesIndividual(threadIds[index]!);
        trace('sample-exit', { index });
      }
      trace('exit');
    } catch (error) {
      trace('error', {
        error: String(error).slice(0, 2000),
        stack: error instanceof Error ? (error.stack ?? '').slice(0, 4000) : '',
      });
      throw error;
    } finally {
      phase = 'profile-retention';
      trace('entry');
      try {
        if (profiling) {
          const { profile } = await profiler.post('Profiler.stop');
          retainProfile(Buffer.from(JSON.stringify(profile)));
        }
      } finally {
        profiler.disconnect();
      }
    }
  }, 10_000);
});
