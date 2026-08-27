import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  getPassword: vi.fn(),
  setPassword: vi.fn(),
}));

import {
  createProfileKeyringStore,
  setProfileKeyringEntryFactoryForTests,
} from '../commands/profile-keyring.js';

const ref = { kind: 'station-bearer' as const, id: 'remote-home' };

describe('profile OS-keyring adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keyring.getPassword.mockReturnValue(null);
    setProfileKeyringEntryFactoryForTests(() => ({
      deleteCredential: keyring.deleteCredential,
      getPassword: keyring.getPassword,
      setPassword: keyring.setPassword,
    }));
  });

  it('round-trips only through the native keyring entry', () => {
    const store = createProfileKeyringStore();
    store.set(ref, 'secret');
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
