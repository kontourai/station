import { join } from 'node:path';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import {
  buildAgentRunSummary,
  buildOrchestrationSessionSummary,
  projectOrchestrationEventToReadModel,
} from '../orchestration-session-state.js';

/**
 * #4433: the approval mode the engine last reported applying travels on the
 * session summary, so a client that reloads, resyncs or reopens a chat shows
 * it instead of falling back to the inherited "Default".
 */
const THREAD = 'thread-applied';
const makeTempDir = trackTempDirs();

function event(
  method: 'session.configured' | 'turn.started',
  sequence: number,
  approvalMode?: string,
): CanonicalRuntimeEvent {
  const metadata = approvalMode ? { approvalMode } : {};
  const base = {
    eventId: `evt-${sequence}`,
    provider: 'codex',
    threadId: THREAD,
    createdAt: `2026-11-02T10:00:0${sequence}.000Z`,
    metadata,
  };
  // Both shapes come from the canonical union, so the fixture is checked.
  return method === 'session.configured'
    ? { ...base, method, sessionId: THREAD }
    : { ...base, method, turnId: `turn-${sequence}`, prompt: 'hi' };
}

function summarize(events: CanonicalRuntimeEvent[]) {
  const persisted: ProviderSession = {
    provider: 'codex',
    threadId: THREAD,
    status: 'ready',
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
  };
  return buildOrchestrationSessionSummary({
    persisted,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-11-02T10:00:00.000Z',
    },
    events,
  });
}

describe('appliedApprovalMode on the session summary (#4433)', () => {
  test('the start report survives later turns that report nothing', () => {
    const summary = summarize([
      event('session.configured', 1, 'auto'),
      event('turn.started', 2),
      event('turn.started', 3),
    ]);
    expect(summary.appliedApprovalMode).toBe('auto');
  });

  test('a newer turn report wins over the start report', () => {
    expect(
      summarize([
        event('session.configured', 1, 'connection-default'),
        event('turn.started', 2, 'ask'),
      ]).appliedApprovalMode,
    ).toBe('ask');
  });

  test('nothing reported, nothing claimed', () => {
    expect(
      summarize([event('turn.started', 1)]).appliedApprovalMode,
    ).toBeUndefined();
  });
});

test('an engine mode confirmation survives SQLite reload without changing session configuration', () => {
  const path = join(makeTempDir('mode-observation-'), 'events.sqlite');
  const store = new EventStore(path);
  const live = new Map<string, ProviderSession>();
  const answerability = {
    threadAttachment: 'detached',
    providerRegistered: true,
    observedBy: 'test',
    observedAt: '2026-11-02T10:00:00.000Z',
  } as const;
  const route = {
    connectionId: 'proxy',
    label: 'Proxy',
    endpoint: 'https://proxy.example',
  };
  const source = {
    provider: 'acp' as const,
    threadId: THREAD,
    createdAt: '2026-11-02T10:00:00.000Z',
  };
  const publish = (event: CanonicalRuntimeEvent) => {
    store.appendEvent(event);
    projectOrchestrationEventToReadModel({
      event,
      eventStore: store,
      sessionReadModel: live,
      threadProviders: new Map(),
    });
  };
  try {
    publish({
      ...source,
      eventId: 'started',
      method: 'session.started',
      sessionId: THREAD,
      initialState: 'created',
    });
    publish({
      ...source,
      eventId: 'configured',
      method: 'session.configured',
      sessionId: THREAD,
      model: 'chosen-model',
      cwd: '/work/project',
      metadata: { modelRoute: route, acpSessionMode: 'ask' },
    });
    publish({
      ...source,
      eventId: 'running',
      method: 'session.state-changed',
      sessionId: THREAD,
      from: 'idle',
      to: 'running',
    });
    publish({
      ...source,
      eventId: 'mode',
      method: 'session.engine-mode-observed',
      modeId: 'code',
    });
    publish({
      ...source,
      eventId: 'later',
      method: 'runtime.warning',
      severity: 'warning',
      message: 'After mode observation',
    });
    expect(live.get(THREAD)).toMatchObject({
      status: 'running',
      modelRoute: route,
    });
  } finally {
    store.close();
  }
  for (const batched of [false, true]) {
    const reopened = new EventStore(path);
    try {
      const persisted = reopened.readSessionByThread(THREAD)!;
      expect(persisted).toMatchObject({
        status: 'running',
        model: 'chosen-model',
      });
      const rows = batched
        ? reopened.listSessionProjectionEventsForThreads([THREAD]).get(THREAD)!
        : reopened.listSessionProjectionEvents(THREAD);
      const events = rows.map((row) => row.payload);
      expect(
        buildOrchestrationSessionSummary({ persisted, events, answerability }),
      ).toMatchObject({
        currentModeId: 'code',
        model: 'chosen-model',
        modelRoute: route,
      });
      expect(
        buildAgentRunSummary({ persisted, events, answerability }).cwd,
      ).toBe('/work/project');
    } finally {
      reopened.close();
    }
  }
});

test('SQLite reload restores only the current Codex binding’s reviewer', () => {
  const path = join(makeTempDir('reviewer-observation-'), 'events.sqlite');
  const base = {
    provider: 'codex' as const,
    threadId: THREAD,
    createdAt: '2026-11-02T10:00:00.000Z',
  };
  const write = (events: CanonicalRuntimeEvent[]) => {
    const store = new EventStore(path);
    try {
      for (const item of events) store.appendEvent(item);
    } finally {
      store.close();
    }
  };
  const expectRestored = (reviewer: string, approvalMode: string) => {
    for (const read of [
      (store: EventStore) => store.listSessionProjectionEvents(THREAD),
      (store: EventStore) =>
        store.listSessionProjectionEventsForThreads([THREAD]).get(THREAD) ?? [],
    ]) {
      const store = new EventStore(path);
      try {
        expect(summarize(read(store).map((row) => row.payload))).toMatchObject({
          reportedApprovalReviewer: reviewer,
          appliedApprovalMode: approvalMode,
        });
      } finally {
        store.close();
      }
    }
  };
  const started = (id: string, reviewer: string): CanonicalRuntimeEvent => ({
    ...base,
    eventId: id,
    method: 'session.started',
    sessionId: THREAD,
    metadata: { reportedApprovalReviewer: reviewer },
  });
  write([
    started('first-start', 'user'),
    {
      ...base,
      eventId: 'reviewer-update',
      method: 'session.approval-reviewer-observed',
      reviewer: 'automatic',
    },
    event('turn.started', 1, 'ask'),
  ]);
  expectRestored('automatic', 'ask');
  write([
    started('replacement-start', 'unknown'),
    event('turn.started', 2, 'auto'),
  ]);
  expectRestored('unknown', 'auto');
});
