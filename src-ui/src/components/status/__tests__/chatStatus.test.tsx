/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const glyphRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../LiveStatusGlyph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../LiveStatusGlyph')>();
  return {
    ...actual,
    // Counts renders of the pill's body: the glyph re-renders whenever the
    // pill does, and never because of the clock.
    LiveStatusGlyph: (props: Parameters<typeof actual.LiveStatusGlyph>[0]) => {
      glyphRenders.count += 1;
      return actual.LiveStatusGlyph(props);
    },
  };
});

import { CHAT_STATUS_CELEBRATE_MS, ChatStatusPill } from '../ChatStatusPill';
import { type ChatStatusInput, deriveChatStatus } from '../chatStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base: ChatStatusInput = {
  approvalCount: 0,
  turnLive: false,
  waitingOnUser: false,
};
const openTurn = {
  conversationId: 'c',
  asOfSequence: 1,
  openTurn: { threadId: 't', turnId: 'u', startedAt: '2026-09-29T00:00:00Z' },
};

describe('deriveChatStatus — one status, by priority', () => {
  test('does not report a cached active turn as Working when its observation failed', () => {
    const status = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
      turnStartedAt: Date.now() - 13 * 3600000,
      observationUnavailable: true,
    });
    expect(status?.label).toBe('Status unavailable');
    expect(status?.clockFrom).toBeUndefined();
    expect(status?.action).toBe('repair');
  });
  test('the live pill names a reported retry and includes only reported counters', () => {
    const reported = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
      activityHint: {
        kind: 'retrying',
        attempt: 2,
        delayMs: 1500,
        detail: 'Rate limited',
      },
    });
    expect(reported?.label).toBe('Retrying');
    expect(reported?.details).toContainEqual({
      text: 'Retrying · attempt 2 · delay 1.5s · Rate limited',
    });
    const noCounters = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
      activityHint: { kind: 'retrying' },
    });
    expect(noCounters?.details).toContainEqual({ text: 'Retrying' });
    const waiting = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: {
        ...openTurn,
        progressSilence: {
          detectedAt: '2026-09-29T00:03:00Z',
          silentSinceEventAt: '2026-09-29T00:00:00Z',
          windowMs: 180000,
          provider: 'acp',
        },
      },
    });
    expect(waiting?.label).toBe('No progress');
    expect(waiting?.details).toContainEqual({
      text: 'No progress',
      since: Date.parse('2026-09-29T00:00:00Z'),
    });
  });

  test('the expanded silence detail reads like the row: "No progress · 4m"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-29T00:04:10Z'));
    const waiting = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: {
        ...openTurn,
        progressSilence: {
          detectedAt: '2026-09-29T00:03:00Z',
          silentSinceEventAt: '2026-09-29T00:00:00Z',
          windowMs: 180000,
          provider: 'acp',
        },
      },
    });
    render(<ChatStatusPill status={waiting} />);
    act(() => {
      screen.getAllByRole('button')[0].click();
    });
    const lines = Array.from(
      document.querySelectorAll('.chat-status-pill__details p'),
    ).map((line) => line.textContent);
    expect(lines).toContain('No progress · 4m');
    expect(lines.join('|')).not.toMatch(/No progress for/);
  });

  test('approval outranks the connection, which outranks the turn', () => {
    const reconnecting = {
      label: 'Reconnecting live updates…',
      blocked: false,
      kind: 'reconnecting' as const,
    };
    expect(
      deriveChatStatus({
        ...base,
        approvalCount: 2,
        stream: reconnecting,
        turnLive: true,
      })?.kind,
    ).toBe('approval');
    expect(
      deriveChatStatus({ ...base, stream: reconnecting, turnLive: true })?.kind,
    ).toBe('reconnecting');
    expect(
      deriveChatStatus({ ...base, turnLive: true, activity: openTurn }),
    ).toMatchObject({
      kind: 'working',
      label: 'Working',
      clockFrom: Date.parse('2026-09-29T00:00:00Z'),
    });
    expect(deriveChatStatus(base)).toBeUndefined();
  });

  test('thinking is explicit when no tool is executing', () => {
    expect(
      deriveChatStatus({
        ...base,
        turnLive: true,
        activity: openTurn,
        activityHint: { kind: 'thinking' },
      })?.label,
    ).toBe('Thinking');
  });

  test('paused for the user without a request is "Waiting on you", not an approval', () => {
    expect(
      deriveChatStatus({ ...base, turnLive: true, waitingOnUser: true }),
    ).toMatchObject({ kind: 'waiting', label: 'Waiting on you' });
  });
});

