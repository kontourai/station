/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * boot.ts shows "Station could not finish loading" when the app cannot
 * start. For a themed person main.tsx renders only after the color-theme
 * stylesheet settles, so a render that throws then happens after the module
 * loaded: boot.ts must still reach the recovery, not leave the splash up over
 * an unhandled rejection. The real boot.ts runs here; main.tsx is replaced by
 * its exported `rendered` contract.
 */

const outcome = vi.hoisted(() => ({ rendered: Promise.resolve() }));
vi.mock('../main', () => ({
  get rendered() {
    return outcome.rendered;
  },
}));
vi.mock('../lib/startup-presentation', () => ({
  dismissInitialStartup: vi.fn(),
}));
vi.mock('../platform/native/startupPresentation', () => ({
  observeInitialStartupVisibility: vi.fn(),
}));

async function boot(): Promise<void> {
  vi.resetModules();
  await import('../boot');
  // Let the import, `rendered` and the catch handler settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('boot render recovery', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><div id="splash"></div></div>';
  });

  test('a render that throws after the color-theme wait shows the recovery', async () => {
    outcome.rendered = Promise.reject(new Error('render threw'));
    outcome.rendered.catch(() => {});
    await boot();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.getAttribute('aria-label')).toBe('Station could not start');
    expect(alert?.textContent).toContain('Station could not finish loading.');
    expect(document.getElementById('splash')).toBeNull();
  });

  test('a render that succeeds leaves the page to the app', async () => {
    outcome.rendered = Promise.resolve();
    await boot();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.getElementById('splash')).not.toBeNull();
  });
});
