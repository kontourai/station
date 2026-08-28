import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../adapters/claude-adapter-events.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';

vi.mock('../../telemetry/metrics.js', () => ({
  adapterSessionStartDuration: { record: vi.fn() },
  providerOps: { add: vi.fn() },
}));

/**
 * archive#3457: `itemId` names the CONTENT ITEM a delta belongs to, not the
 * chunk — see the contract on `ContentTextDeltaEvent.itemId`. Bedrock and
 * Ollama minted a fresh `crypto.randomUUID()` INSIDE their streaming loops,
 * and Claude derived it from `message.uuid`, which is per `stream_event`.
 * All three therefore produced one distinct id per token, which makes any
 * consumer that groups or merges by `itemId` a silent no-op.
 *
 * Each test below asserts both directions: every delta of one item shares an
 * id, and deltas of a different item (or a different turn) do not.
 */

type DeltaEvent = CanonicalRuntimeEvent & {
  method: 'content.text-delta' | 'content.reasoning-delta';
  itemId: string;
  delta: string;
};

function isDelta(
  event: CanonicalRuntimeEvent | undefined,
): event is DeltaEvent {
  return (
    event?.method === 'content.text-delta' ||
    event?.method === 'content.reasoning-delta'
  );
}

/**
 * Drain the adapter's event stream until `turn.completed` has been seen
 * `turns` times, collecting the content deltas along the way. Bounded so a
 * regression that stops publishing cannot hang the suite.
 */
async function collectDeltas(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  turns: number,
): Promise<DeltaEvent[]> {
  const deltas: DeltaEvent[] = [];
  let completed = 0;
  for (let index = 0; index < 64 && completed < turns; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 2_000),
      ),
    ]);
    if (next.done) break;
    if (isDelta(next.value)) deltas.push(next.value);
    if (next.value?.method === 'turn.completed') completed += 1;
  }
  return deltas;
}

describe('Bedrock content-delta itemId (station#3457)', () => {
  test('every chunk of one assistant item shares an itemId; a second turn does not', async () => {
    const llm = {
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Hel' };
        yield { type: 'text-delta', content: 'lo ' };
        yield { type: 'text-delta', content: 'world' };
        // archive#3545 review round 2: `AiSdkLLMProvider.createStream`
        // (which `BedrockLLMProvider` inherits) now propagates ai-sdk's own
        // `finishReason`, so `finishReason: 'stop'` IS the ordinary
        // successful-turn shape again — a bare `{ type: 'finish' }` is now
        // the edge case (the producer's own finishReason promise rejected).
        // NOT "matches the Ollama fixture just below": `OllamaLLMProvider`
        // also extends `AiSdkLLMProvider` and now also emits a real reason
        // in production, but `OllamaAdapter.sendTurn` never reads
        // `chunk.finishReason` at all (it always defaults to `'stop'`
        // regardless) — so that fixture staying bare proves nothing either
        // way about this one; it is simply untested by this file's claim.
        yield { type: 'finish', finishReason: 'stop' };
      }),
    };
    const adapter = new BedrockAdapter(
      {},
      {
        llm: llm as never,
        modelCatalog: { resolveModelId: async (id: string) => id },
      },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-item-id',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-item-id', input: 'hi' });
    await adapter.sendTurn({ threadId: 'thread-item-id', input: 'again' });

    const deltas = await collectDeltas(iterator, 2);
    expect(deltas.map((event) => event.delta)).toEqual([
      'Hel',
      'lo ',
      'world',
      'Hel',
      'lo ',
      'world',
    ]);

    const firstTurn = deltas.slice(0, 3).map((event) => event.itemId);
    const secondTurn = deltas.slice(3).map((event) => event.itemId);
    // One item, one id — the whole point of the field.
    expect(new Set(firstTurn).size).toBe(1);
    expect(new Set(secondTurn).size).toBe(1);
    // A distinct item (the next turn's assistant message) is distinct.
    expect(firstTurn[0]).not.toBe(secondTurn[0]);
  });
});

describe('Ollama content-delta itemId (station#3457)', () => {
  test('every chunk of one assistant item shares an itemId; a second turn does not', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Hel' };
        yield { type: 'text-delta', content: 'lo ' };
        yield { type: 'text-delta', content: 'world' };
        yield { type: 'finish' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as never,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-item-id',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-item-id', input: 'hi' });
    await adapter.sendTurn({ threadId: 'thread-item-id', input: 'again' });

    const deltas = await collectDeltas(iterator, 2);
    expect(deltas.map((event) => event.delta)).toEqual([
      'Hel',
      'lo ',
      'world',
      'Hel',
      'lo ',
      'world',
    ]);

    const firstTurn = deltas.slice(0, 3).map((event) => event.itemId);
    const secondTurn = deltas.slice(3).map((event) => event.itemId);
    expect(new Set(firstTurn).size).toBe(1);
    expect(new Set(secondTurn).size).toBe(1);
    expect(firstTurn[0]).not.toBe(secondTurn[0]);
  });
});

