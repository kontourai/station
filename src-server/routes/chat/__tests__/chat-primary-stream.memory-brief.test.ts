/**
 * The private-memory brief rides one turn and is settled by what happens to it:
 * `delivered` the moment the agent is invoked with it, `abandoned` whenever the
 * turn ends without reaching the agent. Exercised through the real
 * `streamPrimaryAgentChat` and a real dedup store, because a replay, a refusal and
 * a first turn are only told apart there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildChatHarnessApp,
  createHarnessConversationStore,
  emptyAgentResult,
} from '../../../__test-utils__/chat-primary-stream-harness.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

describe('streamPrimaryAgentChat memory brief settlement', () => {
  let dir: string;
  let dedupStore: ChatTurnDedupStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-primary-stream-brief-'));
    dedupStore = new ChatTurnDedupStore(join(dir, 'chat-turn-dedup.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const brief = () => ({ delivered: vi.fn(), abandoned: vi.fn() });
  const agentFor = (streamText: ReturnType<typeof vi.fn>) => ({
    getMemory: () => null as null,
    model: { modelId: 'test-model' },
    streamText,
  });
  const run = async (
    app: ReturnType<typeof buildChatHarnessApp>,
    query: string,
  ) => {
    const response = await app.request(`/chat${query}`, { method: 'POST' });
    await response.text();
    return response;
  };

  test('a turn that reaches the agent delivers its brief and does not abandon it', async () => {
    const turn = brief();
    const streamText = vi.fn(async () => emptyAgentResult());
    const app = buildChatHarnessApp({
      agent: agentFor(streamText),
      conversations: createHarnessConversationStore(),
      dedupStore,
      memoryBrief: turn,
    });
    await run(app, '?clientTurnId=k1');
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(turn.delivered).toHaveBeenCalledTimes(1);
    expect(turn.abandoned).not.toHaveBeenCalled();
  });

  test('a replayed turn never reaches the agent, so its brief is abandoned, not delivered', async () => {
    const streamText = vi.fn(async () => emptyAgentResult());
    const first = brief();
    await run(
      buildChatHarnessApp({
        agent: agentFor(streamText),
        conversations: createHarnessConversationStore(),
        dedupStore,
        memoryBrief: first,
      }),
      '?clientTurnId=k2',
    );
    const replay = brief();
    await run(
      buildChatHarnessApp({
        agent: agentFor(streamText),
        conversations: createHarnessConversationStore(),
        dedupStore,
        memoryBrief: replay,
      }),
      '?clientTurnId=k2',
    );
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(first.delivered).toHaveBeenCalledTimes(1);
    expect(replay.delivered).not.toHaveBeenCalled();
    expect(replay.abandoned).toHaveBeenCalled();
  });

  test('a turn refused before the stream starts abandons its brief', async () => {
    const streamText = vi.fn(async () => emptyAgentResult());
    await run(
      buildChatHarnessApp({
        agent: agentFor(streamText),
        conversations: createHarnessConversationStore(),
        dedupStore,
        input: 'first',
      }),
      '?clientTurnId=k3',
    );
    // The same key with different input is refused with a 409 before any stream.
    const refused = brief();
    const response = await run(
      buildChatHarnessApp({
        agent: agentFor(streamText),
        conversations: createHarnessConversationStore(),
        dedupStore,
        memoryBrief: refused,
        input: 'second',
      }),
      '?clientTurnId=k3',
    );
    expect(response.status).toBe(409);
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(refused.delivered).not.toHaveBeenCalled();
    expect(refused.abandoned).toHaveBeenCalledTimes(1);
  });

  test('an agent that fails after it was invoked still counts as delivered', async () => {
    const turn = brief();
    const streamText = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const app = buildChatHarnessApp({
      agent: agentFor(streamText),
      conversations: createHarnessConversationStore(),
      dedupStore,
      memoryBrief: turn,
    });
    await run(app, '?clientTurnId=k4');
    expect(turn.delivered).toHaveBeenCalledTimes(1);
    expect(turn.abandoned).not.toHaveBeenCalled();
  });
});
