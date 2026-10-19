/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

import { ChatMessageList } from '../components/chat/ChatMessageList';

/*
 * Transcript scroll stability (tests/transcript-load-stability.spec.ts owns
 * the real-layout journey). jsdom lays nothing out, so each test owns the
 * scroller's geometry and drives the two browser deliveries the transcript
 * depends on: animation frames (fake timers) and ResizeObserver callbacks
 * (a recording stub).
 */

const observers: Array<{
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}> = [];

class RecordingResizeObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set() };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.targets.add(target);
  }
  unobserve(target: Element) {
    this.entry.targets.delete(target);
  }
  disconnect() {
    this.entry.targets.clear();
  }
}

/** Delivers a resize of `target` to every observer watching it. */
function deliverResize(target: Element) {
  act(() => {
    for (const observer of observers)
      if (observer.targets.has(target))
        observer.callback(
          [{ target } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
  });
}

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function session(messageCount = 10) {
  return {
    id: 'stability-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Stability chat',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle' as const,
    createdAt: 1,
    updatedAt: 1,
    source: 'manual' as const,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: 'user' as const,
      content: `message ${index}`,
      timestamp: index,
    })),
  };
}

type Props = Partial<Parameters<typeof ChatMessageList>[0]>;

function renderList(props: Props = {}) {
  const base = session();
  const view = render(
    <ChatMessageList
      activeSession={base}
      fontSize={14}
      showReasoning={false}
      showToolDetails={false}
      renderOverride={(message) => <>{message.content}</>}
      {...props}
    />,
  );
  const scroller = screen.getByRole('log');
  // Rows are 100px tall from the content top; a row above the reader can
  // grow by `shift` pixels.
  const geometry = { scrollHeight: 2_000, clientHeight: 400, shift: 0 };
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
  });
  scroller.getBoundingClientRect = () =>
    ({ top: 0, bottom: geometry.clientHeight }) as DOMRect;
  for (const [index, node] of [
    ...scroller.querySelectorAll<HTMLElement>('.chat-message-anchor'),
  ].entries())
    node.getBoundingClientRect = () => {
      const top =
        index * 100 + (index > 0 ? geometry.shift : 0) - scroller.scrollTop;
      return { top, bottom: top + 100 } as DOMRect;
    };
  // The browser's first observation of the sized scroller.
  deliverResize(scroller);
  const rerender = (next: Props) =>
    view.rerender(
      <ChatMessageList
        activeSession={base}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
        {...props}
        {...next}
      />,
    );
  return { view, scroller, geometry, base, rerender };
}

/** The reader scrolls the transcript to `top` with a wheel. */
function readerScrollsTo(scroller: HTMLElement, top: number) {
  fireEvent.wheel(scroller);
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

function advanceFrames(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const scrollToBottomButton = () =>
  screen.queryByRole('button', { name: 'Scroll to bottom' });

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Scroll to bottom', () => {
  beforeEach(() => {
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

  test('glides over several frames, then hands the transcript back to tail-follow', () => {
    stubMotion(false);
    const { scroller, geometry, base, rerender } = renderList();
    readerScrollsTo(scroller, 1_300);
    advanceFrames(1_000);
    fireEvent.click(scrollToBottomButton()!);
    // The control leaves at once; its row must not resize the transcript at
    // the end of the glide.
    expect(scrollToBottomButton()).toBeNull();
    const tops: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      advanceFrames(16);
      tops.push(scroller.scrollTop);
    }
    const travelling = tops.filter((top) => top > 1_300 && top < 2_000);
    expect(
      travelling.length,
      'positions between start and end',
    ).toBeGreaterThan(5);
    for (let index = 1; index < tops.length; index += 1)
      expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1]);
    expect(scroller.scrollTop).toBe(2_000);
    expect(scrollToBottomButton()).toBeNull();
    // Following again: the next answer re-pins without another press.
    geometry.scrollHeight = 2_500;
    rerender({
      activeSession: {
        ...base,
        messages: [
          ...base.messages,
          { role: 'assistant', content: 'new answer', timestamp: 11 },
        ],
      },
    });
    expect(scroller.scrollTop).toBe(2_500);
  });

  test('reader input cancels the glide where it is and brings the control back', () => {
    stubMotion(false);
    const { scroller } = renderList();
    readerScrollsTo(scroller, 1_300);
    advanceFrames(1_000);
    fireEvent.click(scrollToBottomButton()!);
    advanceFrames(48);
    const stopped = scroller.scrollTop;
    expect(stopped).toBeGreaterThan(1_300);
    expect(stopped).toBeLessThan(1_600);
    fireEvent.wheel(scroller);
    advanceFrames(500);
    expect(scroller.scrollTop).toBe(stopped);
    expect(scrollToBottomButton()).not.toBeNull();
  });

  test("a scroll past the glide's own write is not the reader: no history load, the glide carries on", () => {
    stubMotion(false);
    const onLoadOlder = vi.fn(async () => {});
    const { scroller } = renderList({ hasOlderMessages: true, onLoadOlder });
    readerScrollsTo(scroller, 150);
    advanceFrames(1_000);
    fireEvent.click(scrollToBottomButton()!);
    advanceFrames(16);
    // A layout correction (virtualizer compensation) moves the transcript
    // further along the glide's direction, with no reader input.
    scroller.scrollTop += 40;
    fireEvent.scroll(scroller);
    advanceFrames(500);
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(2_000);
    expect(scrollToBottomButton()).toBeNull();
  });

  test('a scroll against the glide (momentum the reader started) ends it and is theirs', () => {
    stubMotion(false);
    const { scroller } = renderList();
    readerScrollsTo(scroller, 1_300);
    advanceFrames(1_000);
    fireEvent.click(scrollToBottomButton()!);
    advanceFrames(32);
    const glided = scroller.scrollTop;
    // No input event: iOS momentum keeps moving up after the tap.
    scroller.scrollTop = glided - 120;
    fireEvent.scroll(scroller);
    advanceFrames(500);
    expect(scroller.scrollTop).toBe(glided - 120);
    expect(scrollToBottomButton()).not.toBeNull();
  });

  test('content that shrinks under the glide still lands the reader at the new end', () => {
    stubMotion(false);
    const { scroller, geometry } = renderList();
    readerScrollsTo(scroller, 1_300);
    advanceFrames(1_000);
    fireEvent.click(scrollToBottomButton()!);
    advanceFrames(64);
    // A streaming row is replaced by a shorter saved one: the browser clamps.
    geometry.scrollHeight = 1_600;
    scroller.scrollTop = 1_200;
    fireEvent.scroll(scroller);
    advanceFrames(500);
    expect(scroller.scrollTop).toBe(1_600);
    expect(scrollToBottomButton()).toBeNull();
  });

  test('reduced motion lands at once', () => {
    stubMotion(true);
    const { scroller } = renderList();
    readerScrollsTo(scroller, 1_300);
    fireEvent.click(scrollToBottomButton()!);
    expect(scroller.scrollTop).toBe(2_000);
    expect(scrollToBottomButton()).toBeNull();
  });
});

