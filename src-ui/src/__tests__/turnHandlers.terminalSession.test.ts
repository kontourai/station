/**
 * @vitest-environment jsdom
 *
 * archive#1827. `handleRuntimeErrorEvent` (turnHandlers.ts) is where the
 * ticket's reported symptom actually rendered — the streaming bubble that
 * was "the chat's only content", repeated. These pin: (1) a terminal
 * engine-session `runtime.error` renders translated copy with the raw
 * engine text behind a disclosure, never the raw prose as the headline;
 * (2) the `[SYSTEM_EVENT] [CHAT_ERROR:code]` marker carries the code so
 * `ChatDockBody`'s replay-path classification matches the live one; (3) an
 * ORDINARY runtime.error (no code) is completely unaffected — byte-identical
 * raw-text display, exactly as before this ticket.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { activeChatsStore } from '../contexts/active-chats-store';
import { handleRuntimeErrorEvent } from '../hooks/orchestration/turnHandlers';
import { outboundDispatch } from '../lib/outboundQueue';

const THREAD_ID = 'terminal-session-thread';
const RAW_MESSAGE =
  'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';

describe('handleRuntimeErrorEvent — station#1827 terminal engine session', () => {
  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'claude',
      agentName: 'Claude Code',
      title: 'Claude Chat',
    });
  });

  test('a failed turn preserves the provider refusal without claiming a lost binding or suggesting another attempt', () => {
    const raw = 'Provider safeguards flagged this message.';
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      code: 'engine-turn-failed',
      message: raw,
    } as any);
    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const text = chat.streamingMessage?.contentParts
      ?.filter((part: any) => part.type === 'text')
      .map((part: any) => part.content)
      .join('\n');
    expect(text).toContain('This turn did not complete');
    expect(text).toContain(raw);
    expect(text).not.toMatch(/session was lost|fresh session|send.*again/i);
    expect(chat.messages?.[0].content).toBe(
      `[SYSTEM_EVENT] [CHAT_ERROR:engine-turn-failed] ${raw}`,
    );
  });

  test('renders translated copy in the streaming bubble, with the raw text behind a disclosure — not as the headline', () => {
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      code: 'engine-session-binding-dead',
      message: RAW_MESSAGE,
    } as any);

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const bubbleText = chat.streamingMessage?.contentParts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.content)
      .join('\n');

    // #765 A1: the translated headline names the recoverable fact (the
    // engine session was lost) — not "history is gone", which overclaimed:
    // the conversation survives via the server's continuation seam.
    expect(bubbleText).toMatch(/engine session was lost/i);
    // The raw engine text is present (the disclosure), but strictly AFTER
    // the translated headline — never itself the headline.
    expect(bubbleText).toContain(RAW_MESSAGE);
    expect(bubbleText!.indexOf(RAW_MESSAGE)).toBeGreaterThan(
      bubbleText!.indexOf('engine session was lost'),
    );
  });

  test('embeds the code in the [SYSTEM_EVENT] [CHAT_ERROR:code] marker', () => {
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      code: 'engine-session-binding-dead',
      message: RAW_MESSAGE,
    } as any);

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    expect(chat.messages?.[0].content).toBe(
      `[SYSTEM_EVENT] [CHAT_ERROR:engine-session-binding-dead] ${RAW_MESSAGE}`,
    );
  });

  test('an ordinary runtime.error (no code) keeps the exact raw-text display — unaffected by this ticket', () => {
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'Station agent did not accept the task turn.',
    } as any);

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const bubbleText = chat.streamingMessage?.contentParts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.content)
      .join('\n');

    expect(bubbleText).toBe('Station agent did not accept the task turn.');
    expect(chat.messages?.[0].content).toBe(
      '[SYSTEM_EVENT] [CHAT_ERROR] Station agent did not accept the task turn.',
    );
  });

  test('repeat-compaction still collapses identical terminal-session repeats using the raw message as the dedup key', () => {
    for (let i = 0; i < 3; i++) {
      handleRuntimeErrorEvent({
        threadId: THREAD_ID,
        method: 'runtime.error',
        code: 'engine-session-binding-dead',
        message: RAW_MESSAGE,
      } as any);
    }

    const chat = activeChatsStore.getSnapshot()[THREAD_ID];
    const bubbleText = chat.streamingMessage?.contentParts
      ?.filter((p: any) => p.type === 'text')
      .map((p: any) => p.content)
      .join('\n');

    expect(bubbleText).toMatch(/\(repeated 3×\)$/);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages?.[0].content).toMatch(/\(repeated 3×\)$/);
  });
});

// archive#3451: RuntimeErrorEvent extends CanonicalRuntimeEventBase,
// which carries an optional TOP-LEVEL `turnId` — publishers set it there
// (muse, bedrock's publishTurnFailure, codex's 'error'/turn.status:'failed'
// sites), never inside `details`. Reading only `event.details?.turnId` meant
// this reconcile never fired for any of them.
describe('handleRuntimeErrorEvent — station#3451 finding 8 durable turn reconciliation', () => {
  async function flushDynamicImport(): Promise<void> {
    // reconcileDurableTurn does `void import(...).then(...)` — a dynamic
    // import resolves over several microtask turns even when the module is
    // already cached; two macrotask ticks is enough headroom.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    activeChatsStore.removeChat(THREAD_ID);
    activeChatsStore.initChat(THREAD_ID, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Codex Chat',
    });
  });

  test('reconciles from the top-level event.turnId when details carries none', async () => {
    const spy = vi
      .spyOn(outboundDispatch, 'completeAcceptedTurn')
      .mockResolvedValue(undefined);
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      turnId: 'turn-top-level',
      message: 'boom',
    } as any);
    await flushDynamicImport();
    expect(spy).toHaveBeenCalledWith(THREAD_ID, 'turn-top-level');
    spy.mockRestore();
  });

  test('prefers details.turnId over the top-level turnId when both are present', async () => {
    const spy = vi
      .spyOn(outboundDispatch, 'completeAcceptedTurn')
      .mockResolvedValue(undefined);
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      turnId: 'turn-top-level',
      details: { turnId: 'turn-details' },
      message: 'boom',
    } as any);
    await flushDynamicImport();
    expect(spy).toHaveBeenCalledWith(THREAD_ID, 'turn-details');
    spy.mockRestore();
  });

  test('does not reconcile when neither the event nor details carries a turnId', async () => {
    const spy = vi
      .spyOn(outboundDispatch, 'completeAcceptedTurn')
      .mockResolvedValue(undefined);
    handleRuntimeErrorEvent({
      threadId: THREAD_ID,
      method: 'runtime.error',
      message: 'boom',
    } as any);
    await flushDynamicImport();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
