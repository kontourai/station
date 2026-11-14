/**
 * Qwen Code nested subagents at a prompt end: only the ending turn's own
 * children are settled (`settleAcpNestedSubagentsAtPromptEnd`, called by
 * the ACP adapter at every prompt end with that turn as `activeTurnId`).
 */
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { describe, expect, test } from 'vitest';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import {
  type AcpChildWorkState,
  settleAcpNestedSubagentsAtPromptEnd,
} from '../adapters/acp-child-work.js';

function child(id: string, turnId: string | undefined): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: 'thread-qwen',
    childId: id,
    status: 'running',
    workKind: 'agent',
    parent: {
      threadId: 'thread-qwen',
      ...(turnId ? { turnId } : {}),
      toolCallId: id,
    },
    kindLabel: 'Explore',
  };
}

function deltas(events: CanonicalRuntimeEvent[]) {
  return events.map(
    (event) => (event as { delta: Record<string, unknown> }).delta,
  );
}

describe('settleAcpNestedSubagentsAtPromptEnd', () => {
  test("settles the ending turn's children and leaves another turn's running", () => {
    const state: AcpChildWorkState = {
      acpSubagentWires: new Set(['nested-tool-call']),
      acpNestedSubagents: new Map([
        ['call_turn_a', child('call_turn_a', 'turn-a')],
        ['call_turn_b', child('call_turn_b', 'turn-b')],
      ]),
    };
    const events: CanonicalRuntimeEvent[] = [];
    settleAcpNestedSubagentsAtPromptEnd(
      {
        session: { threadId: 'thread-qwen' },
        activeTurnId: 'turn-b',
        publish: (event) => events.push(event),
        state,
      },
      'cancelled',
    );
    expect(deltas(events)).toMatchObject([
      { kind: 'settle', childId: 'call_turn_b', status: 'cancelled' },
      // The running set still lists the other turn's child.
      { kind: 'snapshot', running: [{ childId: 'call_turn_a' }] },
    ]);
    expect([...state.acpNestedSubagents!.keys()]).toEqual(['call_turn_a']);
    expect(state.acpSettledNestedSubagents?.has('call_turn_b')).toBe(true);
    expect(state.acpSettledNestedSubagents?.has('call_turn_a')).toBeFalsy();
  });

  test('publishes nothing when no listed child belongs to the ending turn', () => {
    const state: AcpChildWorkState = {
      acpSubagentWires: new Set(['nested-tool-call']),
      acpNestedSubagents: new Map([
        ['call_turn_a', child('call_turn_a', 'turn-a')],
      ]),
    };
    const events: CanonicalRuntimeEvent[] = [];
    settleAcpNestedSubagentsAtPromptEnd(
      {
        session: { threadId: 'thread-qwen' },
        activeTurnId: 'turn-b',
        publish: (event) => events.push(event),
        state,
      },
      'unresolved',
    );
    expect(events).toEqual([]);
    expect(state.acpNestedSubagents?.size).toBe(1);
  });
});
