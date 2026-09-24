/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';
import { sessionApprovalOverride } from '../utils/approvalMode';

const RESTART_CODE = 'approval-escalation-requires-restart';

const THREAD_ID = 'approval-mode-warning-thread';

describe('runtime.warning approval-escalation-requires-restart handling (#727 review item 1b)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
    // #2436: the posture is the server's recorded decision; the chat folds it.
    activeChatsStore.updateChat(THREAD_ID, {
      approvalPosture: 'never',
      lastAppliedApprovalMode: 'ask',
    });
  });

  function warn(details: Record<string, unknown>, code = RESTART_CODE) {
    handleOrchestrationEvent('http://localhost', {
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'runtime.warning',
      severity: 'warning',
      message: 'Full-access mode requires restarting the session.',
      code,
      details,
    });
    return activeChatsStore.getSnapshot()[THREAD_ID];
  }

  test('the chip reads the mode that actually applied, and marks the recorded full access refused', () => {
    const chat = warn({
      requestedApprovalMode: 'never',
      revertToApprovalMode: 'ask',
    });
    expect(chat.lastAppliedApprovalMode).toBe('ask');
    expect(chat.approvalEscalationRejected).toBe(true);
    // The decision itself stays recorded: the next session spawns in it.
    expect(chat.approvalPosture).toBe('never');
    expect(sessionApprovalOverride(chat)).toEqual({
      mode: 'never',
      state: 'refused',
    });
  });

  test('an unrelated runtime.warning does not touch the approval state', () => {
    const chat = warn({}, 'some-other-code');
    expect(chat.approvalEscalationRejected).toBeUndefined();
    expect(chat.lastAppliedApprovalMode).toBe('ask');
  });

  test('a malformed revertToApprovalMode is ignored rather than corrupting the applied mode', () => {
    activeChatsStore.updateChat(THREAD_ID, { lastAppliedApprovalMode: 'auto' });
    const chat = warn({
      requestedApprovalMode: 'never',
      revertToApprovalMode: 'bogus',
    });
    expect(chat.lastAppliedApprovalMode).toBe('auto');
  });
});

describe('lastAppliedApprovalMode tracking from session.configured / turn.started (#727 review round 3, item 1)', () => {
  const TRACK_THREAD_ID = 'approval-mode-tracking-thread';

  beforeEach(() => {
    activeChatsStore.removeChat(TRACK_THREAD_ID);
    activeChatsStore.initChat(TRACK_THREAD_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Codex Chat',
    });
  });

  test('session.configured seeds lastAppliedApprovalMode at session start', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'session.configured',
      sessionId: TRACK_THREAD_ID,
      model: 'gpt-5-codex',
      metadata: { approvalMode: 'ask' },
    });

    expect(
      activeChatsStore.getSnapshot()[TRACK_THREAD_ID].lastAppliedApprovalMode,
    ).toBe('ask');
  });

  test('session.started (no metadata.approvalMode) does not clobber an existing lastAppliedApprovalMode with undefined', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      lastAppliedApprovalMode: 'never',
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'session.started',
      sessionId: TRACK_THREAD_ID,
      initialState: 'created',
    });

    expect(
      activeChatsStore.getSnapshot()[TRACK_THREAD_ID].lastAppliedApprovalMode,
    ).toBe('never');
  });

  test('turn.started refreshes lastAppliedApprovalMode with the actually-applied posture for that turn', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      lastAppliedApprovalMode: 'ask',
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:02.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      metadata: {
        approvalMode: 'never',
        effectiveModel: 'gpt-5.4',
        effectiveModelOptions: { effort: 'high', fastMode: true },
      },
    });

    expect(
      activeChatsStore.getSnapshot()[TRACK_THREAD_ID].lastAppliedApprovalMode,
    ).toBe('never');
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      model: 'gpt-5.4',
      orchestrationModel: 'gpt-5.4',
      providerOptions: { effort: 'high', fastMode: true },
    });
  });

  test('a turn.started with no approvalMode metadata leaves the tracked value untouched', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      lastAppliedApprovalMode: 'ask',
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:03.000Z',
      method: 'turn.started',
      turnId: 'turn-2',
    });

    expect(
      activeChatsStore.getSnapshot()[TRACK_THREAD_ID].lastAppliedApprovalMode,
    ).toBe('ask');
  });

  test('a provider-confirmed model-option reset clears controls but keeps approval state', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      providerOptions: {
        approvalMode: 'never',
        effort: 'high',
        fastMode: true,
        contextWindow: 1_000_000,
        longContext: true,
        serviceTier: 'fast',
      },
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'claude',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:04.000Z',
      method: 'turn.started',
      turnId: 'turn-reset',
      metadata: {
        effectiveModel: 'claude-opus',
        effectiveModelOptions: {},
      },
    });

    expect(
      activeChatsStore.getSnapshot()[TRACK_THREAD_ID].providerOptions,
    ).toEqual({ approvalMode: 'never' });
  });

  test('session and turn writers keep B after a late duplicate A report, and promote B provenance on acknowledgment', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      requestedModel: 'A',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'high' },
      modelSource: 'agent default',
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:05.000Z',
      method: 'session.configured',
      sessionId: TRACK_THREAD_ID,
      metadata: {
        effectiveModel: 'A',
        effectiveModelOptions: { effort: 'high' },
      },
    });
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      requestedModel: undefined,
      requestedProviderOptions: undefined,
    });
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      requestedModel: 'B',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'low' },
    });

    // This is the duplicate report for the already-acknowledged A request.
    // B was selected in between and must remain pending in each writer.
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:05.500Z',
      method: 'session.configured',
      sessionId: TRACK_THREAD_ID,
      metadata: {
        effectiveModel: 'A',
        effectiveModelOptions: { effort: 'high' },
      },
    });
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      requestedModel: 'B',
      requestedProviderOptions: { effort: 'low' },
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:06.000Z',
      method: 'turn.started',
      turnId: 'late-a',
      metadata: {
        effectiveModel: 'A',
        effectiveModelOptions: { effort: 'high' },
      },
    });
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      requestedModel: 'B',
      requestedProviderOptions: { effort: 'low' },
    });

    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:07.000Z',
      method: 'turn.started',
      turnId: 'ack-b',
      metadata: {
        effectiveModel: 'B',
        effectiveModelOptions: { effort: 'low' },
      },
    });
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      requestedModel: undefined,
      requestedProviderOptions: undefined,
      modelSource: 'session override',
    });
  });

  test('a stale options report acknowledges the model but preserves the newer options request', () => {
    activeChatsStore.updateChat(TRACK_THREAD_ID, {
      requestedModel: 'B',
      requestedModelSource: 'session override',
      requestedProviderOptions: { effort: 'low' },
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'codex',
      threadId: TRACK_THREAD_ID,
      createdAt: '2026-07-23T00:00:08.000Z',
      method: 'turn.started',
      turnId: 'stale-options',
      metadata: {
        effectiveModel: 'B',
        effectiveModelOptions: { effort: 'high' },
      },
    });
    expect(activeChatsStore.getSnapshot()[TRACK_THREAD_ID]).toMatchObject({
      requestedModel: undefined,
      requestedProviderOptions: { effort: 'low' },
    });
  });
});
