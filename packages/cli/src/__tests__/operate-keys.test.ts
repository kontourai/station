import { describe, expect, it } from 'vitest';
import { classifyKey, OPERATE_KEYBINDINGS } from '../commands/operate/keys.js';
import { initialState, reduce } from '../commands/operate/state.js';
import type { KeyInfo, OperateState } from '../commands/operate/types.js';

function key(overrides: Partial<KeyInfo>): KeyInfo {
  return { ctrl: false, shift: false, sequence: '', ...overrides };
}

function stateWithTwoSessionsAndApprovals(): OperateState {
  let state = initialState({ focusedThreadId: 'thread-1' });
  state = reduce(state, {
    type: 'snapshot',
    sessions: [
      { threadId: 'thread-1', provider: 'claude', status: 'running' },
      { threadId: 'thread-2', provider: 'codex', status: 'running' },
    ],
  });
  state = reduce(state, {
    type: 'event',
    event: {
      threadId: 'thread-1',
      provider: 'claude',
      createdAt: '2026-07-05T00:00:00.000Z',
      requestId: 'req-1',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Allow Bash',
      payload: { toolName: 'Bash', toolInput: { command: 'ls' } },
    },
  });
  state = reduce(state, {
    type: 'event',
    event: {
      threadId: 'thread-1',
      provider: 'claude',
      createdAt: '2026-07-05T00:00:01.000Z',
      requestId: 'req-2',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Allow Edit',
      payload: { toolName: 'Edit', toolInput: { file_path: 'a.ts' } },
    },
  });
  return state;
}

describe('operate/keys: classifyKey', () => {
  // The documented `keys` label (footer legend, docs/reference/cli.md) is
  // parsed into the keypresses it names, so a key changed in only the label
  // or only classifyKey fails here.
  function keypressesFor(label: string): KeyInfo[] {
    return label.split(' / ').map((chord) => {
      const parts = chord.split('+');
      const base = parts.pop() ?? '';
      const modifiers = new Set(parts);
      return key({
        ctrl: modifiers.has('Ctrl'),
        shift: modifiers.has('Shift'),
        ...(base.length === 1 && modifiers.size === 0
          ? { sequence: base }
          : { name: base.toLowerCase() }),
      });
    });
  }

  it.each(OPERATE_KEYBINDINGS)('classifies $keys as $binding', (entry) => {
    const keypresses = keypressesFor(entry.keys);
    expect(keypresses.length).toBeGreaterThan(0);
    for (const keypress of keypresses) {
      expect(classifyKey(keypress)).toBe(entry.binding);
    }
  });

  it('returns null for an unrecognized key', () => {
    expect(classifyKey(key({ sequence: 'z' }))).toBeNull();
  });
});

