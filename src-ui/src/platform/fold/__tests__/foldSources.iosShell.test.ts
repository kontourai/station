// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * Only the iOS app registers `station-fold`. Desktop and Android refuse the
 * command at Tauri's ACL with messages that vary by build, so the fold source
 * decides from the shell's capability report instead of from an error string.
 */
const shell = vi.hoisted(() => ({
  tauri: true,
  report: { status: 'ok', value: { platform: 'ios' } } as unknown,
}));
vi.mock('../../native/index', () => ({
  hasTauriRuntime: () => shell.tauri,
  nativePlatformPromise: Promise.resolve({
    platform: 'tauri',
    getCapabilityReport: async () => shell.report,
  }),
}));

const { iosShell } = await import('../foldSources');

beforeEach(() => {
  shell.tauri = true;
});

test.each([
  ['ios', true],
  ['macos', false],
  ['windows', false],
  ['linux', false],
  ['android', false],
])(
  'a %s shell supports the native fold source: %s',
  async (platform, expected) => {
    shell.report = { status: 'ok', value: { platform } };
    expect(await iosShell()).toBe(expected);
  },
);

test('an unreadable capability report is not treated as iOS', async () => {
  shell.report = { status: 'error' };
  expect(await iosShell()).toBe(false);
});

test('a browser is never the iOS shell', async () => {
  shell.tauri = false;
  shell.report = { status: 'ok', value: { platform: 'ios' } };
  expect(await iosShell()).toBe(false);
});
