/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { toastStore } from '../contexts/ToastContext';
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

describe('#3290: a pick OpenCode could not be switched to', () => {
  const OC_THREAD = 'opencode-takeover-thread';

  beforeEach(() => {
    activeChatsStore.removeChat(OC_THREAD);
    activeChatsStore.initChat(OC_THREAD, {
      agentSlug: 'opencode',
      agentName: 'OpenCode',
      title: 'OpenCode Chat',
    });
    activeChatsStore.updateChat(OC_THREAD, { approvalPosture: 'ask' });
  });

  const chat = () => activeChatsStore.getSnapshot()[OC_THREAD];

  test('the takeover warning marks the recorded pick not applied and keeps what still runs', () => {
    handleOrchestrationEvent('http://localhost', {
      provider: 'acp',
      threadId: OC_THREAD,
      createdAt: '2026-10-06T00:00:00.000Z',
      method: 'runtime.warning',
      severity: 'warning',
      message:
        "Couldn't switch OpenCode to Station's approval rules; it's still using its own settings: x.",
      code: 'acp-approval-takeover-failed',
      details: { requestedApprovalMode: 'ask' },
    });
    expect(chat().approvalTakeoverFailed).toBe(true);
    expect(chat().lastAppliedApprovalMode).toBeUndefined();
    expect(sessionApprovalOverride(chat())).toEqual({
      mode: 'ask',
      state: 'not-applied',
    });
  });

  test('a turn that kept a stricter mode says so; the next turn that took the pick clears it', () => {
    activeChatsStore.updateChat(OC_THREAD, { approvalPosture: 'never' });
    handleOrchestrationEvent('http://localhost', {
      provider: 'acp',
      threadId: OC_THREAD,
      createdAt: '2026-10-06T00:00:01.000Z',
      method: 'turn.started',
      turnId: 'turn-kept',
      metadata: { approvalMode: 'ask', approvalTakeoverFailed: true },
    });
    expect(chat()).toMatchObject({
      approvalTakeoverFailed: true,
      lastAppliedApprovalMode: 'ask',
    });
    expect(sessionApprovalOverride(chat())?.state).toBe('not-applied');

    handleOrchestrationEvent('http://localhost', {
      provider: 'acp',
      threadId: OC_THREAD,
      createdAt: '2026-10-06T00:00:02.000Z',
      method: 'turn.started',
      turnId: 'turn-took',
      metadata: { approvalMode: 'never' },
    });
    expect(chat().approvalTakeoverFailed).toBe(false);
    expect(sessionApprovalOverride(chat())).toEqual({
      mode: 'never',
      state: 'confirmed',
    });
  });
});

