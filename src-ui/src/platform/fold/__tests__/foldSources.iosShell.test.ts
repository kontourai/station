// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * Only the iOS app registers `station-fold`. Desktop and Android refuse the
 * command at Tauri's ACL with messages that vary by build, so the fold source
 * decides from the page's own platform resolution (the profile's single
 * capability report) and never asks the host again itself.
 */
const shell = vi.hoisted(() => ({
  target: Promise.resolve('ios') as Promise<string>,
  invoke: vi.fn(),
}));
vi.mock('../../PlatformProfileContext', () => ({
  resolvedPlatformTarget: () => shell.target,
}));
vi.mock('../../native/tauriInvoke', () => ({
  invokeTauri: shell.invoke,
  listenTauriPlugin: async () => () => {},
}));

const { installFoldGeometry, iosShell } = await import('../foldSources');

beforeEach(() => {
  shell.invoke.mockReset();
});

test.each([
  ['ios', true],
  ['macos', false],
  ['windows', false],
  ['linux', false],
  ['android', false],
  ['web', false],
  ['unknown', false],
])(
  'a %s shell supports the native fold source: %s',
  async (target, expected) => {
    shell.target = Promise.resolve(target);
    expect(await iosShell()).toBe(expected);
  },
);

test('a failed platform resolution is not treated as iOS', async () => {
  shell.target = Promise.reject(new Error('adapter failed'));
  expect(await iosShell()).toBe(false);
});

test('the source starts reading once the platform resolves to iOS after it was installed', async () => {
  // The adapter resolves after the document is ready; the fold source is
  // installed earlier, at module load. It must wait for that answer rather
  // than decide from whatever the page knew at install time.
  let resolveTarget!: (target: string) => void;
  shell.target = new Promise((resolve) => {
    resolveTarget = resolve;
  });
  shell.invoke.mockResolvedValue(null);
  const stop = installFoldGeometry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(shell.invoke).not.toHaveBeenCalled();
  resolveTarget('ios');
  await vi.waitFor(() =>
    expect(shell.invoke).toHaveBeenCalledWith('plugin:station-fold|state'),
  );
  stop();
});