describe('operate/state: keypress -> intent (table-driven)', () => {
  it('Tab cycles focus forward and emits move-focus(next), updating focusedThreadId', () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ name: 'tab' }),
    });
    expect(state.focusedThreadId).toBe('thread-2');
    expect(state.pendingIntent).toEqual({
      type: 'move-focus',
      direction: 'next',
    });
  });

  it('Shift+Tab cycles focus backward and emits move-focus(prev)', () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ name: 'tab', shift: true }),
    });
    expect(state.focusedThreadId).toBe('thread-2');
    expect(state.pendingIntent).toEqual({
      type: 'move-focus',
      direction: 'prev',
    });
  });

  it('Down moves the approval selection cursor and emits move-selection(down)', () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ name: 'down' }),
    });
    expect(state.sessions['thread-1'].selectedApprovalIndex).toBe(1);
    expect(state.pendingIntent).toEqual({
      type: 'move-selection',
      direction: 'down',
    });
  });

  it('Up wraps the approval selection cursor backward and emits move-selection(up)', () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ name: 'up' }),
    });
    expect(state.sessions['thread-1'].selectedApprovalIndex).toBe(1);
    expect(state.pendingIntent).toEqual({
      type: 'move-selection',
      direction: 'up',
    });
  });

  it("'a' emits respond-approval(accept) for the currently selected approval", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 'a' }),
    });
    expect(state.pendingIntent).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'accept',
    });
  });

  it('#3071: a request its turn’s abort settled leaves the pane, and a decision is bound to the request event it showed', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    const event = (fields: Record<string, unknown>) => ({
      type: 'event' as const,
      event: { threadId: 'thread-1', provider: 'claude', ...fields },
    });
    state = reduce(
      state,
      event({ eventId: 'evt-start', method: 'turn.started', turnId: 'turn-1' }),
    );
    state = reduce(
      state,
      event({
        eventId: 'evt-open-dead',
        method: 'request.opened',
        requestId: 'req-dead',
        requestType: 'approval',
        title: 'Allow Bash',
      }),
    );
    expect(
      state.sessions['thread-1'].approvals.map((row) => row.requestId),
    ).toEqual(['req-dead']);
    // Station restarted mid-turn: recovery's abort, with no resolution (a
    // log from before recovery wrote one).
    state = reduce(
      state,
      event({
        eventId: 'turn-interrupted-abort:b1',
        method: 'turn.aborted',
        turnId: 'turn-1',
        recoveryTerminal: true,
      }),
    );
    expect(state.sessions['thread-1'].approvals).toEqual([]);
    expect(
      reduce(state, { type: 'keypress', key: key({ sequence: 'a' }) })
        .pendingIntent,
    ).toBeNull();

    state = reduce(
      state,
      event({
        eventId: 'evt-open-live',
        method: 'request.opened',
        requestId: 'req-live',
        requestType: 'approval',
        title: 'Allow Edit',
      }),
    );
    expect(
      reduce(state, { type: 'keypress', key: key({ sequence: 'a' }) })
        .pendingIntent,
    ).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-live',
      expectedRequestEventId: 'evt-open-live',
      decision: 'accept',
    });
  });

  it('#3071: a decision on a question is not bound to its event, so the server still refuses to close it unseen', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'codex',
        eventId: 'evt-question',
        method: 'request.opened',
        requestId: 'req-question',
        requestType: 'approval',
        title: 'The agent has questions for you',
        payload: { questionnaire: { questions: [] } },
      },
    });
    expect(
      reduce(state, { type: 'keypress', key: key({ sequence: 'd' }) })
        .pendingIntent,
    ).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-question',
      decision: 'decline',
    });
  });

  it("'s' emits respond-approval(acceptForSession)", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 's' }),
    });
    expect(state.pendingIntent).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'acceptForSession',
    });
  });

  it("'d' emits respond-approval(decline)", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 'd' }),
    });
    expect(state.pendingIntent).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'decline',
    });
  });

  it("'x' emits respond-approval(cancel)", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 'x' }),
    });
    expect(state.pendingIntent).toEqual({
      type: 'respond-approval',
      threadId: 'thread-1',
      requestId: 'req-1',
      decision: 'cancel',
    });
  });

  it("'r' emits refresh-focus for the focused thread", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 'r' }),
    });
    expect(state.pendingIntent).toEqual({
      type: 'refresh-focus',
      threadId: 'thread-1',
    });
  });

  it("'q' emits quit", () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ sequence: 'q' }),
    });
    expect(state.pendingIntent).toEqual({ type: 'quit' });
  });

  it('Ctrl+C emits quit', () => {
    const state = reduce(stateWithTwoSessionsAndApprovals(), {
      type: 'keypress',
      key: key({ ctrl: true, name: 'c', sequence: '' }),
    });
    expect(state.pendingIntent).toEqual({ type: 'quit' });
  });

  it('an accept/decline/cancel keypress with no pending approvals produces no intent', () => {
    const base = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'snapshot',
      sessions: [
        { threadId: 'thread-1', provider: 'claude', status: 'running' },
      ],
    });
    const state = reduce(base, {
      type: 'keypress',
      key: key({ sequence: 'a' }),
    });
    expect(state.pendingIntent).toBeNull();
  });

  it('unrecognized keys produce no intent (state unchanged except pendingIntent staying null)', () => {
    const before = stateWithTwoSessionsAndApprovals();
    const state = reduce(before, {
      type: 'keypress',
      key: key({ sequence: 'z' }),
    });
    expect(state.pendingIntent).toBeNull();
    expect(state.focusedThreadId).toBe(before.focusedThreadId);
    expect(state.board).toEqual(before.board);
    expect(state.sessions).toEqual(before.sessions);
  });
});
