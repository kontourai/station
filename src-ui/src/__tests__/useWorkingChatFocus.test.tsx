/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useWorkingChatFocus } from '../hooks/useWorkingChatFocus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let api: ReturnType<typeof useWorkingChatFocus> | undefined;
function Harness({
  ready,
  draftable = false,
}: {
  ready: boolean;
  draftable?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  api = useWorkingChatFocus({
    activeSessionId: 'chat-1',
    ready,
    draftable,
    terminal: false,
    surfaceRef,
  });
  return (
    <div ref={surfaceRef}>
      <textarea aria-label="Composer" />
      <p>Transcript text</p>
      <button type="button">Elsewhere</button>
    </div>
  );
}

const composer = () =>
  document.querySelector<HTMLTextAreaElement>('textarea')!;

/**
 * The composer as a chat that has just opened reports it: off, then on. A
 * browser blurs a control it disables, with `disabled` already set; jsdom
 * neither blurs a disabled control nor lets it be blurred, so the test fires
 * that `focusout` itself and then drops focus by re-inserting the node.
 */
function setComposerEnabled(enabled: boolean) {
  act(() => {
    const el = composer();
    el.disabled = !enabled;
    if (!enabled && document.activeElement === el) {
      fireEvent.focusOut(el);
      const parent = el.parentNode!;
      const next = el.nextSibling;
      parent.removeChild(el);
      parent.insertBefore(el, next);
    }
    api!.onComposerEnabledChange(enabled ? el : null);
  });
}

// A chat that has just opened disables its composer ("Loading chat…") right
// after the first focus and enables it again later; focus must follow it back.
test('focus returns to the composer when it is enabled again after a loading phase', () => {
  vi.useFakeTimers();
  render(<Harness ready />);
  act(() => api!.requestComposerFocus('chat-1'));
  setComposerEnabled(true);
  expect(document.activeElement).toBe(composer());

  setComposerEnabled(false);
  expect(document.activeElement).toBe(document.body);
  setComposerEnabled(true);
  expect(document.activeElement).toBe(composer());
});

// Focus the person moved somewhere else is theirs: nothing pulls it back.
test('focus moved elsewhere during the loading phase is left alone', () => {
  vi.useFakeTimers();
  render(<Harness ready />);
  act(() => api!.requestComposerFocus('chat-1'));
  setComposerEnabled(true);
  setComposerEnabled(false);
  const elsewhere = document.querySelector<HTMLButtonElement>('button')!;
  act(() => elsewhere.focus());
  setComposerEnabled(true);
  expect(document.activeElement).toBe(elsewhere);
});

// Clicking transcript text moves focus to the page with no `focusin`: that
// is the person leaving the composer, so a later re-enable leaves it alone.
test('blurring the composer to the page ends the request', () => {
  vi.useFakeTimers();
  render(<Harness ready={false} draftable />);
  act(() => api!.requestComposerFocus('chat-1', { whileBusy: true }));
  setComposerEnabled(true);
  expect(document.activeElement).toBe(composer());
  act(() => composer().blur());
  expect(document.activeElement).toBe(document.body);
  setComposerEnabled(false);
  setComposerEnabled(true);
  expect(document.activeElement).not.toBe(composer());
});

// Once the composer has stayed usable for a moment the request is done: a
// later disable and enable is not a start, and focus is not moved.
test('the request ends once the composer stays usable', () => {
  vi.useFakeTimers();
  render(<Harness ready />);
  act(() => api!.requestComposerFocus('chat-1'));
  setComposerEnabled(true);
  act(() => vi.advanceTimersByTime(2_000));
  setComposerEnabled(false);
  setComposerEnabled(true);
  expect(document.activeElement).toBe(document.body);
});

// A chat started from the draft is busy while its first turn runs, and its
// composer takes a draft: focus lands there and the request outlives the
// end-of-turn disable, however long the turn takes.
test('a started busy chat keeps the request through a turn longer than a minute', () => {
  vi.useFakeTimers();
  const view = render(<Harness ready={false} draftable />);
  act(() => api!.requestComposerFocus('chat-1', { whileBusy: true }));
  setComposerEnabled(true);
  expect(document.activeElement).toBe(composer());
  act(() => vi.advanceTimersByTime(90_000));
  setComposerEnabled(false);
  view.rerender(<Harness ready />);
  setComposerEnabled(true);
  expect(document.activeElement).toBe(composer());
});

// Choosing a working chat waits for it to be writable: a busy chat's
// composer is not focused for it (a phone keyboard would cover the turn).
test('choosing a busy chat does not focus its composer until it is writable', () => {
  vi.useFakeTimers();
  const view = render(<Harness ready={false} draftable />);
  act(() => api!.requestComposerFocus('chat-1'));
  setComposerEnabled(true);
  expect(document.activeElement).toBe(document.body);
  view.rerender(<Harness ready />);
  expect(document.activeElement).toBe(composer());
});
