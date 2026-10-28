/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useWorkingChatFocus } from '../hooks/useWorkingChatFocus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let api: ReturnType<typeof useWorkingChatFocus> | undefined;
function Harness({ ready }: { ready: boolean }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  api = useWorkingChatFocus({
    activeSessionId: 'chat-1',
    ready,
    terminal: false,
    surfaceRef,
  });
  return (
    <div ref={surfaceRef}>
      <textarea aria-label="Composer" />
      <button type="button">Elsewhere</button>
    </div>
  );
}

const composer = () => document.querySelector<HTMLTextAreaElement>('textarea')!;

/** The composer as a chat that has just opened reports it: off, then on. */
function setComposerEnabled(enabled: boolean) {
  act(() => {
    // A disabled control loses focus in a browser; jsdom keeps it, so blur
    // it first, as the browser's focus fixup would.
    if (!enabled) composer().blur();
    composer().disabled = !enabled;
    api!.onComposerEnabledChange(enabled ? composer() : null);
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
