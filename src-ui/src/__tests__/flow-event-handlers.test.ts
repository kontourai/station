/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import {
  hydrateActiveChats,
  serializeActiveChats,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';

const THREAD_ID = 'flow-handler-thread';

describe('flow orchestration event handlers', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Dev Agent Chat',
    });
  });

  test('flow.run-attached sets the flow binding and appends a marker message', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: true,
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(chat.flowRun).toEqual({
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: true,
    });
    const lastMessage = chat.messages?.at(-1);
    expect(lastMessage?.role).toBe('system');
    expect(lastMessage?.contentParts?.[0]?.type).toBe('flow-run-attached');
    expect(lastMessage?.contentParts?.[0]?.flowRunAttached?.resumed).toBe(true);
  });

  test('flow.gate-verdict appends a verdict message with the full payload', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:01.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'route-back',
      gateId: 'verify',
      summary: 'Verification gate failed.',
      nextAction: 'Fix failing tests.',
      routeBackTo: 'implement',
      attempt: 1,
      maxAttempts: 3,
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const lastMessage = chat.messages?.at(-1);
    expect(lastMessage?.role).toBe('system');
    expect(lastMessage?.content).toBe('Fix failing tests.');
    const part = lastMessage?.contentParts?.[0];
    expect(part?.type).toBe('flow-gate-verdict');
    expect(part?.flowGateVerdict).toMatchObject({
      verdict: 'route-back',
      routeBackTo: 'implement',
      attempt: 1,
      maxAttempts: 3,
    });
  });

  test('gives identical default verdict rows their authoritative event identities and times', () => {
    for (const [eventId, createdAt] of [
      ['verdict-1', '2026-06-11T00:00:01.000Z'],
      ['verdict-2', '2026-06-11T00:00:02.000Z'],
    ] as const) {
      handleOrchestrationEvent('http://localhost', {
        eventId,
        provider: 'codex',
        threadId: THREAD_ID,
        createdAt,
        method: 'flow.gate-verdict',
        runId: 'session-thread-1',
        verdict: 'pass',
      });
    }

    const verdicts = activeChatsStore
      .getSnapshot()
      [THREAD_ID].messages?.filter(
        (message) => message.contentParts?.[0]?.type === 'flow-gate-verdict',
      );
    expect(verdicts?.map((message) => message.content)).toEqual([
      'Flow gates passed.',
      'Flow gates passed.',
    ]);
    expect(verdicts?.map((message) => message.id)).toEqual([
      'verdict-1',
      'verdict-2',
    ]);
    expect(verdicts?.map((message) => message.timestamp)).toEqual([
      Date.parse('2026-06-11T00:00:01.000Z'),
      Date.parse('2026-06-11T00:00:02.000Z'),
    ]);
  });

  /**
   * archive#189: the binding's freshness is PERSISTED, so an attach-time
   * snapshot that is never refreshed keeps a run reading "never evaluated"
   * for the life of the session and across reloads. The refresh takes the
   * server's derivation verbatim — the client never computes freshness.
   */
  test('a gate verdict replaces the binding freshness with the server derivation', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'plan',
      freshness: {
        lastEvaluatedAt: null,
        blockedReason: 'ungated-step',
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'pass',
      gateId: 'implement-gate',
      currentStep: 'verify',
      freshness: {
        lastEvaluatedAt: '2026-06-11T00:04:59.000Z',
        gateOutcomeCount: 1,
        evidenceCount: 2,
      },
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(chat.flowRun?.freshness).toEqual({
      lastEvaluatedAt: '2026-06-11T00:04:59.000Z',
      gateOutcomeCount: 1,
      evidenceCount: 2,
    });
    // The step advanced with the evaluation; the binding must not go on
    // naming the step the run has left.
    expect(chat.flowRun?.currentStep).toBe('verify');
  });

  test('a wait verdict renders the same state the CLI shows, not a client-stamped time', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'implement',
      freshness: {
        lastEvaluatedAt: null,
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    // Flow appends no transition for a `wait`, so the server derives a null
    // timestamp with a non-zero outcome count. The client used to stamp
    // `event.createdAt` here, which made the chip and the CLI pane report
    // two different truths about one run.
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'wait',
      gateId: 'implement-gate',
      currentStep: 'implement',
      freshness: {
        lastEvaluatedAt: null,
        gateOutcomeCount: 1,
        evidenceCount: 0,
      },
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness,
    ).toEqual({
      lastEvaluatedAt: null,
      gateOutcomeCount: 1,
      evidenceCount: 0,
    });
  });

  test('re-evaluating one gate does not inflate the count past the server truth', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      freshness: {
        lastEvaluatedAt: null,
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });
    // Three evaluations of ONE gate. Flow replaces that gate's outcome each
    // time, so its own count stays at 1 throughout — including across the
    // re-attach in between, which the old client-side tally could not see.
    for (const createdAt of [
      '2026-06-11T00:05:00.000Z',
      '2026-06-11T00:06:00.000Z',
      '2026-06-11T00:07:00.000Z',
    ]) {
      if (createdAt === '2026-06-11T00:06:00.000Z') {
        handleOrchestrationEvent('http://localhost', {
          provider: 'codex',
          threadId: THREAD_ID,
          createdAt,
          method: 'flow.run-attached',
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          cwd: '/tmp/project',
          resumed: true,
          freshness: {
            lastEvaluatedAt: '2026-06-11T00:05:00.000Z',
            gateOutcomeCount: 1,
            evidenceCount: 0,
          },
        });
      }
      handleOrchestrationEvent('http://localhost', {
        provider: 'codex',
        threadId: THREAD_ID,
        createdAt,
        method: 'flow.gate-verdict',
        runId: 'session-thread-1',
        verdict: 'route-back',
        gateId: 'implement-gate',
        freshness: {
          lastEvaluatedAt: createdAt,
          gateOutcomeCount: 1,
          evidenceCount: 0,
        },
      });
    }

    const freshness =
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness;
    expect(freshness?.gateOutcomeCount).toBe(1);
    expect(freshness?.lastEvaluatedAt).toBe('2026-06-11T00:07:00.000Z');
  });

  test('a multi-gate advance reports every gate Flow recorded', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'implement',
      freshness: {
        lastEvaluatedAt: null,
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    // One completion request can settle several gates in a row; only the LAST
    // gate id reaches the verdict. Counting verdict events would report 1
    // where Flow recorded 3 — the server's own count is the only one that can
    // see the other two.
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'pass',
      gateId: 'readiness-gate',
      currentStep: 'readiness',
      freshness: {
        lastEvaluatedAt: '2026-06-11T00:04:59.000Z',
        gateOutcomeCount: 3,
        evidenceCount: 3,
      },
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness
        ?.gateOutcomeCount,
    ).toBe(3);
  });

  test('a same-run verdict without server freshness clears the stale claim', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'plan',
      freshness: {
        lastEvaluatedAt: null,
        blockedReason: 'ungated-step',
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    // The harmful instance: an evaluation demonstrably happened, but the
    // server's post-evaluation read failed so the verdict carries no
    // freshness. Keeping the attach snapshot would leave "never evaluated"
    // standing after a real evaluation; clearing degrades the chip to its
    // explicit unknown state instead.
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'pass',
      gateId: 'implement-gate',
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness,
    ).toBeUndefined();
  });

  test('a different run’s freshness-less verdict leaves the binding untouched', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'plan',
      freshness: {
        lastEvaluatedAt: null,
        blockedReason: 'ungated-step',
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    // A different run's verdict says nothing about this binding — neither a
    // new value nor grounds to discard the one it holds.
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'some-other-run',
      verdict: 'pass',
      gateId: 'implement-gate',
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness,
    ).toEqual({
      lastEvaluatedAt: null,
      blockedReason: 'ungated-step',
      gateOutcomeCount: 0,
      evidenceCount: 0,
    });
  });

  test('a verdict for a different run leaves the binding alone', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      freshness: {
        lastEvaluatedAt: null,
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'some-other-run',
      verdict: 'pass',
      gateId: 'implement-gate',
      freshness: {
        lastEvaluatedAt: '2026-06-11T00:05:00.000Z',
        gateOutcomeCount: 9,
        evidenceCount: 9,
      },
    });

    expect(
      activeChatsStore.getSnapshot()[THREAD_ID].flowRun?.freshness,
    ).toEqual({
      lastEvaluatedAt: null,
      gateOutcomeCount: 0,
      evidenceCount: 0,
    });
  });

  test('a reloaded session rehydrates the verdict state, not the attach snapshot', () => {
    activeChatsStore.updateChat(THREAD_ID, { conversationId: 'conv-1' });
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:00:00.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/project',
      resumed: false,
      currentStep: 'plan',
      freshness: {
        lastEvaluatedAt: null,
        blockedReason: 'ungated-step',
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: THREAD_ID,
      createdAt: '2026-06-11T00:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'pass',
      gateId: 'implement-gate',
      currentStep: 'verify',
      freshness: {
        lastEvaluatedAt: '2026-06-11T00:04:59.000Z',
        gateOutcomeCount: 1,
        evidenceCount: 2,
      },
    });

    const rehydrated = hydrateActiveChats(
      serializeActiveChats(activeChatsStore.getSnapshot()),
    );
    expect(rehydrated[THREAD_ID].flowRun?.freshness).toEqual({
      lastEvaluatedAt: '2026-06-11T00:04:59.000Z',
      gateOutcomeCount: 1,
      evidenceCount: 2,
    });
    expect(rehydrated[THREAD_ID].flowRun?.currentStep).toBe('verify');
  });

  test('flow events for unknown threads are ignored', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: 'missing-thread',
      createdAt: '2026-06-11T00:00:02.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-1',
      verdict: 'pass',
    });

    expect(activeChatsStore.getSnapshot()['missing-thread']).toBeUndefined();
  });
});
