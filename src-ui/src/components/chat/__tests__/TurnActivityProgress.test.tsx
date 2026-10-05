/** @vitest-environment jsdom */

/**
 * The progress row under an open turn names the tool the server's record
 * holds, and an ACP engine's tool "name" is display text — for OpenCode's
 * shell tool, the whole command line. The row prints it as written and
 * keeps the name in its own shrinking box, so the outcome after it is not
 * the part a narrow column cuts off (the ellipsis itself is CSS, proven by
 * the 412px render check, not by this DOM test).
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TurnActivityProgress } from '../TurnActivityProgress';

afterEach(() => {
  document.body.innerHTML = '';
});

const command =
  'npm run gate:for -- Dockerfile .dockerignore docs/user/getting-started.md 2>&1 | tail -40';

describe('TurnActivityProgress', () => {
  test('silence reports waiting without inventing a retry and disappears on progress or completion', () => {
    const now = Date.now();
    const activity = {
      conversationId: 'c1',
      asOfSequence: 3,
      openTurn: {
        threadId: 'c1',
        turnId: 't1',
        startedAt: new Date(now - 180000).toISOString(),
      },
      progressSilence: {
        detectedAt: new Date(now).toISOString(),
        silentSinceEventAt: new Date(now - 180000).toISOString(),
        provider: 'codex',
        windowMs: 180000,
      },
    };
    const { rerender } = render(<TurnActivityProgress activity={activity} />);
    expect(screen.getByTestId('turn-activity-progress').textContent).toBe(
      'No progress from Codex for 3m',
    );
    rerender(
      <TurnActivityProgress
        activity={{ ...activity, progressSilence: undefined }}
      />,
    );
    expect(screen.queryByTestId('turn-activity-progress')).toBeNull();
    rerender(
      <TurnActivityProgress activity={{ ...activity, openTurn: undefined }} />,
    );
    expect(screen.queryByTestId('turn-activity-progress')).toBeNull();
  });

  test('the last tool is its command as written, with the outcome outside the shrinking name', () => {
    const now = Date.now();
    render(
      <TurnActivityProgress
        activity={{
          conversationId: 'c1',
          asOfSequence: 3,
          openTurn: {
            threadId: 'c1',
            turnId: 't1',
            startedAt: new Date(now - 60_000).toISOString(),
          },
          lastTool: {
            name: command,
            callId: 'call-1',
            outcome: 'success',
            completedAt: new Date(now - 1_000).toISOString(),
          },
        }}
      />,
    );
    const row = screen.getByTestId('turn-activity-progress');
    expect(row.textContent).toBe(`Last: ${command} · done`);
    const name = row.querySelector('.turn-activity-progress__name');
    expect(name?.textContent).toBe(command);
    expect(name?.nextElementSibling?.textContent).toBe(' · done');
    expect(
      row.querySelector('.turn-activity-progress__tool')?.getAttribute('title'),
    ).toBe(`Last: ${command} · done`);
  });
});
