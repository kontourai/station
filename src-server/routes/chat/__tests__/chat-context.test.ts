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
    // archive#2649: the receipt half describes the block that was actually
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
    // Nothing to apply is not an application (archive#2649).
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

  // archive#3344: the shape a captioned pasted image produces on the
  // Station-engine path — `buildOutgoingUserMessage` emits the text part
  // first, then one file part per attachment, and the station-agent relay
  // (`buildRelayInput`) rebuilds the same order. Making images attachable
  // must not turn an ordinary contextful turn into the archive#2743 drop: the
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

  // These composers used to `JSON.parse(JSON.stringify(input))` the whole
  // history to edit one string, and a turn's history routinely carries `file`
  // parts whose `url` is a base64 data URL. Both appliers run in sequence on
  // the same turn, so an image attachment was re-serialised and re-parsed
  // twice per turn for an edit that never reads it.
  describe('copies only the path it edits', () => {
    /**
     * A file part that COUNTS reads of its data URL. `JSON.stringify` invokes
     * this getter; a structural copy that carries the part by reference never
     * does. This is the assertion that measures the cost rather than
     * describing it.
     */
    const countingFilePart = () => {
      const reads = { url: 0 };
      const part = {
        type: 'file',
        mediaType: 'image/png',
        get url() {
          reads.url += 1;
          return 'data:image/png;base64,AAAA';
        },
      };
      return { part, reads };
    };

    test.each([
      [
        'applyCombinedContextToInput',
        (input: unknown) =>
          applyCombinedContextToInput(input as never, 'inject', 'rag'),
      ],
      [
        'applyAmbientContextToInput',
        (input: unknown) =>
          applyAmbientContextToInput(input as never, '[Timezone: Iceland]'),
      ],
    ] as const)('%s', (_name, apply) => {
      const { part: filePart, reads } = countingFilePart();
      const earlierTurn = {
        role: 'assistant',
        parts: [{ type: 'text', text: 'earlier' }],
      };
      // Bound separately so the assertions below name the exact object they
      // mean, rather than indexing a heterogeneous parts array.
      const captionPart = { type: 'text', text: 'caption' };
      const userTurn = {
        role: 'user',
        parts: [captionPart, filePart],
      };
      const input = [earlierTurn, userTurn];

      const result = apply(input);
      const output = result.input as typeof input;

      expect(result.applied).toBe(true);
      // The data URL was never read, so it was never re-serialised.
      expect(reads.url).toBe(0);

      // New objects along the edited path only: the array, the user message,
      // its parts array, and the text part.
      expect(output).not.toBe(input);
      expect(output[1]).not.toBe(userTurn);
      expect(output[1]?.parts).not.toBe(userTurn.parts);
      expect(output[1]?.parts?.[0]).not.toBe(captionPart);

      // Everything else is the SAME object, not a copy of it.
      expect(output[0]).toBe(earlierTurn);
      expect(output[0]?.parts).toBe(earlierTurn.parts);
      expect(output[1]?.parts?.[1]).toBe(filePart);

      // And the caller's input is still never mutated — the persistence
      // seams keep passing the original while the model gets this.
      expect(captionPart.text).toBe('caption');
      expect(input[1]).toBe(userTurn);
    });
  });

  describe('model-facing context for attachment-only input', () => {
    const attachmentOnly = () => [
      {
        role: 'user',
        parts: [{ type: 'file', url: 'data:text/plain;base64,aGk=' }],
      },
    ];

    test('combined context adds one model text part while preserving original attachment identity', () => {
      const input = attachmentOnly();
      const originalFile = input[0].parts[0];
      const result = applyCombinedContextToInput(input, 'inject', 'rag');
      expect(result.applied).toBe(true);
      expect(result.input).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', text: 'inject\n\nrag' }, originalFile],
        },
      ]);
      expect(input).toEqual(attachmentOnly());
      expect((result.input as typeof input)[0].parts[1]).toBe(originalFile);
    });

    test('ambient context reaches file-only input without synthesizing an authored caption', () => {
      const input = attachmentOnly();
      const result = applyAmbientContextToInput(input, '[Timezone: Iceland]');
      expect(result.applied).toBe(true);
      expect(JSON.stringify(result.input)).toContain('Iceland');
      expect(input[0].parts).toHaveLength(1);
      expect(input[0].parts[0].type).toBe('file');
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
