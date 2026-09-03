import { randomUUID } from 'node:crypto';
import type { StationProfileCredentialRef } from '@kontourai/station-contracts';

/**
 * Platform-keyring boundary for profile credentials. Metadata stores only the
 * ref; implementations must never substitute an ordinary file-backed store.
 * The production adapter is installed by the runtime packaging layer, while
 * tests supply this explicit in-memory seam.
 */
export interface ProfileCredentialStore {
  get(ref: StationProfileCredentialRef): string | undefined;
  set(ref: StationProfileCredentialRef, credential: string): void;
  delete(ref: StationProfileCredentialRef): void;
  status(
    ref: StationProfileCredentialRef,
  ): 'available' | 'missing' | 'unavailable';
}

const unavailableStore: ProfileCredentialStore = {
  get: () => undefined,
  set: () => {
    throw new Error(
      'The OS credential store is unavailable. Station refused to write a bearer credential to saved Station metadata.',
    );
  },
  delete: () => {
    throw new Error('The OS credential store is unavailable.');
  },
  status: () => 'unavailable',
};

let credentialStore: ProfileCredentialStore = unavailableStore;

export function getProfileCredentialStore(): ProfileCredentialStore {
  return credentialStore;
}

/** Test/runtime bootstrap seam; callers must install an OS-keyring adapter. */
export function setProfileCredentialStore(store: ProfileCredentialStore): void {
  credentialStore = store;
}

/** Explicit test-only reset; production code must not use an in-memory fallback. */
export function resetProfileCredentialStoreForTests(): void {
  credentialStore = unavailableStore;
}

export function profileCredentialRef(id: string): StationProfileCredentialRef {
  if (!id || id.trim().length === 0)
    throw new Error('A credential reference id cannot be empty.');
  return { kind: 'station-bearer', id };
}

/** A bearer may cross HTTPS, or an IP-literal loopback HTTP transport only. */
export function isCredentialTransportAllowed(endpoint: string): boolean {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return (
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
}

export function assertCredentialTransportAllowed(endpoint: string): void {
  if (!isCredentialTransportAllowed(endpoint)) {
    throw new Error(
      `Station bearer credentials require HTTPS or IP-literal loopback HTTP (refusing ${new URL(endpoint).origin}).`,
    );
  }
}

/**
 * One local self-authorization owns one immutable keyring account, in the
 * exact id shape the desktop's self-provision mints
 * (`src-desktop/src/lib.rs`: `local-grant:<uuid>`), so a shared
 * `profiles.json` never carries two spellings for the same mint kind.
 */
export function newLocalGrantCredentialRef(
  transactionId: string = randomUUID(),
): StationProfileCredentialRef {
  if (!transactionId || transactionId.trim().length === 0)
    throw new Error('A local-grant credential transaction id cannot be empty.');
  return profileCredentialRef(`local-grant:${transactionId}`);
}

/** One pairing attempt owns one immutable keyring account. */
export function newPairingCredentialRef(
  environmentId: string,
  transactionId: string = randomUUID(),
): StationProfileCredentialRef {
  if (!environmentId || environmentId.trim().length === 0)
    throw new Error('A pairing environment id cannot be empty.');
  if (!transactionId || transactionId.trim().length === 0)
    throw new Error('A pairing credential transaction id cannot be empty.');
  return profileCredentialRef(`pairing:${environmentId}:${transactionId}`);
}
