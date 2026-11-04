/** @vitest-environment jsdom */

import { afterEach, expect, test, vi } from 'vitest';
import { observeThemeChanges } from '../../terminal-view/theme';

// While a phone keyboard animates, the app writes the visual-viewport inset
// to <html>'s inline style every frame. The view re-resolved every token and
// repainted its palette for each write.
afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

const settle = () => new Promise((done) => setTimeout(done, 0));

test('a geometry-only style write does not re-theme; a colour change does', async () => {
  const changed = vi.fn();
  const stop = observeThemeChanges(changed);
  const root = document.documentElement;
  for (const inset of ['0px', '120.5px', '1.1368683772161603e-13px', '312px']) {
    root.style.setProperty('--visual-viewport-inset', inset);
    await settle();
  }
  expect(changed).not.toHaveBeenCalled();

  root.style.setProperty('--k-action', 'oklch(60% 0.1 200)');
  await settle();
  expect(changed).toHaveBeenCalledTimes(1);
  root.setAttribute('data-theme', 'dark');
  await settle();
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
});
