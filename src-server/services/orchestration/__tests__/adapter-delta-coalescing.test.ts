import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../../../providers/adapters/bedrock-adapter.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../../../providers/adapters/claude-adapter-events.js';
import { OllamaAdapter } from '../../../providers/adapters/ollama-adapter.js';
import { DeltaCoalescer } from '../delta-coalescer.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  adapterSessionStartDuration: { record: vi.fn() },
  providerOps: { add: vi.fn() },
}));

/**
 * station#3350's PURPOSE, pinned against the events the adapters actually
 * produce.
 *
 * Coalescing is a JOIN between two files that do not import one another:
 * `streamKeyOf` merges only within one `itemId`, and the adapters are what
 * decide whether consecutive deltas share one. Nothing asserted that join, and
 * on this branch's original tree it did not hold — Bedrock and Ollama minted
 * `crypto.randomUUID()` INSIDE their streaming loops and Claude derived the id
 * per SDK `stream_event`, so every delta was a new stream, the first-delta
 * pass-through fired for each, and `pending` never populated: 50 deltas in, 50
 * events out, zero coalescing, with every unit test still green because they
 * all hardcode one `itemId`.
 *
 * station#3457 fixed the adapters. These tests are the guard that keeps them
 * fixed FOR THIS PURPOSE: a future per-chunk adapter would otherwise remove
 * coalescing entirely with no test, no warning and no metric. The `perChunkId`
 * control below is that broken composition, kept so the assertion is known to
 * discriminate rather than merely to pass.
 */

const CHUNKS = 50;

/** A coalescer whose window never fires on its own, so a turn's text batches. */
function collectingCoalescer() {
  const published: CanonicalRuntimeEvent[] = [];
  const coalescer = new DeltaCoalescer((event) => published.push(event), {
    windowMs: 1_000_000,
    setTimer: () => 'timer',
    clearTimer: () => {},
    logger: { warn: vi.fn() },
  });
  return { coalescer, published };
}

/** Offer every event to the coalescer, exactly as the publish seam does. */
function offerAll(
  coalescer: DeltaCoalescer,
  events: CanonicalRuntimeEvent[],
): void {
  for (const event of events) coalescer.offer(event);
}

function deltasOf(events: CanonicalRuntimeEvent[]): CanonicalRuntimeEvent[] {
  return events.filter(
    (event) =>
      event.method === 'content.text-delta' ||
      event.method === 'content.reasoning-delta',
  );
}

function joinedText(events: CanonicalRuntimeEvent[]): string {
  return deltasOf(events)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join('');
}

/**
 * Drain an adapter's event stream until `turn.completed`. Bounded so a
 * regression that stops publishing cannot hang the suite.
 */
async function drainTurn(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  for (let index = 0; index < CHUNKS * 4; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 5_000),
      ),
    ]);
    if (next.done) break;
    events.push(next.value);
    if (next.value?.method === 'turn.completed') break;
  }
  return events;
}

function chunkText(index: number): string {
  return `c${index} `;
}

describe('content deltas coalesce for the events the adapters really emit', () => {
  test('the broken composition this exists to prevent: one itemId per chunk coalesces nothing', () => {
    const { coalescer, published } = collectingCoalescer();
    const perChunkId: CanonicalRuntimeEvent[] = Array.from(
      { length: CHUNKS },
      (_, index) =>
        ({
          method: 'content.text-delta',
          provider: 'bedrock',
          threadId: 'thread-per-chunk',
          turnId: 'turn-1',
          // Exactly what bedrock-adapter and ollama-adapter did before
          // station#3457: minted inside the streaming loop.
          itemId: `random-${index}`,
          delta: chunkText(index),
        }) as unknown as CanonicalRuntimeEvent,
    );

    offerAll(coalescer, perChunkId);
    coalescer.flushAll();

    // 50 in, 50 out. The text is intact and ordering is intact — nothing is
    // broken except the entire point of the feature, which is why no other
    // assertion in this PR could see it.
    expect(deltasOf(published)).toHaveLength(CHUNKS);
    expect(joinedText(published)).toBe(joinedText(perChunkId));
  });

  test('Bedrock: a turn of 50 deltas publishes far fewer events, with the text intact', async () => {
    const llm = {
      createStream: vi.fn(async function* () {
        for (let index = 0; index < CHUNKS; index += 1)
          yield { type: 'text-delta', content: chunkText(index) };
        // station#3545 review round 2: `AiSdkLLMProvider.createStream`
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
      threadId: 'thread-bedrock-coalescing',
      modelId: 'model-a',
    });
    await adapter.sendTurn({
      threadId: 'thread-bedrock-coalescing',
      input: 'stream',
    });
    const streamed = await drainTurn(iterator);
    expect(deltasOf(streamed)).toHaveLength(CHUNKS);

    const { coalescer, published } = collectingCoalescer();
    offerAll(coalescer, streamed);
    coalescer.flushAll();

    // 50 in, 2 out — and 2 is derived, not observed: the first delta of the
    // run paints immediately (first-paint neutrality), and the other 49 merge
    // into the single event the turn boundary flushes. A count that scales
    // with CHUNKS is the inert composition; a count of 1 would mean the first
    // delta had started waiting on the window.
    expect(deltasOf(published)).toHaveLength(2);
    // And nothing was lost or reordered on the way.
    expect(joinedText(published)).toBe(joinedText(streamed));
  });

  test('Ollama: a turn of 50 deltas publishes far fewer events, with the text intact', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        for (let index = 0; index < CHUNKS; index += 1)
          yield { type: 'text-delta', content: chunkText(index) };
        yield { type: 'finish' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as never,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-ollama-coalescing',
      modelId: 'model-a',
    });
    await adapter.sendTurn({
      threadId: 'thread-ollama-coalescing',
      input: 'stream',
    });
    const streamed = await drainTurn(iterator);
    expect(deltasOf(streamed)).toHaveLength(CHUNKS);

    const { coalescer, published } = collectingCoalescer();
    offerAll(coalescer, streamed);
    coalescer.flushAll();

    // Same derivation as the Bedrock case: one painted, 49 merged.
    expect(deltasOf(published)).toHaveLength(2);
    expect(joinedText(published)).toBe(joinedText(streamed));
  });

  test('Claude: 50 chunks of one content block publish far fewer events', () => {
    const record: ClaudeMessageState = {
      session: {
        provider: 'claude',
        threadId: 'thread-claude-coalescing',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      activeTurnId: 'turn-1',
      dispatchedTurnId: 'turn-1',
      lastSessionState: 'running',
    };
    const streamed: CanonicalRuntimeEvent[] = [];
    const publish = (event: CanonicalRuntimeEvent) => streamed.push(event);
    const emit = (message: unknown) =>
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        publish,
        message: message as never,
      });

    emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_a' } },
      uuid: 'u-start',
      session_id: 'sdk-session-1',
    });
    for (let index = 0; index < CHUNKS; index += 1) {
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: chunkText(index) },
        },
        // A distinct SDK uuid per chunk — which is exactly why deriving the
        // itemId from it produced one stream per token.
        uuid: `u-${index}`,
        session_id: 'sdk-session-1',
      });
    }
    expect(deltasOf(streamed)).toHaveLength(CHUNKS);

    const { coalescer, published } = collectingCoalescer();
    offerAll(coalescer, streamed);
    coalescer.flushAll();

    // Same derivation as the Bedrock case: one painted, 49 merged.
    expect(deltasOf(published)).toHaveLength(2);
    expect(joinedText(published)).toBe(joinedText(streamed));
  });
});