describe('ChatStatusPill', () => {
  test('an approval that resolves settles as "Resumed" before the pill moves on', () => {
    vi.useFakeTimers();
    const approval = deriveChatStatus({ ...base, approvalCount: 1 });
    const working = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
    });
    const view = render(<ChatStatusPill status={approval} />);
    expect(
      document
        .querySelector('[data-chat-status-pill]')
        ?.getAttribute('data-chat-status-pill'),
    ).toBe('approval');
    view.rerender(<ChatStatusPill status={working} />);
    const label = () =>
      document.querySelector('.chat-status-pill__label')?.textContent;
    expect(label()).toBe('Resumed');
    act(() => {
      vi.advanceTimersByTime(CHAT_STATUS_CELEBRATE_MS + 10);
    });
    expect(label()).toBe('Working');
  });

  test('the settle ends on time even when the state changes again during it', () => {
    vi.useFakeTimers();
    const approval = deriveChatStatus({ ...base, approvalCount: 1 });
    const working = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
    });
    const label = () =>
      document.querySelector('.chat-status-pill__label')?.textContent;
    const view = render(<ChatStatusPill status={approval} />);
    // The approval resolves as the turn ends…
    view.rerender(<ChatStatusPill status={undefined} />);
    expect(label()).toBe('Resumed');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // …and a new turn starts while "Resumed" is still up.
    view.rerender(<ChatStatusPill status={working} />);
    act(() => {
      vi.advanceTimersByTime(CHAT_STATUS_CELEBRATE_MS);
    });
    expect(label()).toBe('Working');
  });

  test('the ticking clock re-renders only itself, never its host', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-29T00:04:10Z'));
    const working = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
    });
    render(<ChatStatusPill status={working} />);
    const clock = () =>
      document.querySelector('.chat-status-pill__clock')?.textContent;
    expect(clock()).toBe('4:10');
    const before = glyphRenders.count;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(clock()).toBe('4:13');
    expect(glyphRenders.count).toBe(before);
  });

  test('announces the state once, never the clock', () => {
    const working = deriveChatStatus({
      ...base,
      turnLive: true,
      activity: openTurn,
    });
    render(<ChatStatusPill status={working} />);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('Working');
  });

  test('compact approvals announce the pending count and count changes', () => {
    const view = render(
      <ChatStatusPill
        status={deriveChatStatus({ ...base, approvalCount: 3 })}
        onRevealApproval={() => {}}
      />,
    );
    expect(
      document.querySelector('.chat-status-pill__label')?.textContent,
    ).toBe('Needs approval');
    expect(screen.getByRole('status').textContent).toBe('Needs approval (3)');
    expect(
      screen.getByRole('button', { name: /Needs approval \(3\)/ }),
    ).toBeTruthy();
    view.rerender(
      <ChatStatusPill
        status={deriveChatStatus({ ...base, approvalCount: 4 })}
        onRevealApproval={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Needs approval (4)');
    expect(
      screen.getByRole('button', { name: /Needs approval \(4\)/ }),
    ).toBeTruthy();
  });

  test('long and changing tool names keep a compact Working label and announcement', () => {
    const running = (name: string) =>
      deriveChatStatus({
        ...base,
        turnLive: true,
        activity: {
          ...openTurn,
          runningTools: [
            { name, callId: name, startedAt: '2026-09-29T00:01:00Z' },
          ],
        },
      });
    const view = render(<ChatStatusPill status={running('bash')} />);
    const live = () => screen.getByRole('status').textContent;
    expect(live()).toBe('Working');
    expect(
      document.querySelector('.chat-status-pill__label')?.textContent,
    ).toBe('Working');
    view.rerender(
      <ChatStatusPill
        status={running(
          'npm run gate:for -- a/very/long/project/path/Dockerfile',
        )}
      />,
    );
    expect(live()).toBe('Working');
    expect(
      document.querySelector('.chat-status-pill__label')?.textContent,
    ).toBe('Working');
  });
});
