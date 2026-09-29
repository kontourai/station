import { describe, expect, test } from 'vitest';
import {
  MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
  projectToolCompletedDescriptor,
  type ToolCompletedEventDescriptor,
} from '../thread-tool-result-adapter.js';

/** The only production entry: a store descriptor for a `tool.completed` row. */
const project = (
  event: Omit<ToolCompletedEventDescriptor, 'method'>,
): ReturnType<typeof projectToolCompletedDescriptor> =>
  projectToolCompletedDescriptor({ method: 'tool.completed', ...event });

describe('Station Thread tool-result adapter', () => {
  test.each(['success', 'error', 'cancelled'] as const)(
    'retains the exact %s terminal status and event identity',
    (status) => {
      const result = project({
        eventId: `event-${status}`,
        threadId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'same-call',
        toolName: 'shell',
        status,
        output: 'inert output',
      });
      expect(result).toMatchObject({
        state: 'available',
        result: {
          resultId: `event-${status}`,
          terminalStatus: status,
          name: 'shell',
          content: [{ type: 'text', text: 'inert output' }],
          correlations: expect.arrayContaining([
            {
              namespace: 'kontourai.station',
              kind: 'session',
              id: 'session-1',
            },
            { namespace: 'kontourai.station', kind: 'turn', id: 'turn-1' },
            {
              namespace: 'kontourai.station',
              kind: 'event',
              id: `event-${status}`,
            },
          ]),
        },
      });
    },
  );

  // station#1558: Station's `unresolved` has no member of its own in Thread's
  // published enum, but Thread already names this exact case — `unknown`.
  // Folding it into `cancelled` or `error` would export a claim nothing
  // observed, and dropping the descriptor would hide the call entirely.
  test("projects an unresolved descriptor as Thread's own unknown terminal status", () => {
    const projected = projectToolCompletedDescriptor({
      eventId: 'event-unresolved-descriptor',
      threadId: 'session-1',
      turnId: 'turn-1',
      method: 'tool.completed',
      toolCallId: 'open-call',
      toolName: 'shell',
      status: 'unresolved',
    });
    expect(projected).toMatchObject({
      state: 'available',
      result: { terminalStatus: 'unknown' },
    });
    // An unknown status word is still refused.
    expect(
      projectToolCompletedDescriptor({
        eventId: 'event-nonsense',
        threadId: 'session-1',
        method: 'tool.completed',
        toolCallId: 'open-call',
        toolName: 'shell',
        status: 'invented',
      }),
    ).toBeNull();
  });

  test('uses only the exact policyDenied marker and published inert projection', () => {
    const denied = project({
      eventId: 'event-denied',
      threadId: 'session',
      toolCallId: 'call',
      toolName: 'write',
      status: 'error',
      error: 'denied',
      policyDenied: true,
    });
    const ordinary = project({
      eventId: 'event-ordinary',
      threadId: 'session',
      toolCallId: 'call',
      toolName: 'write',
      status: 'error',
      error: 'denied by prose only',
    });
    // Both the denial marker and the error text survive the descriptor entry.
    expect(denied).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'denied' }],
        authorityDecision: {
          decision: 'denied',
          authority: 'kontourai.station',
        },
      },
    });
    expect(ordinary).toMatchObject({ state: 'available' });
    const projected = (
      ordinary as Extract<typeof ordinary, { state: 'available' }>
    ).result;
    expect(projected).not.toHaveProperty('authorityDecision');
    expect(projected).not.toHaveProperty('structuredResult');
  });

  test('keeps repeated call ids distinct by terminal event id and never denies success', () => {
    const first = project({
      eventId: 'event-a',
      threadId: 'session',
      toolCallId: 'same-call',
      toolName: 'shell',
      status: 'success',
      output: 'first',
      policyDenied: true,
    });
    const second = project({
      eventId: 'event-b',
      threadId: 'session',
      toolCallId: 'same-call',
      toolName: 'shell',
      status: 'success',
      output: 'second',
    });
    expect(first).toMatchObject({
      state: 'available',
      result: { resultId: 'event-a' },
    });
    expect(second).toMatchObject({
      state: 'available',
      result: { resultId: 'event-b' },
    });
    expect(
      (first as Extract<typeof first, { state: 'available' }>).result,
    ).not.toHaveProperty('authorityDecision');
  });

  test('rejects malformed or oversized source descriptors before Thread parsing', () => {
    const valid = {
      eventId: 'event',
      threadId: 'session',
      method: 'tool.completed',
      toolCallId: 'call',
      toolName: 'shell',
      status: 'success',
    } as const;
    // Positive controls: the valid descriptor and both at-limit fields pass.
    expect(MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES).toBe(64 * 1024);
    expect(projectToolCompletedDescriptor(valid)).toMatchObject({
      state: 'available',
    });
    expect(
      projectToolCompletedDescriptor({ ...valid, toolName: 'x'.repeat(256) }),
    ).toMatchObject({ state: 'available' });
    expect(
      projectToolCompletedDescriptor({
        ...valid,
        output: 'x'.repeat(MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES),
      }),
    ).toMatchObject({ state: 'available' });
    expect(
      projectToolCompletedDescriptor({ ...valid, method: 'turn.started' }),
    ).toBeNull();
    expect(
      projectToolCompletedDescriptor({ ...valid, eventId: '\ud800' }),
    ).toBeNull();
    expect(
      projectToolCompletedDescriptor({ ...valid, toolName: 'x'.repeat(257) }),
    ).toBeNull();
    expect(
      projectToolCompletedDescriptor({
        ...valid,
        output: 'x'.repeat(MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES + 1),
      }),
    ).toBeNull();
  });

  test('does not carry structured output, URLs, bytes, or tool arguments across the projection', () => {
    const result = project({
      eventId: 'event-safe',
      threadId: 'session',
      toolCallId: 'call',
      toolName: 'shell',
      status: 'success',
      output: {
        url: 'https://private.invalid',
        data: 'base64-secret',
        arguments: { command: 'rm -rf /' },
      },
    });
    expect(result).toMatchObject({
      state: 'available',
      result: { content: [] },
    });
    const projected = (result as Extract<typeof result, { state: 'available' }>)
      .result;
    expect(JSON.stringify(projected)).not.toContain('private.invalid');
    expect(JSON.stringify(projected)).not.toContain('base64-secret');
    expect(JSON.stringify(projected)).not.toContain('rm -rf');
    expect(projected).not.toHaveProperty('toolCallId');
  });
});
