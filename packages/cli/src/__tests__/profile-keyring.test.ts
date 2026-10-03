import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => {
  const methods = {
    construct: vi.fn<(service: string, account: string) => void>(),
    deleteCredential: vi.fn<() => boolean>().mockReturnValue(true),
    getPassword: vi.fn<() => string | null>(),
    setPassword: vi.fn<(credential: string) => void>(),
  };

  class FakeEntry {
    constructor(service: string, account: string) {
      methods.construct(service, account);
    }

    deleteCredential = methods.deleteCredential;
    getPassword = methods.getPassword;
    setPassword = methods.setPassword;
  }

  return {
    ...methods,
    require: vi.fn(() => ({ Entry: FakeEntry })),
  };
});

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => keyring.require,
}));

import { createProfileKeyringStore } from '../commands/profile-keyring.js';

const nativeLoadCallsOnImport = [...keyring.require.mock.calls];

const ref = { kind: 'station-bearer' as const, id: 'remote-home' };

describe('profile OS-keyring adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keyring.getPassword.mockReturnValue(null);
  });

  it('round-trips only through the native keyring entry', () => {
    expect(nativeLoadCallsOnImport).toEqual([]);
    const store = createProfileKeyringStore();
    expect(keyring.require).not.toHaveBeenCalled();
    store.set(ref, 'secret');
    expect(keyring.require).toHaveBeenCalledWith('@napi-rs/keyring');
    expect(keyring.construct).toHaveBeenCalledWith(
      'io.kontourai.station',
      'profile:station-bearer:remote-home',
    );
    expect(keyring.setPassword).toHaveBeenCalledWith('secret');

    keyring.getPassword.mockReturnValue('secret');
    expect(store.get(ref)).toBe('secret');
    expect(store.status(ref)).toBe('available');

    store.delete(ref);
    expect(keyring.deleteCredential).toHaveBeenCalledOnce();
  });

  it('distinguishes a missing credential from an unavailable keyring', () => {
    const store = createProfileKeyringStore();
    expect(store.get(ref)).toBeUndefined();
    expect(store.status(ref)).toBe('missing');

    keyring.getPassword.mockImplementation(() => {
      throw new Error('keyring unavailable');
    });
    expect(store.status(ref)).toBe('unavailable');
    expect(() => store.get(ref)).toThrow('keyring unavailable');
  });
});
