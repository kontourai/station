/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../hooks/orchestration/eventHandlers';

const THREAD_ID = 'approval-mode-warning-thread';

describe('runtime.warning approval-escalation-requires-restart handling (#727 review item 1b)', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
    activeChatsStore.updateChat(THREAD_ID, {
      providerOptions: { approvalMode: 'never' },
    });
  });

  test('reverts the stored session override to the mode that actually applied', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'runtime.warning',
      severity: 'warning',
      message:
        'Full-access mode requires restarting the session with that mode enabled from the start. Approval mode was not changed.',
      code: 'approval-escalation-requires-restart',
      details: {
        requestedApprovalMode: 'never',
        revertToApprovalMode: 'ask',
      },
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    // The chip must not go on showing 'never' for a mode that never
    // actually applied — it reflects the adapter-reported real mode.
    expect(chat.providerOptions?.approvalMode).toBe('ask');
  });

  test('an unrelated runtime.warning does not touch the stored approval override', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'runtime.warning',
      severity: 'warning',
      message: 'Some unrelated warning.',
      code: 'some-other-code',
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(chat.providerOptions?.approvalMode).toBe('never');
  });

  test('a malformed revertToApprovalMode is ignored rather than corrupting the stored override', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'claude',
      threadId: THREAD_ID,
      createdAt: '2026-07-23T00:00:02.000Z',
      method: 'runtime.warning',
      severity: 'warning',
      message: 'Full-access mode requires restarting the session.',
      code: 'approval-escalation-requires-restart',
      details: { requestedApprovalMode: 'never' },
    });

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(chat.providerOptions?.approvalMode).toBe('never');
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
