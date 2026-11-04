import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const keychain = vi.hoisted(() => ({
  value: JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-a' } }),
  absent: false,
  unavailable: false,
  onRead: () => {},
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'darwin',
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn((_command, _args, _options, callback) => {
    if (keychain.unavailable)
      callback(Object.assign(new Error('withheld'), { code: 1 }), '');
    else if (keychain.absent)
      callback(
        Object.assign(new Error('withheld'), { code: 44, killed: false }),
        '',
      );
    else callback(null, keychain.value);
  }),
  execFileSync: vi.fn(() => {
    keychain.onRead();
    if (keychain.unavailable)
      throw Object.assign(new Error('withheld'), { status: 1 });
    if (keychain.absent)
      throw Object.assign(new Error('withheld'), { status: 44, signal: null });
    return keychain.value;
  }),
}));

import {
  assertNativeAuthenticationProfile,
  captureNativeAuthenticationLaunch,
  observeNativeAuthenticationLaunch,
} from '../native-authentication-context.js';

const temporary = trackTempDirs();
beforeEach(() => {
  keychain.value = JSON.stringify({
    claudeAiOauth: { accessToken: 'synthetic-a' },
  });
  keychain.absent = false;
  keychain.unavailable = false;
  keychain.onRead = () => {};
});
afterEach(() => vi.clearAllMocks());

async function capturedLaunch(admission = () => {}, source = () => {}) {
  const home = temporary('station-keychain-auth-');
  const env = { HOME: home, USER: 'owned-keychain-fixture' };
  const continuation = await observeNativeAuthenticationLaunch({
    engine: 'claude',
    profileRef: null,
    command: process.execPath,
    cwd: home,
    env,
    assertCurrent: source,
  });
  if (!continuation) throw new Error('Native continuation was not captured');
  const adapter = {};
  const effect = vi.fn();
  const invoke = () =>
    continuation.invoke(adapter, 'owned-thread', admission, () => {
      const guard = captureNativeAuthenticationLaunch(adapter, 'owned-thread');
      if (!guard) throw new Error('Native launch guard is absent');
      guard({
        command: process.execPath,
        args: [],
        cwd: home,
        env: { ...env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' },
      });
      effect();
    });
  const invokeAt = (phase: 'invoke' | 'profile' | 'spawn') =>
    continuation.invoke(adapter, 'owned-thread', admission, () => {
      if (phase === 'profile')
        assertNativeAuthenticationProfile(adapter, 'owned-thread', null, home);
      if (phase === 'spawn') {
        const guard = captureNativeAuthenticationLaunch(
          adapter,
          'owned-thread',
        );
        if (!guard) throw new Error('Native launch guard is absent');
        guard({
          command: process.execPath,
          args: [],
          cwd: home,
          env: { ...env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' },
        });
      }
      effect();
    });
  return { invoke, invokeAt, effect };
}

test('an unchanged Keychain item permits the exact guarded native launch', async () => {
  const launch = await capturedLaunch();
  launch.invoke();
  expect(launch.effect).toHaveBeenCalledTimes(1);
});

test.each(['replacement', 'deletion', 'unavailable'] as const)(
  'a Keychain %s refuses before the native launch effect',
  async (change) => {
    const launch = await capturedLaunch();
    if (change === 'replacement')
      keychain.value = JSON.stringify({
        claudeAiOauth: { accessToken: 'synthetic-b' },
      });
    else if (change === 'deletion') keychain.absent = true;
    else keychain.unavailable = true;
    expect(launch.invoke).toThrow(/ensemble_auth_store_(changed|unavailable)/);
    expect(launch.effect).not.toHaveBeenCalled();
  },
);

test('a Keychain item appearing after an absent capture refuses before launch', async () => {
  keychain.absent = true;
  const launch = await capturedLaunch();
  keychain.absent = false;
  expect(launch.invoke).toThrow('ensemble_auth_store_changed');
  expect(launch.effect).not.toHaveBeenCalled();
});

test('an unavailable Keychain cannot produce a launch continuation', async () => {
  keychain.unavailable = true;
  await expect(capturedLaunch()).rejects.toThrow(
    'ensemble_auth_store_unsupported',
  );
});

test.each(['invoke', 'profile', 'spawn'] as const)(
  'admission expiring during the %s Keychain read refuses before effect',
  async (phase) => {
    let expired = false;
    const launch = await capturedLaunch(() => {
      if (expired) throw new Error('owned-admission-expired');
    });
    let reads = 0;
    keychain.onRead = () => {
      if (++reads === (phase === 'invoke' ? 1 : 2)) expired = true;
    };
    expect(() => launch.invokeAt(phase)).toThrow('owned-admission-expired');
    expect(launch.effect).not.toHaveBeenCalled();
  },
);

test('source authority expiring during a Keychain read refuses before effect', async () => {
  let expired = false;
  const launch = await capturedLaunch(
    () => {},
    () => {
      if (expired) throw new Error('owned-source-expired');
    },
  );
  keychain.onRead = () => {
    expired = true;
  };
  expect(() => launch.invokeAt('invoke')).toThrow('owned-source-expired');
  expect(launch.effect).not.toHaveBeenCalled();
});
