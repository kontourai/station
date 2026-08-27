import { describe, expect, test, vi } from 'vitest';
import {
  applyAmbientContextToInput,
  applyCombinedContextToInput,
  injectConversationFeedbackContext,
} from '../chat-context.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  feedbackOps: { add: vi.fn() },
}));

describe('injectConversationFeedbackContext', () => {
  test('appends negative feedback context for the active conversation only', () => {
    const result = injectConversationFeedbackContext(
      [
        {
          conversationId: 'conv-1',
          rating: 'thumbs_down',
          messageIndex: 2,
          reason: 'Too vague',
        },
        {
          conversationId: 'conv-2',
          rating: 'thumbs_down',
          messageIndex: 1,
        },
      ],
      'conv-1',
      'existing rag context',
    );

    expect(result.ragContext).toContain('existing rag context');
    expect(result.ragContext).toContain('<conversation_feedback>');
    expect(result.ragContext).toContain(
      'Message #2 was rated negatively: "Too vague"',
    );
    expect(result.ragContext).not.toContain('conv-2');
    // station#2649: the receipt half describes the block that was actually
    // appended — one flagged message in this conversation, cost estimated
    // from the composed block itself.
    expect(result.feedback).toEqual({
      flaggedMessages: 1,
      approxTokens: expect.any(Number),
    });
    expect(result.feedback!.approxTokens).toBeGreaterThan(0);
  });

  test('returns the original context and NO feedback receipt when there is no matching negative feedback', () => {
    const result = injectConversationFeedbackContext(
      [{ conversationId: 'conv-1', rating: 'thumbs_up', messageIndex: 1 }],
      'conv-1',
      'rag',
    );
    expect(result.ragContext).toBe('rag');
    // No block composed → no receipt — never a zero-valued fabricated one.
    expect(result.feedback).toBeNull();
  });
});

describe('applyAmbientContextToInput (#685)', () => {
  test('composes ambient context ahead of string input for the model only', () => {
    expect(
      applyAmbientContextToInput('what time is it?', '[Timezone: Iceland]')
        .input,
    ).toBe('[Timezone: Iceland]\nwhat time is it?');
  });

  test('returns the input unchanged when ambient context is absent or blank', () => {
    expect(applyAmbientContextToInput('hello', undefined).input).toBe('hello');
    expect(applyAmbientContextToInput('hello', null).input).toBe('hello');
    expect(applyAmbientContextToInput('hello', '   ').input).toBe('hello');

    const parts = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
    expect(applyAmbientContextToInput(parts as any, undefined).input).toBe(
      parts,
    );
    // Nothing to apply is not an application (station#2649).
    expect(applyAmbientContextToInput('hello', undefined).applied).toBe(false);
  });

  test('composes into the first user text part without mutating the input', () => {
    const input = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];

    const result = applyAmbientContextToInput(
      input as any,
      '[Timezone: Iceland]',
    ).input;

    expect(result).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', text: '[Timezone: Iceland]\nhello' }],
      },
    ]);
    expect(input).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]);
  });

  test('stacks with combined knowledge/rag context at the model-facing choke point', () => {
    expect(
      applyCombinedContextToInput(
        applyAmbientContextToInput('hello', '[Timezone: Iceland]').input,
        'inject',
        'rag',
      ).input,
    ).toBe('inject\n\nrag\n\n[Timezone: Iceland]\nhello');
  });
});

describe('applyCombinedContextToInput', () => {
  test('prepends combined context to string input', () => {
    expect(applyCombinedContextToInput('hello', 'inject', 'rag').input).toBe(
      'inject\n\nrag\n\nhello',
    );
    expect(applyCombinedContextToInput('hello', 'inject', 'rag').applied).toBe(
      true,
    );
  });

  test('prepends combined context to the first user text part without mutating input', () => {
    const input = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ];

    const result = applyCombinedContextToInput(
      input as any,
      'inject',
      'rag',
    ).input;

    expect(result).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', text: 'inject\n\nrag\n\nhello' }],
      },
    ]);
    expect(input).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]);
  });

  // station#3344: the shape a captioned pasted image produces on the
  // Station-engine path — `buildOutgoingUserMessage` emits the text part
  // first, then one file part per attachment, and the station-agent relay
  // (`buildRelayInput`) rebuilds the same order. Making images attachable
  // must not turn an ordinary contextful turn into the #2743 drop: the
  // composed block still has to reach the model, and the image part still
  // has to survive alongside it.
  test('an image-bearing turn with a caption keeps its composed context and its image', () => {
    const input = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'what is in this screenshot?' },
          {
            type: 'file',
            url: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
          },
        ],
      },
    ];

    const result = applyCombinedContextToInput(
      input as any,
      'project rules',
      'retrieved knowledge',
    );

    expect(result.applied).toBe(true);
    expect(result.input).toEqual([
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'project rules\n\nretrieved knowledge\n\nwhat is in this screenshot?',
          },
          {
            type: 'file',
            url: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
          },
        ],
      },
    ]);
  });

  // station#2649 review fix (HIGH-1). This is the shape an uncaptioned
  // attachment produces (`buildOutgoingUserMessage` pushes a text part only
  // `if (content)`): both appliers silently drop their whole block, and
  // `applied: false` is what stops the receipt from claiming the model read
  // context it never received.
  describe('reports NOT applying a block it silently dropped', () => {
    const attachmentOnly = () => [
      {
        role: 'user',
        parts: [{ type: 'file', url: 'data:image/png;base64,AAAA' }],
      },
    ];

    test('combined context: no user text part means nothing was injected', () => {
      const result = applyCombinedContextToInput(
        attachmentOnly() as any,
        'inject',
        'rag',
      );

      expect(result.applied).toBe(false);
      // And the claim matches reality: the input carries neither block.
      expect(JSON.stringify(result.input)).not.toContain('inject');
      expect(JSON.stringify(result.input)).not.toContain('rag');
    });

    test('ambient context: no user text part means nothing was composed', () => {
      const result = applyAmbientContextToInput(
        attachmentOnly() as any,
        '[Timezone: Iceland]',
      );

      expect(result.applied).toBe(false);
      expect(JSON.stringify(result.input)).not.toContain('Iceland');
    });

    test('a user message with no parts at all is also a drop', () => {
      const result = applyCombinedContextToInput(
        [{ role: 'user' }] as any,
        'inject',
        null,
      );
      expect(result.applied).toBe(false);
      expect(JSON.stringify(result.input)).not.toContain('inject');
    });
  });
});
