/**
 * Qwen Code nested subagents in `acp-child-work.ts`: a prompt end settles
 * only the ending turn's own children (`settleAcpNestedSubagentsAtPromptEnd`,
 * which the ACP adapter calls with that turn as `activeTurnId`), and the
 * memory of settled children that keeps late frames out is bounded.
 */
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { describe, expect, test } from 'vitest';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import {
  type AcpChildWorkState,
  publishAcpNestedSubagentFrame,
  settleAcpNestedSubagent,
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

  test('the settled-id memory is bounded at 1024, oldest out', () => {
    // Each child listed by its own subagent frame, then ended by its Agent
    // call's result, as the adapter routes them.
    const state: AcpChildWorkState = {
      acpSubagentWires: new Set(['nested-tool-call']),
    };
    const ctx = {
      session: { threadId: 'thread-qwen' },
      activeTurnId: 'turn-a',
      publish: () => {},
      state,
    };
    for (let index = 0; index < 1025; index += 1) {
      const id = `call_${index}`;
      publishAcpNestedSubagentFrame(
        {
          sessionUpdate: 'tool_call',
          toolCallId: `nested_${index}`,
          _meta: { provenance: 'subagent', parentToolCallId: id },
        },
        ctx,
      );
      // The Agent call's `tool_call_update` end, as the settle reads it.
      settleAcpNestedSubagent(
        {
          toolCallId: id,
          status: 'completed',
        },
        ctx,
      );
    }
    const settled = state.acpSettledNestedSubagents!;
    expect(settled.size).toBe(1024);
    expect(settled.has('call_0')).toBe(false);
    expect(settled.has('call_1')).toBe(true);
    expect(settled.has('call_1024')).toBe(true);
    expect(state.acpNestedSubagents?.size).toBe(0);
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