describe('content that grows after the pin', () => {
  test('a pinned transcript follows a row that grows after it rendered', () => {
    const { scroller, geometry } = renderList();
    scroller.scrollTop = 1_600;
    fireEvent.scroll(scroller);
    // The Markdown renderer replaces a row's readable source: the content
    // grows, the scroller's own box does not.
    geometry.scrollHeight = 2_600;
    deliverResize(scroller.querySelector('.chat-message-anchor')!);
    expect(scroller.scrollTop).toBe(2_600);
    expect(scrollToBottomButton()).toBeNull();
  });

  test('a reader keeps their row when a row above it grows', () => {
    const { scroller, geometry } = renderList();
    readerScrollsTo(scroller, 350);
    expect(scrollToBottomButton()).not.toBeNull();
    // The row the reader is on starts 50px above the viewport (row 3 at 300).
    geometry.shift = 240;
    geometry.scrollHeight = 2_240;
    deliverResize(scroller.querySelector('.chat-message-anchor')!);
    expect(scroller.scrollTop).toBe(590);
  });
});

describe('a pinned transcript clamped by layout', () => {
  test('lands short with no reader input: re-pinned', () => {
    const { scroller } = renderList();
    scroller.scrollTop = 1_600;
    fireEvent.scroll(scroller);
    // A sibling measuring itself briefly gave the transcript more height;
    // the browser clamped scrollTop 21px short of the end.
    scroller.scrollTop = 1_579;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(2_000);
    expect(scrollToBottomButton()).toBeNull();
  });

  test('the same small move from a wheel is the reader, not a clamp', () => {
    const { scroller } = renderList();
    scroller.scrollTop = 1_600;
    fireEvent.scroll(scroller);
    readerScrollsTo(scroller, 1_579);
    expect(scroller.scrollTop).toBe(1_579);
  });
});

