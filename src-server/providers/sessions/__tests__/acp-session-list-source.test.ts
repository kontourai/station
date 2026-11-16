import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  answerFromFrame,
  type CapturedAgent,
  capturedAgent,
} from '../../../services/acp/__tests__/acp-session-list-frames.js';
import { ACPManager } from '../../../services/acp/acp-manager.js';
import { ACPProbe } from '../../../services/acp/acp-probe.js';
import type { ACPProcess } from '../../../services/acp/acp-process.js';
import { ACP_SESSION_LISTING_ENV } from '../../../services/acp/acp-session-listing.js';
import { AttachedSessionFollowService } from '../../../services/orchestration/attached-session-follow-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { AcpSessionListSource } from '../acp-session-list-source.js';

const PROBE_SESSION = 'probe-session-0001';
const makeTempDir = trackTempDirs();

/** An ACPProcess double that answers as the captured agent did. */
function capturedProcess(agent: CapturedAgent) {
  const captured = capturedAgent(agent);
  const extMethod = vi.fn(async (method: string) => {
    if (method !== 'session/list') throw new Error(`unexpected ${method}`);
    const answer = (await answerFromFrame(captured.list)) as {
      sessions: unknown[];
    };
    // The agent lists the probe's own session among the user's.
    return {
      ...answer,
      sessions: [
        { sessionId: PROBE_SESSION, cwd: '/probe/workspace' },
        ...answer.sessions,
      ],
    };
  });
  return {
    extMethod,
    process: {
      start: vi.fn().mockResolvedValue(captured.initialize),
      newSession: vi.fn().mockResolvedValue({ sessionId: PROBE_SESSION }),
      resumeSession: vi.fn().mockResolvedValue({}),
      loadSession: vi.fn().mockResolvedValue({}),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      extMethod,
      destroy: vi.fn().mockResolvedValue(undefined),
      forceGroupKill: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: vi.fn().mockResolvedValue(false),
      releaseIfConfirmedGone: vi.fn(),
    },
  };
}

describe('AcpSessionListSource', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = realpathSync.native(makeTempDir('station-acp-list-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    vi.unstubAllEnvs();
  });

  async function managerWith(
    agent: CapturedAgent,
    connection: Partial<ACPConnectionConfig> = {},
  ) {
    const double = capturedProcess(agent);
    const manager = new ACPManager(
      { warn: vi.fn(), debug: vi.fn() },
      dir,
      undefined,
      (config, logger, home) =>
        new ACPProbe(
          config,
          logger,
          home,
          () => double.process as unknown as ACPProcess,
        ),
    );
    await manager.addConnection({
      id: 'antigravity',
      name: 'Antigravity',
      command: 'agy',
      args: ['acp'],
      cwd: dir,
      enabled: true,
      ...connection,
    });
    return { manager, double };
  }

  test('follows the sessions an Antigravity probe listed as read-only threads with no transcript', async () => {
    vi.stubEnv(ACP_SESSION_LISTING_ENV, '1');
    const { manager, double } = await managerWith('antigravity-1.5.8');
    const captured = capturedAgent('antigravity-1.5.8').list!.result!
      .sessions as Array<{ sessionId: string }>;
    expect(double.extMethod).toHaveBeenCalledExactlyOnceWith(
      'session/list',
      {},
    );

    const source = new AcpSessionListSource({
      listings: () => manager.sessionListings(),
    });
    const discovery = await source.discover();
    expect(discovery.outcome).toBe('ok');
    expect(discovery.sessions.map((s) => s.sessionId)).toEqual(
      captured.map((s) => s.sessionId),
    );
    const first = discovery.sessions[0]!;
    expect(first).toMatchObject({
      provider: 'acp',
      threadId: expect.stringMatching(/^external:acp:[a-f0-9]{64}$/),
    });
    expect(first.affinity).toBeUndefined();
    expect(await source.read(first)).toEqual({
      outcome: 'ok',
      events: [],
      cursor: 0,
    });
    expect(
      await source.read({ ...first, sourceHandle: 'forged' }),
    ).toMatchObject({ outcome: 'unknown_source' });

    await new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [],
    }).pollNow();
    const followed = store
      .readSessions()
      .filter((session) => session.provider === 'acp');
    expect(followed).toHaveLength(captured.length);
    expect(
      followed.every((session) => session.controlMode === 'read-only-attached'),
    ).toBe(true);
    expect(
      store
        .listEvents(first.threadId)
        .map((event) => event.method)
        .filter((method) => !method.startsWith('session.')),
    ).toEqual([]);
    await manager.shutdown();
  });

  test('lists nothing unless opted in, and nothing for an agent that does not advertise session/list', async () => {
    const off = await managerWith('antigravity-1.5.8');
    expect(off.double.extMethod).not.toHaveBeenCalled();
    expect(off.manager.sessionListings()).toEqual([]);
    expect(
      await new AcpSessionListSource({
        listings: () => off.manager.sessionListings(),
      }).discover(),
    ).toEqual({ outcome: 'missing_root', sessions: [] });
    await off.manager.shutdown();

    vi.stubEnv(ACP_SESSION_LISTING_ENV, '1');
    const kiro = await managerWith('kiro-cli-3.3.0', {
      id: 'kiro',
      command: 'kiro-cli',
    });
    expect(kiro.double.extMethod).not.toHaveBeenCalled();
    expect(kiro.manager.sessionListings()).toEqual([]);
    await kiro.manager.shutdown();

    // A refused listing still leaves a successful probe.
    const cursor = await managerWith('cursor-agent-2026.05.01', {
      id: 'cursor',
      command: 'cursor-agent',
    });
    expect(cursor.manager.getStatus().connections[0]?.status).not.toBe(
      'unavailable',
    );
    expect(cursor.manager.sessionListings()[0]?.listing).toMatchObject({
      outcome: 'failed',
      sessions: [],
    });
    await cursor.manager.shutdown();
  });

  test('keeps out engines with their own source, disabled connections and Station-owned sessions', async () => {
    const listing = {
      observedAt: 1,
      outcome: 'ok' as const,
      rejected: 0,
      sessions: [
        {
          sessionId: 's-1',
          cwd: '/work',
          updatedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    };
    let updatedAt = '2026-10-01T12:00:00.000Z';
    const source = new AcpSessionListSource({
      enabled: () => true,
      listings: () => [
        {
          connection: { id: 'antigravity', command: 'agy', enabled: true },
          listing: {
            ...listing,
            sessions: [{ sessionId: 's-1', cwd: '/work', updatedAt }],
          },
        },
        {
          connection: { id: 'grok-build', command: 'grok', enabled: true },
          listing,
        },
        {
          connection: { id: 'oc', command: 'opencode', enabled: true },
          listing,
        },
        {
          connection: { id: 'off', command: 'droid', enabled: false },
          listing,
        },
      ],
    });
    const first = await source.discover();
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]?.createdAt).toBe('2026-10-01T12:00:00.000Z');
    // Later activity does not move the session's creation time.
    updatedAt = '2026-10-02T12:00:00.000Z';
    expect((await source.discover()).sessions[0]?.createdAt).toBe(
      '2026-10-01T12:00:00.000Z',
    );

    expect(
      source.ownedNativeSessionId({
        provider: 'acp',
        resumeCursor: { acpSessionId: 's-1' },
      }),
    ).toBe('s-1');
    expect(
      source.ownedNativeSessionId({
        provider: 'codex',
        resumeCursor: { acpSessionId: 's-1' },
      }),
    ).toBeUndefined();
  });
});
