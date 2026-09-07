import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Thread, threadFromJson, threadToJson } from '@kontourai/thread';
import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../conversation-message.js';
import { projectRuntimeEventsToMessages } from '../runtime-event-projection.js';
import {
  conversationAssistantMessageToStationAnswerBinding,
  conversationToThread,
} from '../thread-projection.js';

const base = {
  provider: 'claude',
  threadId: 't1',
  createdAt: '2026-06-27T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

describe('conversationToThread', () => {
  it('projects the REAL folded shape (runtime events → messages → thread) losslessly', () => {
    // Chained through the actual runtime-event projection so this test
    // breaks if the folded shape and this projection ever drift apart.
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'list files' }),
      ev({
        method: 'content.reasoning-delta',
        itemId: 'i0',
        delta: 'ls will do',
      }),
      ev({ method: 'content.text-delta', itemId: 'i1', delta: 'Let me ' }),
      ev({ method: 'content.text-delta', itemId: 'i1', delta: 'check.' }),
      ev({
        method: 'tool.started',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'ls',
        arguments: { path: '.' },
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'ls',
        status: 'success',
        output: 'a.txt\nb.txt',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const thread = conversationToThread(messages, {
      threadId: 'conv-1',
      title: 'List files',
      createdAt: 1750982400000,
    });

    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe('conv-1');
    expect(thread.metadata?.source).toBe('station');
    expect(thread.metadata?.title).toBe('List files');

    const roles = thread.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);

    const assistant = thread.messages[1];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    const types = assistant.content.map((c) => c.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('text');
    expect(types).toContain('tool_call');
    const call = assistant.content.find((c) => c.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('expected tool_call');
    expect(call.toolCall.id).toBe('c1');
    expect(call.toolCall.name).toBe('ls');
    expect(call.toolCall.parsedArguments).toEqual({ path: '.' });

    const tool = thread.messages[2];
    if (tool?.role !== 'tool') throw new Error('expected tool');
    expect(tool.toolResults[0]?.toolCallId).toBe('c1');
    expect(tool.toolResults[0]?.content[0]).toEqual({
      type: 'text',
      text: 'a.txt\nb.txt',
    });
  });

  it('prefers the runtime-reported model over the requested one', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi' }],
        metadata: {
          timestamp: 1750982401000,
          model: 'requested-model',
          reportedModel: 'observed-model',
        },
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'again' }],
        metadata: { timestamp: 1750982402000, model: 'requested-model' },
      },
    ];
    const thread = conversationToThread(messages, { threadId: 'conv-2' });
    const [first, second] = thread.messages;
    if (first?.role !== 'assistant' || second?.role !== 'assistant') {
      throw new Error('expected assistants');
    }
    expect(first.model).toBe('observed-model');
    expect(second.model).toBe('requested-model');
  });

  it('maps files, system messages, error tools, and carries turnId', () => {
    const messages: ConversationMessage[] = [
      {
        id: 's1',
        role: 'system',
        parts: [{ type: 'text', text: 'be terse' }],
        metadata: { timestamp: 1750982400000 },
      },
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'read this' },
          {
            type: 'file',
            url: 'data:application/pdf;base64,AAAA',
            mediaType: 'application/pdf',
            name: 'spec.pdf',
          },
        ],
        metadata: { timestamp: 1750982401000 },
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolCallId: 'c9',
            toolName: 'bash',
            args: { command: 'exit 1' },
            state: 'error',
            result: 'boom',
            isError: true,
          },
        ],
        metadata: { timestamp: 1750982402000, turnId: 'turn-9' },
      },
    ];
    const thread = conversationToThread(messages, { threadId: 'conv-3' });
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    const user = thread.messages[1];
    if (user?.role !== 'user') throw new Error('expected user');
    expect(user.content[1]).toEqual({
      type: 'file',
      name: 'spec.pdf',
      mediaType: 'application/pdf',
      data: 'data:application/pdf;base64,AAAA',
    });
    const assistant = thread.messages[2];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    expect(assistant.metadata?.turnId).toBe('turn-9');
    const tool = thread.messages[3];
    if (tool?.role !== 'tool') throw new Error('expected tool');
    expect(tool.toolResults[0]).toEqual({
      toolCallId: 'c9',
      name: 'bash',
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });

  // station#1558 (fix round, M5): an unresolved call carries a `result` — the
  // sentence saying no result was reported — so it used to export as an
  // ordinary tool result with no marker at all, i.e. as a success whose
  // output happened to be that sentence.
  it('exports an unresolved tool call with an unknown terminal status, not as a plain success', () => {
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolCallId: 'c-open',
              toolName: 'bash',
              args: { command: 'sleep 100' },
              state: 'unresolved',
              sourceEventId: 'evt-open',
              result:
                'No result was reported before the session ended; whether the tool ran is unknown.',
            },
          ],
          metadata: { timestamp: 1750982402000, turnId: 'turn-open' },
        },
      ],
      { threadId: 'conv-unresolved' },
    );
    expect(Thread.parse(thread)).toBeTruthy();
    const tool = thread.messages.find((message) => message.role === 'tool');
    if (tool?.role !== 'tool') throw new Error('expected tool');
    expect(tool.toolResults[0]).toMatchObject({
      toolCallId: 'c-open',
      resultId: 'evt-open',
      terminalStatus: 'unknown',
    });
    // Not a failure either — nothing observed the tool fail.
    expect(tool.toolResults[0]?.isError).toBeUndefined();
  });

  // Thread cannot carry `terminalStatus` without the result id it names, so
  // the fallback must be an ABSENT result, never a bare one (which reads as
  // a success whose output is the "no result" sentence).
  it('exports no tool result at all for an unresolved call with no terminal event id', () => {
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolCallId: 'c-open',
              toolName: 'bash',
              args: { command: 'sleep 100' },
              state: 'unresolved',
              result: 'No result was reported before the session ended.',
            },
          ],
          metadata: { timestamp: 1750982402000, turnId: 'turn-open' },
        },
      ],
      { threadId: 'conv-unresolved-anon' },
    );
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.messages.some((message) => message.role === 'tool')).toBe(
      false,
    );
    // The call itself is still exported — the reader sees a call with no
    // result, which is exactly what happened.
    const assistant = thread.messages.find(
      (message) => message.role === 'assistant',
    );
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    expect(assistant.content.some((entry) => entry.type === 'tool_call')).toBe(
      true,
    );
  });

  it('projects the persisted Strands nested invocation and separate result shapes', () => {
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'strands-call',
                toolName: 'read_file',
                args: { path: 'README.md' },
                state: 'result',
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'strands-call',
              result: [{ text: 'contents' }],
            } as any,
          ],
          metadata: { timestamp: 1750982400000 },
        },
      ],
      { threadId: 'conv-strands' },
    );

    const assistant = thread.messages[0];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    const call = assistant.content.find((part) => part.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('expected tool call');
    expect(call.toolCall).toMatchObject({
      id: 'strands-call',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
      parsedArguments: { path: 'README.md' },
    });
    const tool = thread.messages[1];
    if (tool?.role !== 'tool') throw new Error('expected tool result');
    expect(tool.toolResults).toEqual([
      {
        toolCallId: 'strands-call',
        name: 'read_file',
        content: [{ type: 'text', text: '[{"text":"contents"}]' }],
      },
    ]);
  });

  it('passes a string tool-call args through unchanged instead of double-encoding it (station#3542)', () => {
    // ACP's resolveToolArguments, and runtime events where
    // ToolStartedEvent.arguments is contract-typed `unknown`, both hand back
    // args that are already a string (e.g. a shell command). Re-stringifying
    // it wraps it in an extra layer of quotes.
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolCallId: 'call-1',
              toolName: 'bash',
              args: 'git commit -m "fix"',
              state: 'call',
            },
          ],
          metadata: { timestamp: 1750982400000 },
        },
      ],
      { threadId: 'conv-string-args' },
    );

    const assistant = thread.messages[0];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    const call = assistant.content.find((part) => part.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('expected tool call');
    expect(call.toolCall.arguments).toBe('git commit -m "fix"');
    // Not JSON, so there is no structured form to recover.
    expect(call.toolCall.parsedArguments).toBeUndefined();
  });

  it('recovers parsedArguments from a JSON-encoded string args value', () => {
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolCallId: 'call-1',
              toolName: 'read_file',
              args: '{"path":"README.md"}',
              state: 'call',
            },
          ],
          metadata: { timestamp: 1750982400000 },
        },
      ],
      { threadId: 'conv-json-string-args' },
    );

    const assistant = thread.messages[0];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    const call = assistant.content.find((part) => part.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('expected tool call');
    // The raw string passes through unchanged...
    expect(call.toolCall.arguments).toBe('{"path":"README.md"}');
    // ...and the structured form is recovered for parsedArguments.
    expect(call.toolCall.parsedArguments).toEqual({ path: 'README.md' });
  });

  // station#3542 fix round (independent review finding 7): `asPlainRecord`
  // excludes arrays, so an array args value has no `parsedArguments` either
  // — same as a non-JSON string — even though it IS a real, non-string
  // input. Pins that an array is not mistaken for "an object input, which
  // always has one."
  it('has no parsedArguments for an array args value, same as a non-JSON string', () => {
    const thread = conversationToThread(
      [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-invocation',
              toolCallId: 'call-1',
              toolName: 'batch',
              args: ['a', 'b'],
              state: 'call',
            },
          ],
          metadata: { timestamp: 1750982400000 },
        },
      ],
      { threadId: 'conv-array-args' },
    );

    const assistant = thread.messages[0];
    if (assistant?.role !== 'assistant') throw new Error('expected assistant');
    const call = assistant.content.find((part) => part.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('expected tool call');
    expect(call.toolCall.arguments).toBe('["a","b"]');
    expect(call.toolCall.parsedArguments).toBeUndefined();
  });

  it('avoids real message ids when allocating synthetic ids and skips empty text', () => {
    const thread = conversationToThread(
      [
        {
          id: 'conv-ids:1',
          role: 'user',
          parts: [{ type: 'text', text: 'real id' }],
          metadata: { timestamp: 1750982400000 },
        },
        {
          id: '',
          role: 'assistant',
          parts: [{ type: 'text', text: 'kept' }],
          metadata: { timestamp: 1750982401000 },
        },
      ],
      { threadId: 'conv-ids' },
    );

    expect(thread.messages).toEqual([
      expect.objectContaining({ id: 'conv-ids:1', role: 'user' }),
      expect.objectContaining({ id: 'conv-ids:2', role: 'assistant' }),
    ]);
  });

  it('inherits timestamps from the previous message, then createdAt', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'no stamp' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'me neither' }],
      },
    ];
    const thread = conversationToThread(messages, {
      threadId: 'conv-4',
      createdAt: 1750982400000,
    });
    expect(thread.messages[0]?.timestamp).toBe(1750982400000);
    expect(thread.messages[1]?.timestamp).toBe(1750982400000);
    expect(thread.createdAt).toBe(1750982400000);
  });

  it('round-trips through canonical thread JSON', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'q' }],
        metadata: { timestamp: 1750982400000 },
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'a' }],
        metadata: { timestamp: 1750982401000 },
      },
    ];
    const thread = conversationToThread(messages, { threadId: 'conv-5' });
    const restored = threadFromJson(threadToJson(thread));
    expect(restored).toEqual(thread);
  });

  it('skips empty conversations gracefully (valid empty thread)', () => {
    const thread = conversationToThread([], {
      threadId: 'conv-6',
      createdAt: 1750982400000,
    });
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.messages).toEqual([]);
  });

  it('binds the same exact assistant message id that the general export uses', () => {
    const message: ConversationMessage = {
      id: 'observed-assistant-message',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
      metadata: { turnId: 'turn-a', timestamp: 1750982400000 },
    };
    const binding = conversationAssistantMessageToStationAnswerBinding(
      message,
      'session-a',
    );
    const thread = conversationToThread([message], { threadId: 'session-a' });
    expect(binding?.answer.messageId).toBe(thread.messages[0]?.id);
    expect(binding?.answer.threadId).toBe('session-a');
    expect(
      conversationAssistantMessageToStationAnswerBinding(
        { ...message, metadata: undefined },
        'session-a',
      ),
    ).toBeNull();
  });
});
