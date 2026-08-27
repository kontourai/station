import { describe, expect, test } from 'vitest';
import {
  FORK_OMITTED_MARKER,
  renderForkTranscript,
  selectForkTranscriptSlice,
} from '../conversation-fork.js';

describe('renderForkTranscript', () => {
  test('renders a complete, delimited transcript when it fits', () => {
    expect(
      renderForkTranscript({
        sourceTitle: 'Planning',
        sourceAgent: 'Claude',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ] as any,
        maxChars: 100,
      }),
    ).toBe(
      'Continued from a previous conversation (Planning, on Claude):\n\nUser: first\n\nAssistant: second',
    );
  });

  test('drops from the head and pins the omission marker at the boundary', () => {
    const rendered = renderForkTranscript({
      sourceTitle: 'Planning',
      sourceAgent: 'Claude',
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'x'.repeat(100) },
      ] as any,
      maxChars: 40,
    });
    expect(rendered).toContain(FORK_OMITTED_MARKER);
    expect(rendered).not.toContain('User: old');
    expect(rendered).toContain('Assistant:');
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
