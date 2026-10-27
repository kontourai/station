import { createRequire } from 'node:module';
import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type { ProfileCredentialStore } from './profile-credentials.js';
import { createMacosKeychainStore } from './profile-keyring-macos.js';

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

function entry(ref: StationProfileCredentialRef): KeyringEntry {
  // The native addon is resolved only after the dispatcher has admitted a
  // command that needs profile credentials. Help, version, and bundled
  // lifecycle refusals must not even load the platform keyring boundary.
  const keyringAccount = account(ref);
  const { Entry } = requireKeyring('@napi-rs/keyring') as {
    Entry: new (service: string, account: string) => KeyringEntry;
  };
  return new Entry(STATION_KEYRING_SERVICE, keyringAccount);
}

export interface ProfileKeyringStoreOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether a person can answer an OS access prompt; defaults to stdin being a TTY. */
  interactive?: boolean;
  /** Test seam: a fixture executable standing in for `/usr/bin/security`. */
  securityPath?: string;
  /** Test seam: overrides the interactivity-derived Keychain bound. */
  timeoutMs?: number;
}

/** Production CLI credential store backed only by the operating-system keyring. */
export function createProfileKeyringStore(
  options: ProfileKeyringStoreOptions = {},
): ProfileCredentialStore {
  // macOS goes through the stable, Apple-signed /usr/bin/security rather than
  // the in-process addon, whose Keychain trust was pinned to each node binary
  // (see profile-keyring-macos.ts). Other platforms keep the native addon.
  if ((options.platform ?? process.platform) === 'darwin') {
    return createMacosKeychainStore({
      service: STATION_KEYRING_SERVICE,
      account,
      interactive: options.interactive ?? Boolean(process.stdin.isTTY),
      ...(options.securityPath ? { securityPath: options.securityPath } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
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
