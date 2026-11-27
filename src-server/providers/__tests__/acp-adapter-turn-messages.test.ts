import { describe, expect, test } from 'vitest';
import { ACP_TURN_MESSAGES_MAX, AcpAdapter } from '../adapters/acp-adapter.js';

/**
 * The turn ledger rewind and fork read. Fed the engine's real
 * `user_message_id_assigned` update shape, through the adapter's own recorder
 * (the one its session client calls on every `session/update`).
 */
const assigned = (userMessageId: string) => ({
  sessionUpdate: 'session_info_update',
  _meta: { kiro: { kind: 'user_message_id_assigned', userMessageId } },
});

function recorder() {
  const adapter = new AcpAdapter({ getConnections: async () => [] });
  const record: {
    activeTurnId?: string;
    turnMessages?: Array<{
      turnId: string;
      firstMessageId: string;
      lastMessageId: string;
    }>;
  } = {};
  const feed = (turnId: string, id: string) => {
    record.activeTurnId = turnId;
    (
      adapter as unknown as {
        recordTurnMessage: (record: unknown, update: unknown) => void;
      }
    ).recordTurnMessage(record, assigned(id));
  };
  return { record, feed };
}

describe('the ACP turn message ledger', () => {
  test('a steer keeps the turn’s first id and moves its last', () => {
    const { record, feed } = recorder();
    feed('t1', 'msg-1');
    feed('t1', 'msg-2');
    expect(record.turnMessages).toEqual([
      { turnId: 't1', firstMessageId: 'msg-1', lastMessageId: 'msg-2' },
    ]);
  });

  test(`keeps the last ${ACP_TURN_MESSAGES_MAX} turns`, () => {
    expect(ACP_TURN_MESSAGES_MAX).toBe(500);
    const { record, feed } = recorder();
    for (let i = 0; i <= ACP_TURN_MESSAGES_MAX; i++) feed(`t${i}`, `m${i}`);
    expect(record.turnMessages).toHaveLength(ACP_TURN_MESSAGES_MAX);
    expect(record.turnMessages?.[0]?.turnId).toBe('t1');
    expect(record.turnMessages?.at(-1)?.turnId).toBe(
      `t${ACP_TURN_MESSAGES_MAX}`,
    );
  });
});
