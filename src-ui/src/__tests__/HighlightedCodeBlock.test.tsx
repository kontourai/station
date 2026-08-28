/**
 * @vitest-environment jsdom
 *
 * archive#3339 — the code block's copy button reported "Copied" for a write
 * that never happened: `navigator.clipboard?.writeText(code)` no-ops entirely
 * on a non-secure origin (Station reached over plain http:// from another
 * device is a real deployment mode) and rejects on a permission refusal, and
 * the success state was set unconditionally either way. Same defect, same fix
 * shape as #3317's dir-path button.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../highlight/highlight-client', () => ({
  // Copy-button behavior is independent of highlighting; pending (never
  // resolving) keeps the block in its plain <pre> state.
  highlightCode: () => new Promise<string>(() => {}),
}));

const triggerHaptic = vi.fn();
vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: (...args: unknown[]) => triggerHaptic(...args),
}));

import { markdownCodeComponents } from '../components/chat/HighlightedCodeBlock';

const Code = markdownCodeComponents.code;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  triggerHaptic.mockReset();
  Object.assign(navigator, { clipboard: undefined });
});

function renderBlock() {
  return render(<Code className="language-ts">{'const answer = 42;\n'}</Code>);
}

function copyButton() {
  return screen.getByRole('button');
}

describe('HighlightedCodeBlock copy (station#3339)', () => {
  test('writes the code and reports success only once the write resolved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderBlock();

    const button = copyButton();
    expect(button.textContent).toBe('Copy');
    fireEvent.click(button);

    // The trailing newline is stripped before the write, as before.
    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    await waitFor(() => expect(button.textContent).toContain('Copied'));
    expect(button.textContent).not.toContain("Can't copy");
    expect(triggerHaptic).toHaveBeenCalledWith('light');
  });

  test('a rejected clipboard write never claims a copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    renderBlock();

    const button = copyButton();
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Can't copy"));
    expect(button.textContent).not.toContain('Copied');
    expect(button.getAttribute('title')).toBe(
      'This browser refused clipboard access — select the code to copy it manually.',
    );
    // No haptic confirmation for something that did not happen.
    expect(triggerHaptic).not.toHaveBeenCalled();
  });

  test('an insecure origin with no clipboard API never claims a copy', async () => {
    Object.assign(navigator, { clipboard: undefined });
    renderBlock();

    const button = copyButton();
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Can't copy"));
    expect(button.textContent).not.toContain('Copied');
    expect(triggerHaptic).not.toHaveBeenCalled();
  });

  test('the copy reset timer is cleared on unmount', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = renderBlock();

    const button = copyButton();
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toContain('Copied'));
    clearTimeoutSpy.mockClear();
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
