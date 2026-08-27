import { createRequire } from 'node:module';
import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type { ProfileCredentialStore } from './profile-credentials.js';

const STATION_KEYRING_SERVICE = 'io.kontourai.station';

function account(ref: StationProfileCredentialRef): string {
  return `profile:${ref.kind}:${ref.id}`;
}

interface KeyringEntry {
  deleteCredential(): void;
  getPassword(): string | null;
  setPassword(credential: string): void;
}

const requireKeyring = createRequire(import.meta.url);
type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

let createEntry: KeyringEntryFactory = (service, keyringAccount) => {
  const { Entry } = requireKeyring('@napi-rs/keyring') as {
    Entry: new (service: string, account: string) => KeyringEntry;
  };
  return new Entry(service, keyringAccount);
};

function entry(ref: StationProfileCredentialRef): KeyringEntry {
  // The native addon is resolved only after the dispatcher has admitted a
  // command that needs profile credentials. Help, version, and bundled
  // lifecycle refusals must not even load the platform keyring boundary.
  return createEntry(STATION_KEYRING_SERVICE, account(ref));
}

/** Explicit test seam; production always uses the lazily resolved native addon. */
export function setProfileKeyringEntryFactoryForTests(
  factory: KeyringEntryFactory | undefined,
): void {
  createEntry =
    factory ??
    ((service, keyringAccount) => {
      const { Entry } = requireKeyring('@napi-rs/keyring') as {
        Entry: new (service: string, account: string) => KeyringEntry;
      };
      return new Entry(service, keyringAccount);
    });
}

/** Production CLI credential store backed only by the operating-system keyring. */
export function createProfileKeyringStore(): ProfileCredentialStore {
  return {
    get(ref) {
      return entry(ref).getPassword() ?? undefined;
    },
    set(ref, credential) {
      entry(ref).setPassword(credential);
    },
    delete(ref) {
      entry(ref).deleteCredential();
    },
    status(ref) {
      try {
        return entry(ref).getPassword() === null ? 'missing' : 'available';
      } catch {
        return 'unavailable';
      }
    },
  };
}