describe('a finger on the transcript', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });

  /**
   * The order a browser dispatches for a touch drag: the pointer is
   * cancelled as soon as the finger starts panning, long before it lifts.
   */
  function fingerDown(scroller: HTMLElement) {
    fireEvent.pointerDown(scroller, { pointerType: 'touch' });
    fireEvent.touchStart(scroller);
    fireEvent.pointerCancel(window, { pointerType: 'touch' });
  }

  test('dragging up from the pinned end is the reader, not a clamp, while the finger is down', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    fingerDown(scroller);
    for (const top of [1_595, 1_588, 1_580]) {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
      expect(scroller.scrollTop).toBe(top);
    }
  });

  test('momentum after the finger lifts is the reader for as long as it moves, then ends', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    fingerDown(scroller);
    fireEvent.touchEnd(window);
    // Momentum frames for 1.65s, longer than the lift's own grace: scrolls
    // with no input event, still carrying the reader up inside the 32px band.
    for (let frame = 0; frame < 11; frame += 1) {
      vi.advanceTimersByTime(150);
      const top = 1_598 - frame * 2;
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
      expect(scroller.scrollTop).toBe(top);
    }
    // Once it has stopped, a short landing with no input is a clamp again.
    vi.advanceTimersByTime(1_500);
    scroller.scrollTop = 1_579;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(2_000);
  });

  test('a lift on a row that left the document still ends the touch', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    const row = document.createElement('span');
    scroller.append(row);
    fireEvent.touchStart(row);
    // The virtualizer recycles the row mid-drag: its touchend never reaches
    // the window.
    row.remove();
    row.dispatchEvent(new Event('touchend'));
    vi.advanceTimersByTime(1_500);
    scroller.scrollTop = 1_579;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(2_000);
  });

  test('one finger lifting while another stays down is still a touch', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    fingerDown(scroller);
    const stillDown = new Event('touchend');
    Object.defineProperty(stillDown, 'touches', { value: [{}] });
    window.dispatchEvent(stillDown);
    vi.advanceTimersByTime(1_500);
    scroller.scrollTop = 1_590;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(1_590);
  });

  test('a secondary press (context menu) does not hold the transcript', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    fireEvent.pointerDown(scroller, { pointerType: 'mouse', button: 2 });
    // The context menu swallows the release.
    vi.advanceTimersByTime(1_500);
    scroller.scrollTop = 1_579;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(2_000);
  });

  test('a fling that overshoots and settles back at the end stays pinned', () => {
    const { scroller } = renderList();
    vi.advanceTimersByTime(2_000);
    fingerDown(scroller);
    fireEvent.touchEnd(window);
    // Rubber-band: past the end, then back to it, all inside the momentum.
    for (const top of [1_612, 1_606, 1_600]) {
      vi.advanceTimersByTime(16);
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    }
    expect(scrollToBottomButton()).toBeNull();
  });

  test('a clamp to the end while the reader acts (viewport growing) stays pinned', () => {
    const { scroller, geometry } = renderList();
    vi.advanceTimersByTime(2_000);
    fireEvent.pointerDown(scroller, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    // The keyboard closes in sub-threshold steps; scrollTop clamps to the end.
    for (let step = 1; step <= 3; step += 1) {
      geometry.clientHeight = 400 + step * 2;
      scroller.scrollTop = 2_000 - geometry.clientHeight;
      fireEvent.scroll(scroller);
    }
    expect(scrollToBottomButton()).toBeNull();
  });

  for (const release of ['blur', 'contextmenu'] as const)
    test(`a press whose release is lost to ${release} does not hold the transcript`, () => {
      const { scroller } = renderList();
      vi.advanceTimersByTime(2_000);
      fireEvent.pointerDown(scroller, { pointerType: 'mouse', button: 0 });
      window.dispatchEvent(new Event(release));
      vi.advanceTimersByTime(1_500);
      scroller.scrollTop = 1_579;
      fireEvent.scroll(scroller);
      expect(scroller.scrollTop).toBe(2_000);
    });

  test('a slow drag up while an answer streams is not undone by the stream', () => {
    const { scroller, geometry, base, rerender } = renderList();
    vi.advanceTimersByTime(2_000);
    fingerDown(scroller);
    // Three pixels a frame: never past the 32px tolerance on its own.
    scroller.scrollTop = 1_597;
    fireEvent.scroll(scroller);
    geometry.scrollHeight = 2_050;
    rerender({
      activeSession: {
        ...base,
        messages: [
          ...base.messages.slice(0, -1),
          { role: 'assistant', content: 'a streamed token', timestamp: 9 },
        ],
      },
    });
    expect(scroller.scrollTop).toBe(1_597);
    expect(scrollToBottomButton()).not.toBeNull();
  });

  test('a row the reader opens near the end opens in place', () => {
    const { scroller, geometry } = renderList();
    vi.advanceTimersByTime(2_000);
    scroller.scrollTop = 1_600;
    fireEvent.scroll(scroller);
    // A press inside the transcript expands a tool card: content grows below.
    fireEvent.pointerDown(scroller, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    // Past the press's own scroll grace: only the interaction window holds.
    vi.advanceTimersByTime(500);
    geometry.scrollHeight = 2_300;
    deliverResize(scroller.querySelector('.chat-message-anchor')!);
    expect(scroller.scrollTop).toBe(1_600);
    // Growth well after the interaction is the content's own: followed.
    vi.advanceTimersByTime(2_000);
    geometry.scrollHeight = 2_400;
    deliverResize(scroller.querySelector('.chat-message-anchor')!);
    expect(scroller.scrollTop).toBe(2_400);
  });
});
