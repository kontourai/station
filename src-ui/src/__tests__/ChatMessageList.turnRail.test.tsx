/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));

vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

/*
 * The virtualizer is the seam under test from this side: a turn jump must
 * reach it as `revealRowId` naming the turn's prompt row, with tail-follow
 * off. It mounts no rows here, as a long transcript's far turns are not
 * mounted; the rail must still offer every turn.
 * (`transcript-turn-rail.browser.test.tsx` drives the real virtualizer.)
 */
const virtualizerProps: Array<{
  rows: readonly { id: string }[];
  revealRowId?: string;
  followTail?: boolean;
}> = [];
vi.mock('../components/chat/TranscriptVirtualizer', () => ({
  TranscriptVirtualizer: (props: (typeof virtualizerProps)[number]) => {
    virtualizerProps.push(props);
    return null;
  },
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';

const SESSION_ID = 'turn-rail-session';
const rowId = (turn: number) => `${SESSION_ID}:message:u-${turn}`;

class RecordingResizeObserver {
  static observers: RecordingResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Delivers a resize of `target` to every observer watching it. */
function deliverResize(target: Element) {
  act(() => {
    for (const observer of RecordingResizeObserver.observers)
      if (observer.targets.has(target))
        observer.callback(
          [{ target } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
  });
}

function session(turns: number, tail = '') {
  return {
    id: SESSION_ID,
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Turn rail',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle' as const,
    createdAt: 1,
    updatedAt: 1,
    source: 'manual' as const,
    messages: Array.from({ length: turns }, (_, turn) => [
      {
        id: `u-${turn}`,
        role: 'user' as const,
        content: `Question ${turn}`,
        timestamp: turn * 2,
      },
      {
        id: `a-${turn}`,
        role: 'assistant' as const,
        turnId: `t-${turn}`,
        content: `Answer ${turn}${turn === turns - 1 ? tail : ''}`,
        timestamp: turn * 2 + 1,
      },
    ]).flat(),
  };
}

type Session = ReturnType<typeof session>;

function renderList(
  activeSession: Session,
  extra: { hasOlderMessages?: boolean } = {},
) {
  const element = (next: Session) => (
    <ChatMessageList
      activeSession={next}
      fontSize={14}
      showReasoning={false}
      showToolDetails={false}
      renderOverride={(message) => <>{message.content}</>}
      {...extra}
    />
  );
  const view = render(element(activeSession));
  const scroller = screen.getByRole('log');
  // Rows are 100px tall from the content top.
  const geometry = { scrollHeight: activeSession.messages.length * 100 };
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
  });
  scroller.getBoundingClientRect = () =>
    ({ top: 0, bottom: 400, height: 400 }) as DOMRect;
  for (const [index, node] of [
    ...scroller.querySelectorAll<HTMLElement>(':scope > .chat-message-anchor'),
  ].entries())
    node.getBoundingClientRect = () => {
      const top = index * 100 - scroller.scrollTop;
      return { top, bottom: top + 100, height: 100 } as DOMRect;
    };
  // The browser's first observation of the sized scroller pins it.
  deliverResize(scroller);
  return {
    scroller,
    geometry,
    rerender: (next: Session) => view.rerender(element(next)),
  };
}

function readerScrollsTo(scroller: HTMLElement, top: number) {
  fireEvent.wheel(scroller);
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

const turnRail = () =>
  screen.queryByRole('navigation', { name: 'Conversation turns' });

const tick = (turn: number) =>
  within(turnRail()!).getByRole('button', {
    name: new RegExp(`^(Loaded turn|Turn) ${turn + 1} of `),
  });

const announcement = () =>
  screen.getByTestId('transcript-turn-announcement').textContent;

beforeEach(() => {
  virtualizerProps.length = 0;
  RecordingResizeObserver.observers.length = 0;
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  vi.useFakeTimers({
    toFake: [
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'setTimeout',
      'clearTimeout',
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('turn navigation threshold', () => {
  test('a transcript under six user turns has no rail and no turn steps', () => {
    const { scroller } = renderList(session(5));
    expect(turnRail()).toBeNull();
    readerScrollsTo(scroller, 200);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Previous turn' })).toBeNull();
  });

  test('six user turns get one tick each and steps beside Scroll to bottom', () => {
    const { scroller } = renderList(session(6));
    expect(within(turnRail()!).getAllByRole('button')).toHaveLength(6);
    readerScrollsTo(scroller, 200);
    const group = screen.getByRole('group', { name: 'Turn navigation' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Previous turn', 'Next turn', 'Scroll to bottom']);
  });

  test('History replay keeps its own timeline: no live rail', () => {
    renderList({ ...session(8), replay: { elapsedMs: 0 } } as Session);
    expect(turnRail()).toBeNull();
  });
});

describe('jumping to a turn in a virtualized transcript', () => {
  test("every turn has a tick though no row is mounted, and a tick reveals that turn's prompt row", () => {
    renderList(session(30));
    expect(virtualizerProps.at(-1)?.rows).toHaveLength(60);
    expect(document.querySelectorAll('[data-chat-message-key]')).toHaveLength(
      0,
    );
    expect(within(turnRail()!).getAllByRole('button')).toHaveLength(30);

    const before = virtualizerProps.length;
    fireEvent.click(tick(7));
    const reveal = virtualizerProps
      .slice(before)
      .find((props) => props.revealRowId !== undefined);
    expect(reveal?.revealRowId).toBe(rowId(7));
    expect(reveal?.followTail).toBe(false);
    // One reveal per jump: the request clears so the same turn can be asked
    // for again.
    expect(virtualizerProps.at(-1)?.revealRowId).toBeUndefined();
  });

  test('arrow keys on the rail move to the neighbouring turn and keep focus on the rail', () => {
    renderList(session(30));
    act(() => tick(7).focus());
    fireEvent.keyDown(tick(7), { key: 'ArrowUp' });
    expect(
      virtualizerProps.find((props) => props.revealRowId)?.revealRowId,
    ).toBe(rowId(6));
    expect(document.activeElement).toBe(tick(6));
    expect(tick(6).getAttribute('tabindex')).toBe('0');
  });

  test('a jump releases a followed message link so it cannot pull the reader back', () => {
    window.history.replaceState(null, '', '/#station-message=a-2');
    renderList(session(30));
    expect(virtualizerProps.at(-1)?.revealRowId).toBe(
      `${SESSION_ID}:message:a-2`,
    );
    const before = virtualizerProps.length;
    fireEvent.click(tick(20));
    expect(window.location.hash).toBe('');
    const after = virtualizerProps.slice(before);
    expect(after.some((props) => props.revealRowId === rowId(20))).toBe(true);
    expect(
      after.some((props) => props.revealRowId === `${SESSION_ID}:message:a-2`),
    ).toBe(false);
  });

  test('text still streaming does not return a revealed older turn to the end', () => {
    const { scroller, geometry, rerender } = renderList(session(30));
    expect(scroller.scrollTop).toBe(6_000);
    fireEvent.click(tick(3));
    // Where the virtualizer's reveal put the reader.
    scroller.scrollTop = 1_200;
    let streamed = '';
    for (let flush = 0; flush < 5; flush += 1) {
      streamed += ' more streamed text';
      geometry.scrollHeight += 40;
      rerender(session(30, streamed));
      act(() => {
        vi.advanceTimersByTime(32);
      });
      for (const observer of RecordingResizeObserver.observers)
        for (const target of observer.targets)
          observer.callback(
            [{ target } as ResizeObserverEntry],
            observer as unknown as ResizeObserver,
          );
    }
    expect(scroller.scrollTop).toBe(1_200);
    expect(virtualizerProps.at(-1)?.followTail).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
  });
});

describe('jumping to a turn in a short transcript', () => {
  test("centres the turn's prompt row, every row being mounted", () => {
    const { scroller } = renderList(session(10));
    expect(scroller.scrollTop).toBe(2_000);
    fireEvent.click(tick(3));
    // Row 6 (turn 3's prompt) starts 600px down; centred in 400px is 600 - 150.
    expect(scroller.scrollTop).toBe(450);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
  });

  test('Previous turn keeps focus on itself and steps back from the turn in view', () => {
    const { scroller } = renderList(session(10));
    fireEvent.click(tick(5));
    expect(scroller.scrollTop).toBe(850);
    // The browser's scroll event for that write; the rail follows it.
    fireEvent.scroll(scroller);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(tick(5).getAttribute('aria-current')).toBe('location');
    const previous = screen.getByRole('button', { name: 'Previous turn' });
    act(() => previous.focus());
    fireEvent.click(previous);
    // Turn 4's prompt is row 8: centred is 800 - 150.
    expect(scroller.scrollTop).toBe(650);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Previous turn' }),
    );
  });
});

describe('turn positions with older history unloaded', () => {
  test('a complete transcript numbers its turns absolutely', () => {
    renderList(session(30));
    expect(tick(0).getAttribute('aria-label')).toBe('Turn 1 of 30: Question 0');
  });

  test('with older history unloaded, a position is only among the loaded turns', () => {
    renderList(session(30), { hasOlderMessages: true });
    expect(tick(0).getAttribute('aria-label')).toBe(
      'Loaded turn 1 of 30: Question 0',
    );
    act(() => tick(0).focus());
    expect(screen.getByRole('tooltip').textContent).toContain(
      'Loaded turn 1 of 30',
    );
    expect(screen.getByRole('tooltip').textContent).not.toMatch(/^Turn /);
  });
});

describe('the turn preview and announcements', () => {
  test('Escape dismisses a focus preview, keeps focus, and the next turn previews again', () => {
    renderList(session(30));
    act(() => tick(7).focus());
    expect(screen.getByRole('tooltip').textContent).toContain('Question 7');
    const notCancelled = fireEvent.keyDown(tick(7), { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Handled here: the surface behind the rail does not also close.
    expect(notCancelled).toBe(false);
    expect(document.activeElement).toBe(tick(7));
    fireEvent.keyDown(tick(7), { key: 'ArrowDown' });
    expect(screen.getByRole('tooltip').textContent).toContain('Question 8');
  });

  test('Previous and Next say where they landed in a polite live region', () => {
    const { scroller } = renderList(session(10));
    expect(announcement()).toBe('');
    expect(
      screen.getByTestId('transcript-turn-announcement').getAttribute('role'),
    ).toBe('status');
    fireEvent.click(tick(5));
    fireEvent.scroll(scroller);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
    expect(announcement()).toBe('Turn 5 of 10: Question 4');
    fireEvent.scroll(scroller);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next turn' }));
    expect(announcement()).toBe('Turn 6 of 10: Question 5');
  });

  test('with older history unloaded, an announcement claims only a loaded position', () => {
    const { scroller } = renderList(session(10), { hasOlderMessages: true });
    fireEvent.click(tick(5));
    fireEvent.scroll(scroller);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
    expect(announcement()).toBe('Loaded turn 5 of 10: Question 4');
  });
});