describe('Claude content-delta itemId (station#3457)', () => {
  function makeRecord(turnId: string): ClaudeMessageState {
    return {
      session: {
        provider: 'claude',
        threadId: 'thread-item-id',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      activeTurnId: turnId,
      dispatchedTurnId: turnId,
      lastSessionState: 'running',
    };
  }

  /**
   * The SDK wraps Anthropic's raw stream: each `stream_event` carries its own
   * `uuid`, which is exactly why `uuid` cannot identify an item.
   */
  function streamEvent(event: unknown, uuid: string) {
    return {
      type: 'stream_event',
      event,
      uuid,
      session_id: 'sdk-session-1',
    } as never;
  }

  function textDelta(index: number, text: string, uuid: string) {
    return streamEvent(
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      },
      uuid,
    );
  }

  function thinkingDelta(index: number, thinking: string, uuid: string) {
    return streamEvent(
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking },
      },
      uuid,
    );
  }

  function messageStart(id: string, uuid: string) {
    return streamEvent({ type: 'message_start', message: { id } }, uuid);
  }

  test('chunks of one content block share an itemId; other blocks, messages and turns do not', () => {
    const publish = vi.fn();
    const record = makeRecord('turn-1');
    const emit = (message: never) =>
      mapClaudeSdkMessage({ provider: 'claude', record, publish, message });

    // One assistant message: a thinking block (index 0) then a text block
    // (index 1), each streamed in two chunks with distinct SDK uuids.
    emit(messageStart('msg_a', 'u1'));
    emit(thinkingDelta(0, 'plan', 'u2'));
    emit(thinkingDelta(0, ' more', 'u3'));
    emit(textDelta(1, 'Hel', 'u4'));
    emit(textDelta(1, 'lo', 'u5'));
    // A second assistant message in the SAME turn — its text block reuses
    // content-block index 0, so index alone cannot discriminate it.
    emit(messageStart('msg_b', 'u6'));
    emit(textDelta(0, 'after tool', 'u7'));

    const events = publish.mock.calls.map(([event]) => event as DeltaEvent);
    expect(events.map((event) => event.method)).toEqual([
      'content.reasoning-delta',
      'content.reasoning-delta',
      'content.text-delta',
      'content.text-delta',
      'content.text-delta',
    ]);

    const [reasoningA, reasoningB, textA, textB, secondMessageText] = events;
    // Same block, two chunks, one id.
    expect(reasoningA.itemId).toBe(reasoningB.itemId);
    expect(textA.itemId).toBe(textB.itemId);
    // A reasoning item and a text item in the same message are distinct.
    expect(reasoningA.itemId).not.toBe(textA.itemId);
    // A later message's index-0 block is a distinct item.
    expect(secondMessageText.itemId).not.toBe(reasoningA.itemId);
    expect(secondMessageText.itemId).not.toBe(textA.itemId);

    // A second turn on the same record is distinct again.
    const secondTurnPublish = vi.fn();
    record.activeTurnId = 'turn-2';
    record.dispatchedTurnId = 'turn-2';
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish: secondTurnPublish,
      message: messageStart('msg_c', 'u8'),
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish: secondTurnPublish,
      message: textDelta(0, 'next turn', 'u9'),
    });
    const nextTurn = secondTurnPublish.mock.calls[0]?.[0] as DeltaEvent;
    expect(nextTurn.itemId).not.toBe(textA.itemId);
    expect(nextTurn.itemId).not.toBe(secondMessageText.itemId);
  });

  test('deltas with no preceding message_start still share one id per turn, and never across turns', () => {
    const publish = vi.fn();
    const record = makeRecord('turn-1');
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: textDelta(0, 'a', 'u1'),
    });
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish,
      message: textDelta(0, 'b', 'u2'),
    });
    const [first, second] = publish.mock.calls.map(
      ([event]) => event as DeltaEvent,
    );
    expect(first.itemId).toBe(second.itemId);

    // The lazily minted key is never reset, so the turn is what keeps a
    // later turn's index-0 block from reusing this id.
    record.activeTurnId = 'turn-2';
    const laterPublish = vi.fn();
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      publish: laterPublish,
      message: textDelta(0, 'c', 'u3'),
    });
    const later = laterPublish.mock.calls[0]?.[0] as DeltaEvent;
    expect(later.itemId).not.toBe(first.itemId);
  });
});
