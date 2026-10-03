import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  construct: vi.fn(),
  deleteCredential: vi.fn(),
  getPassword: vi.fn(),
  require: vi.fn(),
  setPassword: vi.fn(),
}));

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => keyring.require,
}));

class FakeEntry {
  constructor(service: string, account: string) {
    keyring.construct(service, account);
  }

  deleteCredential = keyring.deleteCredential;
  getPassword = keyring.getPassword;
  setPassword = keyring.setPassword;
}

let createProfileKeyringStore: typeof import('../commands/profile-keyring.js')['createProfileKeyringStore'];

const ref = { kind: 'station-bearer' as const, id: 'remote-home' };

describe('profile OS-keyring adapter', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    keyring.getPassword.mockReturnValue(null);
    keyring.require.mockReturnValue({ Entry: FakeEntry });
    ({ createProfileKeyringStore } = await import(
      '../commands/profile-keyring.js'
    ));
  });

  it('round-trips only through the native keyring entry', () => {
    expect(keyring.require).not.toHaveBeenCalled();
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
