/**
 * @vitest-environment jsdom
 *
 * #3418: a Station tool call's row carries Station's mark, named "Station"
 * for assistive technology, and reads as the call's plain-language phrase;
 * inside a live conversation it names the Session it addressed by title.
 * The raw tool name stays in the expanded details.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StationSessionTitlesProvider } from '../station-session-titles';
import { ToolCallDisplay } from '../ToolCallDisplay';

const sessions = vi.hoisted(() => ({
  data: [] as { threadId: string; displayTitle?: string }[],
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useOrchestrationSessionsQuery: () => ({ data: sessions.data }),
}));

afterEach(() => {
  cleanup();
  sessions.data = [];
});

const waitCall = {
  type: 'tool-invocation',
  toolCallId: 'call-wait',
  toolName: 'mcp__station-control__wait_session',
  args: { sessionId: 'thread-7', until: 'turn-settled' },
  state: 'completed',
  result: '{"success":true}',
};

describe('Station tool rows (#3418)', () => {
  test('carry the Station mark with a text alternative, and the phrase as the row label', () => {
    render(<ToolCallDisplay toolCall={waitCall} />);
    const row = document.querySelector('button.tool-call__line')!;
    expect(row.textContent).toContain('Waited for a Session');
    const mark = screen.getByRole('img', { name: 'Station' });
    expect(row.contains(mark)).toBe(true);
    expect(mark.querySelector('svg path')?.getAttribute('fill-rule')).toBe(
      'evenodd',
    );
    // The expanded view still names the tool exactly.
    fireEvent.click(row);
    expect(document.body.textContent).toContain('wait_session');
  });

  test('name the Session by the title a live conversation knows', () => {
    sessions.data = [
      { threadId: 'thread-7', displayTitle: 'Fix login' },
      { threadId: 'thread-8' },
    ];
    const { rerender } = render(
      <StationSessionTitlesProvider>
        <ToolCallDisplay toolCall={waitCall} />
      </StationSessionTitlesProvider>,
    );
    expect(
      document.querySelector('button.tool-call__line')?.textContent,
    ).toContain('Waited for “Fix login”');
    // A Session with no title of its own is not given one.
    rerender(
      <StationSessionTitlesProvider>
        <ToolCallDisplay
          toolCall={{ ...waitCall, args: { sessionId: 'thread-8' } }}
        />
      </StationSessionTitlesProvider>,
    );
    expect(
      document.querySelector('button.tool-call__line')?.textContent,
    ).toContain('Waited for a Session');
  });

  test("another engine's tool keeps a decorative glyph and no Station name", () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-bash',
          toolName: 'Bash',
          args: { command: 'npm test' },
          state: 'completed',
          result: 'ok',
        }}
      />,
    );
    expect(screen.queryByRole('img', { name: 'Station' })).toBeNull();
    expect(
      document.querySelector('.tool-call__glyph')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });
});
