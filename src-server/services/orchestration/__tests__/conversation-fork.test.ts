import { describe, expect, test } from 'vitest';
import {
  renderForkTranscript,
  selectForkTranscriptSlice,
} from '../conversation-fork.js';

describe('renderForkTranscript', () => {
  test('renders a complete, delimited transcript when it fits', () => {
    const rendered = renderForkTranscript({
      sourceTitle: 'Planning',
      sourceAgent: 'Claude',
      // Legacy file-store rows carry a string `content`.
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ] as any,
    });
    expect(rendered).toMatch(
      /^Continued from a previous conversation \(Planning, on Claude\)/,
    );
    expect(rendered).toContain(
      'All 2 earlier user and assistant text messages are included',
    );
    expect(rendered).toMatch(/\n\nUser: first\n\nAssistant: second$/);
  });

  test('drops whole older messages and counts them', () => {
    const newest = 'x'.repeat(30_000);
    const rendered = renderForkTranscript({
      sourceTitle: 'Planning',
      sourceAgent: 'Claude',
      messages: [
        { role: 'user', content: `old question ${'y'.repeat(2_000)}` },
        { role: 'assistant', content: newest },
      ] as any,
    });
    expect(rendered).toContain('The 1 earlier one is omitted;');
    expect(rendered).not.toContain('old question');
    expect(rendered).toContain(`Assistant: ${newest}`);
  });

  test('counts a message with no text parts instead of claiming everything is included', () => {
    const rendered = renderForkTranscript({
      sourceTitle: 'Planning',
      sourceAgent: 'Claude',
      messages: [
        { id: 'u', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        {
          id: 'a',
          role: 'assistant',
          parts: [{ type: 'tool', toolCallId: 'call-1', toolName: 'read' }],
        },
      ],
    });
    expect(rendered).toContain(
      'The 1 earlier user or assistant text message is included below.',
    );
    expect(rendered).toContain(
      '1 other user or assistant message had no text parts to carry',
    );
  });

  test('branches only through the selected completed assistant turn', () => {
    const selected = selectForkTranscriptSlice(
      [
        { id: 'u1', role: 'user', content: 'first' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'first answer',
          metadata: {
            turnId: 'turn-1',
            sessionId: 'session-1',
            answerEligible: true,
          },
        },
        { id: 'u2', role: 'user', content: 'second' },
        {
          id: 'a2',
          role: 'assistant',
          content: 'still streaming',
          metadata: { turnId: 'turn-2', answerEligible: false },
        },
      ] as any,
      'turn-1',
    );

    expect(selected).toMatchObject({
      branchPointTurnId: 'turn-1',
      sourceSessionId: 'session-1',
    });
    expect(selected?.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
    ]);
    expect(
      selectForkTranscriptSlice(selected?.messages ?? [], 'turn-2'),
    ).toBeNull();
  });

  test('requires positive terminal evidence for runtime-projected turns', () => {
    const messages = [
      {
        id: 'partial',
        role: 'assistant',
        content: 'partial',
        metadata: { turnId: 'turn-1' },
      },
      {
        id: 'settled',
        role: 'assistant',
        content: 'settled',
        metadata: { turnId: 'turn-1', answerEligible: true },
      },
    ] as any;

    expect(
      selectForkTranscriptSlice(messages, 'turn-1', {
        requirePositiveTerminalEvidence: true,
      })?.messages.at(-1)?.id,
    ).toBe('settled');
    expect(
      selectForkTranscriptSlice([messages[0]], undefined, {
        requirePositiveTerminalEvidence: true,
      }),
    ).toBeNull();
  });
});