describe('runtime warning notifications', () => {
  beforeEach(() => toastStore.clear());

  /**
   * Duo audit: Muse's "approval channel could not be used" notice is a fact
   * about how the whole session runs, and as a floating toast it covered the
   * person's own first message on a phone. It is the chat's: a transcript
   * notice (its own row, its own ×), said once however often the engine
   * repeats it. A warning about something that just happened stays a toast.
   */
  test('a session-posture warning lands in its chat’s transcript once, not over it', () => {
    const POSTURE_THREAD = 'muse-posture-thread';
    activeChatsStore.removeChat(POSTURE_THREAD);
    activeChatsStore.initChat(POSTURE_THREAD, {
      agentSlug: 'muse',
      agentName: 'Muse Code',
      title: 'Muse chat',
    });
    const warning = {
      provider: 'muse' as const,
      threadId: POSTURE_THREAD,
      createdAt: '2026-11-04T16:35:00.000Z',
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message:
        "Muse's approval channel (`muse serve`) could not be used, so this session runs through `muse exec`.",
      code: 'muse-serve-unavailable',
    };
    handleOrchestrationEvent('http://localhost', warning);
    handleOrchestrationEvent('http://localhost', warning);
    const notices = (
      activeChatsStore.getSnapshot()[POSTURE_THREAD].ephemeralMessages ?? []
    ).filter((notice) => notice.content === warning.message);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ role: 'system', ephemeral: true });
    expect(toastStore.getSnapshot()).toEqual([]);

    // Something that just happened in the same chat is still a toast.
    handleOrchestrationEvent('http://localhost', {
      ...warning,
      code: 'adapter-event-stream-interrupted',
      message: 'Agent event observation was interrupted.',
    });
    expect(toastStore.getSnapshot()).toMatchObject([
      { sessionId: POSTURE_THREAD, type: 'warning' },
    ]);
    activeChatsStore.removeChat(POSTURE_THREAD);
  });

  // An agent the engine did not take states what the engine now holds,
  // which differs from what the transcript shows: it is the chat's, like the
  // Muse notice.
  test('the ACP agent-projection warning is a transcript notice, not a toast', () => {
    const code = 'acp.agent-projection-unapplied';
    const message =
      'Kiro is running its own default agent, not this Station agent: the engine refused the agent.';
    const thread = `acp-posture-${code}`;
    activeChatsStore.removeChat(thread);
    activeChatsStore.initChat(thread, {
      agentSlug: 'kiro',
      agentName: 'Kiro',
      title: 'Kiro chat',
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'acp' as const,
      threadId: thread,
      createdAt: '2026-11-13T10:00:00.000Z',
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message,
      code,
    });
    expect(
      (activeChatsStore.getSnapshot()[thread].ephemeralMessages ?? []).filter(
        (notice) => notice.content === message,
      ),
    ).toMatchObject([{ role: 'system', ephemeral: true }]);
    expect(toastStore.getSnapshot()).toEqual([]);
    activeChatsStore.removeChat(thread);
  });

  // An in-place rewind is drawn by the transcript projection from the stored
  // event (a marker, and the hidden turns marked rewound): no toast, and no
  // second notice beside the marker.
  test('the ACP session-rewound warning is neither a toast nor an ephemeral notice', () => {
    const thread = 'acp-posture-rewound';
    activeChatsStore.removeChat(thread);
    activeChatsStore.initChat(thread, {
      agentSlug: 'kiro',
      agentName: 'Kiro',
      title: 'Kiro chat',
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'acp' as const,
      threadId: thread,
      createdAt: '2026-11-13T10:00:00.000Z',
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message: 'Kiro rewound this conversation; one turn is hidden from it.',
      code: 'acp.session-rewound',
      details: { beforeTurnId: 't-2', hiddenTurnIds: ['t-2'] },
    });
    expect(
      activeChatsStore.getSnapshot()[thread].ephemeralMessages ?? [],
    ).toEqual([]);
    expect(toastStore.getSnapshot()).toEqual([]);
    activeChatsStore.removeChat(thread);
  });

  test('the ACP late-rewind warning is drawn by the transcript, neither a toast nor an ephemeral notice', () => {
    const thread = 'acp-posture-rewound-late';
    activeChatsStore.removeChat(thread);
    activeChatsStore.initChat(thread, {
      agentSlug: 'kiro',
      agentName: 'Kiro',
      title: 'Kiro chat',
    });
    handleOrchestrationEvent('http://localhost', {
      provider: 'acp' as const,
      threadId: thread,
      createdAt: '2026-11-13T10:00:00.000Z',
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message:
        'Kiro applied an earlier rewind late, after a later turn started.',
      code: 'acp.session-rewound-late',
      details: { beforeTurnId: 't-1' },
    });
    expect(
      activeChatsStore.getSnapshot()[thread].ephemeralMessages ?? [],
    ).toEqual([]);
    expect(toastStore.getSnapshot()).toEqual([]);
    activeChatsStore.removeChat(thread);
  });

  test('reconnect warnings group within a session without hiding other sessions or causes', () => {
    const warning = {
      provider: 'acp' as const,
      threadId: THREAD_ID,
      createdAt: '2026-10-24T14:47:00.000Z',
      method: 'runtime.warning' as const,
      severity: 'warning' as const,
      message: 'Agent event observation was interrupted.',
      code: 'adapter-event-stream-interrupted',
    };
    for (let i = 0; i < 3; i++) {
      handleOrchestrationEvent('http://localhost', warning);
    }
    expect(toastStore.getSnapshot()).toMatchObject([
      { sessionId: THREAD_ID, occurrences: 3, type: 'warning' },
    ]);
    activeChatsStore.initChat('another-session', {
      agentSlug: 'opencode',
      agentName: 'OpenCode',
      title: 'Another session',
    });
    handleOrchestrationEvent('http://localhost', {
      ...warning,
      threadId: 'another-session',
    });
    handleOrchestrationEvent('http://localhost', {
      ...warning,
      code: 'another-warning',
      message: 'Another cause.',
    });
    expect(toastStore.getSnapshot()).toHaveLength(3);
  });
});
