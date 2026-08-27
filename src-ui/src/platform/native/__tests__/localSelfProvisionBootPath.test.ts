import { attemptLocalSelfProvisionOnce } from '@kontourai/station-connect';
import { describe, expect, it } from 'vitest';
import { NativeStationProfileStorage } from '../stationProfileStorage';

/**
 * station#1818 part 1 review round 1 (HIGH) — the reviewer's own framing:
 * "the new eligibility observation is unreachable in the exact incident
 * scenario" because a CALLER-side gate
 * (`NativeStationProfileStorage.pendingLocalSelfProvisionProfileName`) used
 * to pre-filter on `credentialRef`/`configurationState` and return
 * `undefined` before the boot effect ever called
 * `attemptLocalSelfProvisionOnce` — so `station_local_self_provision`, and
 * therefore its own Rust-side eligibility read-back
 * (`read_credential_for_eligibility`, `src-desktop/src/lib.rs`), never ran
 * at all for a profile shaped exactly like the live incident (credentialRef
 * present, configurationState "configured", credential itself unreadable).
 *
 * `stationProfileStorage.test.ts`'s unit test of the predicate proves the
 * FUNCTION returns the right value in isolation; it does not prove the boot
 * path actually reaches the native command — the reviewer explicitly asked
 * for a test that drives the real boot path with the real stranded profile
 * shape instead. This test runs the exact sequence
 * `OnboardingGate.tsx`'s boot effect runs — hydrate the REAL
 * `NativeStationProfileStorage` from a profiles.json shaped exactly like a
 * stranded post-bundle-swap profile, call the real (unlatched, since this
 * file loads the module fresh) `pendingLocalSelfProvisionProfileName`, then
 * the real `attemptLocalSelfProvisionOnce` — with only the native `invoke`
 * bridge itself faked, since nothing in this process can speak to the OS
 * keychain or Tauri — and asserts `station_local_self_provision` is
 * actually invoked, end to end, for that shape.
 */
describe('local self-provision boot path drives the real stranded profile shape (station#1818)', () => {
  it('reaches station_local_self_provision for a profile already carrying credentialRef and configured', async () => {
    const strandedProfileStore = {
      schemaVersion: 1,
      revision: 0,
      defaultProfile: 'kontour',
      projectProfiles: {},
      profiles: [
        {
          schemaVersion: 1,
          name: 'kontour',
          endpoint: 'http://127.0.0.1:3141',
          // Exactly the incident's shape: both fields already recorded and
          // "healthy"-looking. The credential itself is unreadable (a
          // keychain ACL mismatch after a bundle swap) — a fact this
          // process cannot observe from the profile document alone, which
          // is the entire point of routing this to the Rust command instead
          // of pre-empting it here.
          credentialRef: { kind: 'station-bearer', id: 'kontour-token' },
          configurationState: 'configured',
          localService: {
            instanceId: 'default',
            baseDir: '/home/station',
            serverPort: 3141,
            uiPort: 3000,
          },
          setupSource: 'local',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const invokedCommands: Array<
      [string, Record<string, unknown> | undefined]
    > = [];
    const bridge = {
      async invoke<T>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> {
        invokedCommands.push([command, args]);
        if (command === 'station_profile_store_read') {
          return JSON.stringify(strandedProfileStore) as T;
        }
        // The real Rust-side decision is proven separately, against the
        // real OS keychore taxonomy, by station-desktop's own
        // fault-injected unit tests
        // (profile_already_locally_provisioned_observes_an_unreadable_credential_as_not_provisioned).
        // This fake only needs to prove the CALL itself is reached.
        return undefined as T;
      },
    };

    const storage = new NativeStationProfileStorage(bridge);
    await storage.hydrate();

    // The exact two lines OnboardingGate.tsx's boot effect runs.
    const pendingProfileName = storage.pendingLocalSelfProvisionProfileName();
    expect(pendingProfileName).toBe('kontour');
    const provisioned = await attemptLocalSelfProvisionOnce({
      invoke: bridge.invoke,
      profileName: pendingProfileName as string,
    });

    expect(provisioned).toBe(true);
    expect(invokedCommands).toContainEqual([
      'station_local_self_provision',
      { profileName: 'kontour' },
    ]);
  });
});
