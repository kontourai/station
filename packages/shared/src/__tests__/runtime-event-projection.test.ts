import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import { projectRuntimeEventsToMessages } from '../runtime-event-projection.js';

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

describe('projectRuntimeEventsToMessages', () => {
  it('preserves simultaneous terminal results sharing one toolCallId by event identity', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r-same-call',
        prompt: 'run twice',
      }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'same-call',
        toolName: 'shell',
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'same-call',
        toolName: 'shell',
        status: 'success',
        output: 'first',
        eventId: 'result-a',
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'same-call',
        toolName: 'shell',
        status: 'error',
        error: 'second',
        eventId: 'result-b',
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r-same-call',
        finishReason: 'stop',
      }),
    ]);
    const tools = messages[1]!.parts.filter(
      (part) => part.type === 'tool-invocation',
    );
    expect(tools).toHaveLength(2);
    expect(tools.map((part) => part.sourceEventId)).toEqual([
      'result-a',
      'result-b',
    ]);
    expect(tools.map((part) => part.result ?? part.error)).toEqual([
      'first',
      'second',
    ]);
  });

  it('projects a text + tool turn into a user message and an assistant message with parts', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'list files' }),
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

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'list files' }],
    });

    const assistant = messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.parts.map((p) => p.type)).toEqual([
      'text',
      'tool-invocation',
    ]);
    expect(assistant.parts[0]).toMatchObject({
      type: 'text',
      text: 'Let me check.',
    });
    expect(assistant.parts[1]).toMatchObject({
      type: 'tool-invocation',
      toolCallId: 'c1',
      toolName: 'ls',
      state: 'result',
      result: 'a.txt\nb.txt',
    });
  });

  // station#3117: rehydration must show the same distinct state a live
  // session showed — the projection derives it ONLY from the event's own
  // `policyDenied` marker, mirroring `handleToolCompletedEvent`
  // (src-ui/src/hooks/orchestration/streamHandlers.ts).
  it('carries a policy-denied tool call through rehydration with approvalStatus set', () => {
    const reason =
      "Tool 'write_file' was blocked by the config-protection policy: writes require review";
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'edit config' }),
      ev({
        method: 'tool.started',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        arguments: { path: 'config.json' },
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        status: 'error',
        error: reason,
        policyDenied: true,
      } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const assistant = messages[1];
    expect(assistant.parts[0]).toMatchObject({
      type: 'tool-invocation',
      toolCallId: 'c1',
      approvalStatus: 'policy-denied',
      error: reason,
      state: 'error',
      isError: true,
    });
  });

  // Negative control: an ordinary (non-policy) failed tool call must NOT
  // gain approvalStatus after rehydration — absence of the marker means
  // "unknown why it failed", never "policy denied it".
  it('leaves an ordinary failed tool call with no approvalStatus after rehydration', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'edit config' }),
      ev({
        method: 'tool.started',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        arguments: { path: 'config.json' },
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        status: 'error',
        error: 'Tool call failed.',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const assistant = messages[1];
    expect(assistant.parts[0]).toMatchObject({
      type: 'tool-invocation',
      state: 'error',
      isError: true,
    });
    expect(
      (assistant.parts[0] as { approvalStatus?: string }).approvalStatus,
    ).toBeUndefined();
  });

  // Same marker, the OTHER projection branch: a tool.completed with no
  // matching tool.started (a replay gap) still surfaces policyDenied.
  it('carries policy-denied through the no-captured-start replay-gap branch too', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'edit config' }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        status: 'error',
        error: 'blocked by policy',
        policyDenied: true,
      } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const assistant = messages[1];
    expect(assistant.parts.at(-1)).toMatchObject({
      type: 'tool-invocation',
      toolCallId: 'c1',
      approvalStatus: 'policy-denied',
    });
  });

  it('falls back to turn.completed outputText when no deltas were streamed', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'turn.completed',
        turnId: 'r1',
        finishReason: 'stop',
        outputText: 'Hi!',
      }),
    ]);
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi!' }],
      }),
    ]);
  });

  it('reconstructs session-scoped attachments when transcript events reload', () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'What is this?',
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 5,
            dataUrl: image,
          },
        ],
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    expect(messages[0]).toMatchObject({
      role: 'user',
      parts: [
        { type: 'text', text: 'What is this?' },
        {
          type: 'file',
          url: image,
          mediaType: 'image/png',
          name: 'screen.png',
        },
      ],
    });
    expect(Object.hasOwn(messages[0].parts[1], 'blobRef')).toBe(false);
  });

  it('keeps an attachment whose bytes this read does not carry (#3374)', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'What is this?',
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 5,
            blobRef: `sha256-${'0'.repeat(64)}`,
          },
        ],
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const parts = messages[0].parts;
    // The chip's identity survives, so the transcript still shows that the
    // turn carried this file. Dropping the part would turn a reclaimed
    // attachment into a turn that never had one.
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      type: 'file',
      // The reference rides along so the client can fetch the bytes from
      // `GET /api/attachments/:ref` (station#3385). Without it the chip could
      // never become a picture again after a reload.
      blobRef: `sha256-${'0'.repeat(64)}`,
      mediaType: 'image/png',
      name: 'screen.png',
    });
    expect(Object.hasOwn(parts[1], 'url')).toBe(false);
  });

  it('marks a failed tool as error and keeps its output', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'write',
        arguments: {},
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'write',
        status: 'error',
        error: 'permission denied',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
    ]);
    const part = messages[0].parts[0];
    expect(part).toMatchObject({
      type: 'tool-invocation',
      state: 'error',
      isError: true,
      result: 'permission denied',
      error: 'permission denied',
    });
  });

  // station#3167: mirrors streamHandlers.test.ts's live-side
  // "a cancelled tool call renders the cancelled state..." assertion, so
  // the parity between the live and rehydrated paths is pinned in both
  // directions rather than just the live side. Cancelling is a correct
  // user-initiated outcome, not a failure — `isError` must stay false.
  // station#1558: the third terminal shape. `success`/`error`/`cancelled` all
  // assert what happened; `unresolved` asserts that nothing ever will.
  it('marks an unresolved tool call as unresolved — neither error nor cancelled', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r-unresolved', prompt: 'run it' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c-unresolved',
        toolName: 'Bash',
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'c-unresolved',
        toolName: 'Bash',
        status: 'unresolved',
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r-unresolved',
        finishReason: 'stop',
      }),
    ]);

    const tool = messages[1]!.parts.find(
      (part) => part.type === 'tool-invocation',
    )!;
    expect(tool.state).toBe('unresolved');
    expect(tool.isError).toBe(false);
    expect(tool.cancelled).toBe(false);
    expect(tool.result).toBe(
      'No result was reported before the session ended; whether the tool ran is unknown.',
    );
  });

  it('marks an unresolved tool call through the no-captured-start replay-gap branch too', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r-gap', prompt: 'run it' }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'c-gap',
        toolName: 'Bash',
        status: 'unresolved',
        output: 'No result was reported before the session ended.',
      }),
      ev({ method: 'turn.completed', turnId: 'r-gap', finishReason: 'stop' }),
    ]);

    const tool = messages[1]!.parts.find(
      (part) => part.type === 'tool-invocation',
    )!;
    expect(tool.state).toBe('unresolved');
    expect(tool.isError).toBe(false);
    expect(tool.cancelled).toBe(false);
  });

  it('marks a cancelled tool as cancelled, not error, and keeps isError false', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'write',
        arguments: {},
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'write',
        status: 'cancelled',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
    ]);
    const part = messages[0].parts[0];
    expect(part).toMatchObject({
      type: 'tool-invocation',
      state: 'cancelled',
      isError: false,
      cancelled: true,
    });
  });

  // Same rule for the no-captured-start replay-gap branch (mirrors 'marks
  // a failed tool as error and keeps its output' and the policy-denied
  // replay-gap test above).
  it('marks a cancelled tool as cancelled through the no-captured-start replay-gap branch too', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.completed',
        itemId: 'i2',
        toolCallId: 'c1',
        toolName: 'write_file',
        status: 'cancelled',
      } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const assistant = messages[0];
    expect(assistant.parts.at(-1)).toMatchObject({
      type: 'tool-invocation',
      toolCallId: 'c1',
      state: 'cancelled',
      isError: false,
      cancelled: true,
    });
  });

  it('surfaces runtime errors inline instead of rendering blank', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        message: 'model timeout',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
    ]);
    // station#3769: the `runtimeError` flag is what the chat dock's
    // one-failure-one-surface arbitration matches on. The `⚠️` is display
    // copy; the flag is the fact, and it must be on EVERY part this path
    // writes (including the compacted ones below).
    expect(messages[0].parts).toEqual([
      { type: 'text', text: '⚠️ model timeout', runtimeError: true },
    ]);
  });

  // #765 A1: the structured code rides beside the prose so a rehydrated
  // failure can be translated exactly like the live one (the live SSE path
  // classifies on `RuntimeErrorEvent.code`; without this field the replay
  // could only ever show the engine's raw error text — e.g. a verbatim
  // "No conversation found with session ID: <uuid>").
  it('carries the runtime error code on the projected part when the event has one', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        code: 'engine-session-binding-dead',
        message: 'No conversation found with session ID: abc-123',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
    ]);
    expect(messages[0].parts).toEqual([
      {
        type: 'text',
        text: '⚠️ No conversation found with session ID: abc-123',
        runtimeError: true,
        runtimeErrorCode: 'engine-session-binding-dead',
      },
    ]);
  });

  it('keeps the code on a compacted repeated runtime-error part', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        code: 'engine-session-binding-dead',
        message: 'No conversation found with session ID: abc-123',
      }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        code: 'engine-session-binding-dead',
        message: 'No conversation found with session ID: abc-123',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
    ]);
    expect(messages[0].parts).toEqual([
      {
        type: 'text',
        text: '⚠️ No conversation found with session ID: abc-123 (repeated 2×)',
        runtimeError: true,
        runtimeErrorCode: 'engine-session-binding-dead',
      },
    ]);
  });

  it('compacts only identical consecutive runtime errors in one assistant turn', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        message: 'model timeout',
      }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        message: 'model timeout',
      }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        message: 'connection reset',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'other' }),
      ev({ method: 'turn.started', turnId: 'r2' }),
      ev({
        method: 'runtime.error',
        severity: 'error',
        message: 'connection reset',
      }),
      ev({ method: 'turn.completed', turnId: 'r2', finishReason: 'other' }),
    ]);

    expect(messages[0].parts).toEqual([
      {
        type: 'text',
        text: '⚠️ model timeout (repeated 2×)',
        runtimeError: true,
      },
      { type: 'text', text: '⚠️ connection reset', runtimeError: true },
    ]);
    expect(messages[1].parts).toEqual([
      { type: 'text', text: '⚠️ connection reset', runtimeError: true },
    ]);
  });

  it('is deterministic and ignores content-free events', () => {
    const seq: CanonicalRuntimeEvent[] = [
      ev({ method: 'session.started' }),
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'hi' }),
      ev({ method: 'token-usage.updated', turnId: 'r1' }),
      ev({ method: 'content.text-delta', itemId: 'i1', delta: 'yo' }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ];
    expect(projectRuntimeEventsToMessages(seq)).toEqual(
      projectRuntimeEventsToMessages(seq),
    );
    const out = projectRuntimeEventsToMessages(seq);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('preserves stable turn identity and tool approval fidelity for bounded windows', () => {
    const started = ev({
      method: 'turn.started',
      turnId: 'r-window',
      prompt: 'inspect it',
      metadata: {
        effectiveModel: 'gpt-5.4',
        effectiveModelOptions: { effort: 'high' },
      },
    });
    const messages = projectRuntimeEventsToMessages(
      [
        started,
        ev({
          method: 'content.reasoning-delta',
          itemId: 'reasoning',
          delta: 'check ',
        }),
        ev({
          method: 'content.text-delta',
          itemId: 'text',
          delta: 'Working. ',
        }),
        ev({
          method: 'tool.started',
          itemId: 'tool',
          toolCallId: 'call-1',
          toolName: 'write_file',
          arguments: { path: 'result.txt' },
        }),
        ev({
          method: 'tool.progress',
          itemId: 'tool',
          toolCallId: 'call-1',
          message: 'Writing',
        }),
        ev({
          method: 'request.opened',
          requestId: 'approval-1',
          requestType: 'approval',
          title: 'Allow write',
          payload: { toolCallId: 'call-1' },
        }),
        ev({
          method: 'request.resolved',
          requestId: 'approval-1',
          status: 'approved',
        }),
        ev({
          method: 'tool.completed',
          itemId: 'tool',
          toolCallId: 'call-1',
          toolName: 'write_file',
          status: 'success',
          output: { bytes: 12 },
        }),
        ev({ method: 'turn.completed', turnId: 'r-window' }),
      ],
      { stableIds: true },
    );

    expect(messages.map((message) => message.id)).toEqual([
      `${started.eventId}:user`,
      `${started.eventId}:assistant`,
    ]);
    expect(messages[1]).toMatchObject({
      metadata: {
        turnId: 'r-window',
        model: 'gpt-5.4',
        modelOptions: { effort: 'high' },
      },
      parts: [
        { type: 'reasoning', text: 'check ' },
        { type: 'text', text: 'Working. ' },
        {
          type: 'tool-invocation',
          toolCallId: 'call-1',
          toolName: 'write_file',
          args: { path: 'result.txt' },
          result: '{"bytes":12}',
          output: { bytes: 12 },
          state: 'result',
          progressMessage: 'Writing',
          needsApproval: false,
          approvalId: 'approval-1',
          approvalStatus: 'user-approved',
        },
      ],
    });
  });

  it('keeps provider-confirmed model identity and options on the restored assistant turn', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r-model',
        prompt: 'solve it',
        metadata: {
          effectiveModel: 'claude-opus-4-6',
          effectiveModelOptions: { effort: 'high', fastMode: true },
        },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r-model',
        finishReason: 'stop',
        outputText: 'done',
      }),
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      metadata: {
        model: 'claude-opus-4-6',
        modelOptions: { effort: 'high', fastMode: true },
      },
    });
  });

  it('station#1182: carries a turn.completed-reported model distinct from the requested one', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r-report',
        prompt: 'solve it',
        metadata: { effectiveModel: 'claude-fable-5' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r-report',
        finishReason: 'stop',
        outputText: 'done',
        metadata: { reportedModel: 'claude-opus-4-5-20260101' },
      }),
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      metadata: {
        model: 'claude-fable-5',
        reportedModel: 'claude-opus-4-5-20260101',
      },
    });
    expect(messages[1].metadata?.model).not.toBe(
      messages[1].metadata?.reportedModel,
    );
  });

  it('station#1182: session.configured reportedModel persists as a fallback across a turn that reports nothing itself, and is invalidated once the model changes generation without its own reportedModel', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'session.configured',
        sessionId: 't1',
        metadata: {
          effectiveModel: 'gpt-5-codex',
          reportedModel: 'gpt-5.1-codex-engine-default',
        },
      }),
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'first',
        metadata: { effectiveModel: 'gpt-5-codex' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r1',
        finishReason: 'stop',
        outputText: 'ok',
      }),
    ]);

    expect(messages[1]).toMatchObject({
      role: 'assistant',
      metadata: { reportedModel: 'gpt-5.1-codex-engine-default' },
    });

    // station#1182 fix round: a later turn on a DIFFERENT model, itself
    // reporting nothing, must not keep surfacing the earlier generation's
    // reportedModel as if it confirms the new one — the fallback is
    // invalidated the moment the model generation moves without a fresh
    // reportedModel of its own (this is the review-found HIGH; the prior
    // version of this test never exercised a second turn at all, despite
    // its title claiming clearing behavior it did not check).
    const switched = projectRuntimeEventsToMessages([
      ev({
        method: 'session.configured',
        sessionId: 't1',
        metadata: {
          effectiveModel: 'gpt-5-codex',
          reportedModel: 'gpt-5.1-codex-engine-default',
        },
      }),
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'first',
        metadata: { effectiveModel: 'gpt-5-codex' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r1',
        finishReason: 'stop',
        outputText: 'ok',
      }),
      ev({
        method: 'turn.started',
        turnId: 'r2',
        prompt: 'second, after a switch',
        metadata: { effectiveModel: 'gpt-5.1-codex' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r2',
        finishReason: 'stop',
        outputText: 'ok again',
      }),
    ]);

    const secondAssistant = switched[switched.length - 1];
    expect(secondAssistant.metadata?.model).toBe('gpt-5.1-codex');
    expect('reportedModel' in (secondAssistant.metadata ?? {})).toBe(false);
  });

  it('station#1182: no reportedModel anywhere in the stream means no reportedModel on the message (absent, not defaulted)', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'hi',
        metadata: { effectiveModel: 'anthropic.claude-opus-4-5' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r1',
        finishReason: 'stop',
        outputText: 'hello',
      }),
    ]);

    const assistant = messages[messages.length - 1];
    expect(assistant.metadata?.model).toBe('anthropic.claude-opus-4-5');
    expect('reportedModel' in (assistant.metadata ?? {})).toBe(false);
  });

  it("station#1182: a turn.started's own reportedModel wins over the session.configured fallback for that turn", () => {
    const messages = projectRuntimeEventsToMessages([
      ev({
        method: 'session.configured',
        sessionId: 't1',
        metadata: { reportedModel: 'session-level-default' },
      }),
      ev({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'hi',
        metadata: { reportedModel: 'turn-specific-override' },
      }),
      ev({
        method: 'turn.completed',
        turnId: 'r1',
        finishReason: 'stop',
        outputText: 'hello',
      }),
    ]);

    expect(messages[messages.length - 1].metadata).toMatchObject({
      reportedModel: 'turn-specific-override',
    });
  });

  it('station#1182: back-compat — events with no metadata field at all still project cleanly', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1', prompt: 'hi' }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.reportedModel).toBeUndefined();
  });

  it('chat-dock-maximize-readiness: upserts a repeated tool.started by call id instead of duplicating the part', () => {
    // A corrected tool.started (e.g. the real programmatic name arriving late)
    // must update the existing tool-invocation part, not append a second row.
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'Editing the source file',
        arguments: undefined,
      }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'edit_file',
        arguments: { path: 'src/a.ts' },
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const toolParts = messages[0].parts.filter(
      (p) => p.type === 'tool-invocation',
    );
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({
      toolCallId: 'c1',
      toolName: 'edit_file',
      args: { path: 'src/a.ts' },
      state: 'call',
    });
  });

  it('chat-dock-maximize-readiness: distinct tool call ids still get distinct parts', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'ls',
        arguments: {},
      }),
      ev({
        method: 'tool.started',
        itemId: 'i2',
        toolCallId: 'c2',
        toolName: 'grep',
        arguments: {},
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    const toolParts = messages[0].parts.filter(
      (p) => p.type === 'tool-invocation',
    );
    expect(toolParts).toHaveLength(2);
    expect(toolParts.map((p) => p.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('chat-dock-maximize-readiness: a terminal event corrects the existing tool name', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'r1' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'Reading a file',
      }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'read',
        status: 'success',
        output: 'done',
      }),
      ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    ]);

    expect(messages[0].parts).toEqual([
      expect.objectContaining({
        type: 'tool-invocation',
        toolCallId: 'c1',
        toolName: 'read',
        state: 'result',
      }),
    ]);
  });

  // station#1410 — the projection carries each completed turn's provenance
  // envelope on its assistant message, correlated by the turn's own id.
  describe('turn provenance (station#1410)', () => {
    it('attaches the turn envelope and turn id to the assistant message only', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'r1', prompt: 'hello' }),
        ev({ method: 'content.text-delta', itemId: 'i1', delta: 'hi' }),
        ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
      ]);

      const [user, assistant] = messages;
      expect(user.role).toBe('user');
      expect(user.metadata?.provenance).toBeUndefined();
      expect(user.metadata).toMatchObject({
        sourceEventId: expect.any(String),
        sessionId: 't1',
        turnId: 'r1',
      });

      expect(assistant.role).toBe('assistant');
      expect(assistant.metadata?.turnId).toBe('r1');
      expect(assistant.metadata?.provenance).toMatchObject({
        envelopeVersion: 1,
        sessionId: 't1',
        turnId: 'r1',
        outcome: 'completed',
      });
    });

    it('correlates each assistant message to its own turn across turns', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'r1', prompt: 'one' }),
        ev({ method: 'content.text-delta', itemId: 'i1', delta: 'first' }),
        ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
        ev({ method: 'turn.started', turnId: 'r2', prompt: 'two' }),
        ev({ method: 'content.text-delta', itemId: 'i2', delta: 'second' }),
        ev({ method: 'turn.completed', turnId: 'r2', finishReason: 'stop' }),
      ]);

      const assistantTurnIds = messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.metadata?.provenance?.turnId);
      expect(assistantTurnIds).toEqual(['r1', 'r2']);
    });

    it('carries no envelope for a turn that never reached a terminal event', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'open', prompt: 'hello' }),
        ev({ method: 'content.text-delta', itemId: 'i1', delta: 'partial' }),
      ]);

      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant?.metadata?.turnId).toBe('open');
      expect(assistant?.metadata?.provenance).toBeUndefined();
    });

    // SF6 — adapters do emit a terminal for an EARLIER turn after the next
    // one has started streaming. Adopting that id would stamp the earlier
    // turn's provenance onto this turn's text.
    it('never stamps a late foreign terminal’s envelope onto the open turn', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'r1', prompt: 'first' }),
        ev({
          method: 'content.text-delta',
          itemId: 'i1',
          delta: 'first answer',
        }),
        ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
        ev({ method: 'turn.started', turnId: 'r2', prompt: 'second' }),
        ev({
          method: 'content.text-delta',
          itemId: 'i2',
          delta: 'second answer',
        }),
        // r1's duplicate terminal, arriving while r2 is still open.
        ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
      ]);

      const secondAnswer = messages.find((message) =>
        message.parts.some((part) => part.text === 'second answer'),
      );
      expect(secondAnswer?.metadata?.turnId).toBe('r2');
      expect(secondAnswer?.metadata?.provenance?.turnId).not.toBe('r1');
      // r2 never terminated in this stream, so it honestly has no envelope.
      expect(secondAnswer?.metadata?.provenance).toBeUndefined();

      // And the first turn's own bubble kept its own envelope.
      const firstAnswer = messages.find((message) =>
        message.parts.some((part) => part.text === 'first answer'),
      );
      expect(firstAnswer?.metadata?.provenance?.turnId).toBe('r1');
    });

    it('still adopts a terminal’s identity when its turn.started fell outside the window', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'content.text-delta', itemId: 'i1', delta: 'resumed' }),
        ev({ method: 'turn.completed', turnId: 'r9', finishReason: 'stop' }),
      ]);

      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant?.metadata?.turnId).toBe('r9');
      expect(assistant?.metadata?.provenance?.turnId).toBe('r9');
    });

    it('carries no envelope when the turn events had no turn id at all', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'content.text-delta', itemId: 'i1', delta: 'orphan' }),
        ev({ method: 'turn.completed', finishReason: 'stop' }),
      ]);

      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant?.metadata?.provenance).toBeUndefined();
      expect(assistant?.metadata?.turnId).toBeUndefined();
    });

    it('keeps same-named turns from separate execution Sessions independently eligible and revokes only the aborted Session', () => {
      const combined = [
        ev({ method: 'turn.started', threadId: 's1', turnId: 'same' }),
        ev({
          method: 'content.text-delta',
          threadId: 's1',
          turnId: 'same',
          itemId: 's1-text',
          delta: 'answer one',
        }),
        ev({
          method: 'turn.completed',
          threadId: 's1',
          turnId: 'same',
          finishReason: 'stop',
        }),
        ev({ method: 'turn.started', threadId: 's2', turnId: 'same' }),
        ev({
          method: 'content.text-delta',
          threadId: 's2',
          turnId: 'same',
          itemId: 's2-text',
          delta: 'answer two',
        }),
        ev({
          method: 'turn.completed',
          threadId: 's2',
          turnId: 'same',
          finishReason: 'stop',
        }),
      ];
      const beforeAbort = projectRuntimeEventsToMessages(combined);
      const one = beforeAbort.find((message) =>
        message.parts.some((part) => part.text === 'answer one'),
      );
      const two = beforeAbort.find((message) =>
        message.parts.some((part) => part.text === 'answer two'),
      );
      expect(one?.metadata).toMatchObject({
        sessionId: 's1',
        turnId: 'same',
        answerEligible: true,
        provenance: expect.objectContaining({
          sessionId: 's1',
          turnId: 'same',
        }),
      });
      expect(two?.metadata).toMatchObject({
        sessionId: 's2',
        turnId: 'same',
        answerEligible: true,
        provenance: expect.objectContaining({
          sessionId: 's2',
          turnId: 'same',
        }),
      });

      const afterAbort = projectRuntimeEventsToMessages([
        ...combined,
        ev({
          method: 'turn.aborted',
          threadId: 's2',
          turnId: 'same',
          reason: 'cancelled',
        }),
      ]);
      const retainedOne = afterAbort.find((message) =>
        message.parts.some((part) => part.text === 'answer one'),
      );
      const revokedTwo = afterAbort.find((message) =>
        message.parts.some((part) => part.text === 'answer two'),
      );
      expect(retainedOne?.metadata?.answerEligible).toBe(true);
      expect(retainedOne?.metadata?.provenance).toMatchObject({
        sessionId: 's1',
      });
      expect(revokedTwo?.metadata?.answerEligible).toBeUndefined();
      expect(revokedTwo?.metadata?.provenance).toBeUndefined();
    });
  });

  describe('the interrupted-turn banner (station#4080 slice 1, review round 1 M3)', () => {
    it('renders the banner when interruptedTurnBoundary is present', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({
          method: 'session.state-changed',
          sessionId: 't1',
          from: 'running',
          to: 'awaiting-approval',
          reason:
            'Turn interrupted — the process restarted while this turn was in progress.',
          sessionState: 'needs_input',
          transitionReason: 'runtime_exit',
          transitionSource: 'system_recovery',
          interruptedTurnBoundary: {
            boundaryId: 'turn-boundary:abc',
            priorState: 'indeterminate',
            ownerId: 'owner-1',
            boundaryCreatedAt: '2026-06-27T00:00:00.000Z',
            boundaryUpdatedAt: '2026-06-27T00:00:01.000Z',
          },
        } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '[SYSTEM_EVENT] [TURN_INTERRUPTED] Turn interrupted — the process restarted while this turn was in progress.',
          },
        ],
      });
    });

    it('renders NO banner for a fabricated (sessionState, transitionReason, transitionSource) triple missing interruptedTurnBoundary', () => {
      // The exact triple `InterruptedTurnRecovery.consume` stamps, but
      // WITHOUT the dedicated field only that consumer ever sets. A
      // generic emitter reproducing this ordinary enum vocabulary for an
      // unrelated reason must not be able to mint a banner it never earned.
      const messages = projectRuntimeEventsToMessages([
        ev({
          method: 'session.state-changed',
          sessionId: 't1',
          from: 'running',
          to: 'awaiting-approval',
          reason: 'unrelated transition',
          sessionState: 'needs_input',
          transitionReason: 'runtime_exit',
          transitionSource: 'system_recovery',
        }),
      ]);

      expect(messages).toHaveLength(0);
    });

    it('renders no banner for an ordinary session.state-changed carrying neither the field nor the triple', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({
          method: 'session.state-changed',
          sessionId: 't1',
          from: 'created',
          to: 'running',
        }),
      ]);

      expect(messages).toHaveLength(0);
    });
  });
  // station#1558 Part A: a `tool.completed` names the turn that issued the
  // call (`turnId`, PR #1560). The fold must honour that name instead of the
  // stream position it happens to arrive at.
  describe('late tool results fold onto the turn that issued the call (station#1558)', () => {
    const lateResultStream = (terminal: 'turn.aborted' | 'turn.completed') => [
      ev({ method: 'turn.started', turnId: 'turn-a', prompt: 'first' }),
      ev({
        method: 'tool.started',
        itemId: 'i1',
        turnId: 'turn-a',
        toolCallId: 'call-1',
        toolName: 'Bash',
        arguments: { command: 'sleep 5' },
      }),
      ev(
        terminal === 'turn.aborted'
          ? { method: 'turn.aborted', turnId: 'turn-a', reason: 'stopped' }
          : {
              method: 'turn.completed',
              turnId: 'turn-a',
              finishReason: 'stop',
            },
      ),
      ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
      ev({ method: 'content.text-delta', itemId: 'i2', delta: 'B answers.' }),
      ev({
        method: 'tool.completed',
        itemId: 'i1',
        turnId: 'turn-a',
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'success',
        output: 'late output',
        eventId: 'late-result',
      }),
      ev({ method: 'turn.completed', turnId: 'turn-b', finishReason: 'stop' }),
    ];

    const toolPartsOf = (message: { parts: Array<{ type: string }> }) =>
      message.parts.filter((part) => part.type === 'tool-invocation');

    it("resolves a stopped turn's call on that turn, leaving the next turn without a tool row", () => {
      const messages = projectRuntimeEventsToMessages(
        lateResultStream('turn.aborted'),
      );

      const turnA = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-a',
      )!;
      const turnB = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-b',
      )!;
      const aTools = toolPartsOf(turnA);
      expect(aTools).toHaveLength(1);
      expect(aTools[0]).toMatchObject({
        toolCallId: 'call-1',
        state: 'result',
        result: 'late output',
        sourceEventId: 'late-result',
      });
      expect(toolPartsOf(turnB)).toHaveLength(0);
    });

    it("resolves a completed turn's call on that turn, leaving the next turn without a tool row", () => {
      const messages = projectRuntimeEventsToMessages(
        lateResultStream('turn.completed'),
      );

      const turnA = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-a',
      )!;
      const turnB = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-b',
      )!;
      const aTools = toolPartsOf(turnA);
      expect(aTools).toHaveLength(1);
      expect(aTools[0]).toMatchObject({
        toolCallId: 'call-1',
        state: 'result',
        result: 'late output',
      });
      expect(toolPartsOf(turnB)).toHaveLength(0);
    });

    // Fix round (M2): matching the call id is not enough — the event names
    // the turn it belongs to, and a carried row on a DIFFERENT turn must not
    // absorb it.
    it('does not settle a carried row when the completion names another turn', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'turn-a', prompt: 'first' }),
        ev({
          method: 'tool.started',
          itemId: 'i1',
          turnId: 'turn-a',
          toolCallId: 'call-1',
          toolName: 'Bash',
        }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-a',
          finishReason: 'stop',
        }),
        ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
        ev({ method: 'content.text-delta', itemId: 'i2', delta: 'B answers.' }),
        // Names turn B, reuses A's call id. Settling A's row here would put
        // B's result on A's turn and leave B with none.
        ev({
          method: 'tool.completed',
          itemId: 'i1',
          turnId: 'turn-b',
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: 'success',
          output: 'B result',
          eventId: 'b-result',
        }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-b',
          finishReason: 'stop',
        }),
      ]);

      const turnA = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-a',
      )!;
      const turnB = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-b',
      )!;
      const bTools = toolPartsOf(turnB);
      expect(bTools).toHaveLength(1);
      expect(bTools[0]).toMatchObject({
        toolCallId: 'call-1',
        result: 'B result',
        sourceEventId: 'b-result',
      });
      // A's own row is untouched — still awaiting the result it was promised.
      const aTools = toolPartsOf(turnA);
      expect(aTools).toHaveLength(1);
      expect(aTools[0]).toMatchObject({ toolCallId: 'call-1', state: 'call' });
      expect(aTools[0]).not.toHaveProperty('result');
    });

    // Fix round (M3): a reused call id must not evict the earlier turn's
    // carried row, or that turn's own late result appends a duplicate and the
    // original row reads "running" forever.
    it('keeps an earlier turn settleable after a later turn reuses its call id', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'turn-a', prompt: 'first' }),
        ev({
          method: 'tool.started',
          itemId: 'i1',
          turnId: 'turn-a',
          toolCallId: 'call-1',
          toolName: 'Bash',
        }),
        ev({ method: 'turn.aborted', turnId: 'turn-a', reason: 'stopped' }),
        ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
        ev({
          method: 'tool.started',
          itemId: 'i2',
          turnId: 'turn-b',
          toolCallId: 'call-1',
          toolName: 'Bash',
        }),
        ev({
          method: 'tool.completed',
          itemId: 'i2',
          turnId: 'turn-b',
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: 'success',
          output: 'B result',
          eventId: 'b-result',
        }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-b',
          finishReason: 'stop',
        }),
        ev({ method: 'turn.started', turnId: 'turn-c', prompt: 'third' }),
        ev({ method: 'content.text-delta', itemId: 'i3', delta: 'C answers.' }),
        // A's own delayed result, arriving two turns later.
        ev({
          method: 'tool.completed',
          itemId: 'i1',
          turnId: 'turn-a',
          toolCallId: 'call-1',
          toolName: 'Bash',
          status: 'success',
          output: 'A result',
          eventId: 'a-result',
        }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-c',
          finishReason: 'stop',
        }),
      ]);

      const byTurn = (turnId: string) =>
        messages.find(
          (message) =>
            message.role === 'assistant' && message.metadata?.turnId === turnId,
        )!;
      const aTools = toolPartsOf(byTurn('turn-a'));
      expect(aTools).toHaveLength(1);
      expect(aTools[0]).toMatchObject({
        state: 'result',
        result: 'A result',
        sourceEventId: 'a-result',
      });
      const bTools = toolPartsOf(byTurn('turn-b'));
      expect(bTools).toHaveLength(1);
      expect(bTools[0]).toMatchObject({ state: 'result', result: 'B result' });
      expect(toolPartsOf(byTurn('turn-c'))).toHaveLength(0);
    });

    // station#1569 (item 2): the other half of the M2 rule — a CARRIED row
    // whose own turn had no identity is not a mismatch. Only the comment said
    // so; these execute the `carriedEntry.turnKey === undefined` branch and
    // pin what it buys and what it costs.
    describe('a carried row whose turn had no identity (station#1569 item 2)', () => {
      /** The mixed-vintage shape: a turn recorded before `turnId` reached
       * these events, whose result arrives once it had. */
      const unidentifiedTurnWithOpenCall = [
        ev({ method: 'turn.started', prompt: 'first' }),
        ev({
          method: 'tool.started',
          itemId: 'i1',
          toolCallId: 'call-1',
          toolName: 'Bash',
        }),
        ev({ method: 'turn.completed', finishReason: 'stop' }),
      ];

      it('is settled in place by a completion that names a turn, rather than stranded', () => {
        const messages = projectRuntimeEventsToMessages([
          ...unidentifiedTurnWithOpenCall,
          ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
          ev({
            method: 'content.text-delta',
            itemId: 'i2',
            delta: 'B answers.',
          }),
          ev({
            method: 'tool.completed',
            itemId: 'i1',
            turnId: 'turn-b',
            toolCallId: 'call-1',
            toolName: 'Bash',
            status: 'success',
            output: 'late output',
            eventId: 'late-result',
          }),
          ev({
            method: 'turn.completed',
            turnId: 'turn-b',
            finishReason: 'stop',
          }),
        ]);

        const assistants = messages.filter(
          (message) => message.role === 'assistant',
        );
        const unidentified = assistants.find(
          (message) => message.metadata?.turnId === undefined,
        )!;
        const turnB = assistants.find(
          (message) => message.metadata?.turnId === 'turn-b',
        )!;
        const carried = toolPartsOf(unidentified);
        expect(carried).toHaveLength(1);
        expect(carried[0]).toMatchObject({
          toolCallId: 'call-1',
          state: 'result',
          result: 'late output',
          sourceEventId: 'late-result',
        });
        // Treating it as a mismatch would have appended a duplicate,
        // result-only row here and left the row above reading "running".
        expect(toolPartsOf(turnB)).toHaveLength(0);
      });

      it('loses to the CURRENT turn when that turn reuses the call id', () => {
        const messages = projectRuntimeEventsToMessages([
          ...unidentifiedTurnWithOpenCall,
          ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
          ev({
            method: 'tool.started',
            itemId: 'i2',
            turnId: 'turn-b',
            toolCallId: 'call-1',
            toolName: 'Bash',
          }),
          ev({
            method: 'tool.completed',
            itemId: 'i2',
            turnId: 'turn-b',
            toolCallId: 'call-1',
            toolName: 'Bash',
            status: 'success',
            output: 'B result',
            eventId: 'b-result',
          }),
          ev({
            method: 'turn.completed',
            turnId: 'turn-b',
            finishReason: 'stop',
          }),
        ]);

        const assistants = messages.filter(
          (message) => message.role === 'assistant',
        );
        const unidentified = assistants.find(
          (message) => message.metadata?.turnId === undefined,
        )!;
        const turnB = assistants.find(
          (message) => message.metadata?.turnId === 'turn-b',
        )!;
        // The carried map is consulted LAST, so an open call on the current
        // turn always outranks a same-id row carried from an earlier one.
        expect(toolPartsOf(turnB)).toHaveLength(1);
        expect(toolPartsOf(turnB)[0]).toMatchObject({
          state: 'result',
          result: 'B result',
        });
        // The identity-less row is still owed the result it was promised —
        // it is not retired by another turn's answer.
        expect(toolPartsOf(unidentified)).toHaveLength(1);
        expect(toolPartsOf(unidentified)[0]).toMatchObject({ state: 'call' });
        expect(toolPartsOf(unidentified)[0]).not.toHaveProperty('result');
      });
    });

    it('puts a start-less late completion on the turn its own turnId names, never on the open one', () => {
      const messages = projectRuntimeEventsToMessages([
        ev({ method: 'turn.started', turnId: 'turn-a', prompt: 'first' }),
        ev({ method: 'content.text-delta', itemId: 'i0', delta: 'A answers.' }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-a',
          finishReason: 'stop',
        }),
        ev({ method: 'turn.started', turnId: 'turn-b', prompt: 'second' }),
        ev({ method: 'content.text-delta', itemId: 'i2', delta: 'B answers.' }),
        ev({
          method: 'tool.completed',
          itemId: 'i9',
          turnId: 'turn-a',
          toolCallId: 'orphan-call',
          toolName: 'Bash',
          status: 'success',
          output: 'orphan output',
          eventId: 'orphan-result',
        }),
        ev({
          method: 'turn.completed',
          turnId: 'turn-b',
          finishReason: 'stop',
        }),
      ]);

      const turnA = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-a',
      )!;
      const turnB = messages.find(
        (message) =>
          message.role === 'assistant' && message.metadata?.turnId === 'turn-b',
      )!;
      expect(toolPartsOf(turnA)).toHaveLength(1);
      expect(toolPartsOf(turnA)[0]).toMatchObject({
        toolCallId: 'orphan-call',
        sourceEventId: 'orphan-result',
      });
      expect(toolPartsOf(turnB)).toHaveLength(0);
    });
  });
});
