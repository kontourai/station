import { describe, expect, test, vi } from 'vitest';
import { openBrowser } from '../commands/open-browser.js';

/** A spawn stub whose child never emits, so the nextTick fallback settles it. */
function fakeSpawn() {
  const child = { once: vi.fn(), unref: vi.fn() };
  const spawn = vi.fn(
    () => child,
  ) as unknown as typeof import('node:child_process').spawn;
  return { spawn, child };
}

describe('openBrowser', () => {
  test('uses `open` on macOS', async () => {
    const { spawn, child } = fakeSpawn();
    const result = await openBrowser('https://example.test', {
      platform: 'darwin',
      spawn,
    });
    expect(result).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['https://example.test'],
      expect.objectContaining({ windowsHide: true, detached: true }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  test('uses `cmd /c start` with a window-title slot on Windows', async () => {
    const { spawn } = fakeSpawn();
    await openBrowser('https://example.test', { platform: 'win32', spawn });
    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'https://example.test'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  test('uses `xdg-open` on Linux', async () => {
    const { spawn } = fakeSpawn();
    await openBrowser('https://example.test', { platform: 'linux', spawn });
    expect(spawn).toHaveBeenCalledWith(
      'xdg-open',
      ['https://example.test'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  test('resolves false rather than throwing when spawn fails', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    }) as unknown as typeof import('node:child_process').spawn;
    const result = await openBrowser('https://example.test', {
      platform: 'linux',
      spawn,
    });
    expect(result).toBe(false);
  });
});
