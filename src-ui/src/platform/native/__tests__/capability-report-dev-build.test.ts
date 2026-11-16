import { describe, expect, it } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import type { NativeCapabilityId, NativeCapabilityState } from '../types';

/**
 * These drive the adapter's real parse path rather than a pre-parsed fixture.
 *
 * That distinction is the whole point of this file. The dev-build flag was
 * plumbed from Rust through to the UI and tested at the profile layer with a
 * mocked adapter result — so the tests passed while `parseCapabilityReport`
 * quietly dropped the field and no dev build was ever tinted. A contract that
 * crosses a boundary has to be tested at the boundary.
 */

/**
 * Keyed by `NativeCapabilityId` on purpose — see the same note in
 * `src-ui/src/__tests__/native-platform.test.ts`. `parseCapabilityReport`
 * requires an exact set match, so a fixture that falls one id behind stops
 * testing the dev-build flag at all and starts testing the rejection path
 * under a passing-looking name (archive#1667). A `Record` over the closed
 * union makes the next capability a typecheck failure here.
 */
const CAPABILITY_STATES: Record<NativeCapabilityId, NativeCapabilityState> = {
  'capability-report': 'enabled',
  'desktop-tray': 'disabled',
  haptics: 'unsupported',
  'host-event-bridge': 'enabled',
  'local-browser-preview': 'disabled',
  'workspace-pane-pop-out': 'enabled',
  'pairing-deep-link': 'enabled',
  'host-credential-broker': 'enabled',
  'native-consent-broker': 'enabled',
  'remote-push': 'unsupported',
  'share-intake': 'disabled',
  'image-share-intake': 'enabled',
  'clipboard-image': 'enabled',
};

const CAPABILITIES = Object.entries(CAPABILITY_STATES).map(([id, state]) => ({
  id,
  state,
  reason: 'fixture',
}));

function adapterReporting(payload: unknown) {
  return new TauriNativePlatformAdapter({
    invoke: async () => payload as never,
    listen: async () => () => {},
  });
}

describe('capability report carries the dev-build flag across the adapter', () => {
  it('preserves the native channel identity', async () => {
    const result = await adapterReporting({
      platform: 'android',
      channel: 'beta',
      capabilities: CAPABILITIES,
      devBuild: false,
    }).getCapabilityReport();

    expect(result.status === 'ok' && result.value.channel).toBe('beta');
  });
  it('drops legacy build-default connection metadata from the native host', async () => {
    const result = await adapterReporting({
      platform: 'android',
      channel: 'beta',
      capabilities: CAPABILITIES,
      devBuild: false,
      mobileDefaultEndpoint: 'https://station.example.test:8442',
    }).getCapabilityReport();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Expected a valid report');
    expect(result.value).not.toHaveProperty('mobileDefaultEndpoint');
  });

  it('preserves devBuild: true from the host', async () => {
    const result = await adapterReporting({
      platform: 'android',
      capabilities: CAPABILITIES,
      devBuild: true,
    }).getCapabilityReport();

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.value.devBuild).toBe(true);
  });

  it('reports release when the host says devBuild: false', async () => {
    const result = await adapterReporting({
      platform: 'android',
      capabilities: CAPABILITIES,
      devBuild: false,
    }).getCapabilityReport();

    expect(result.status === 'ok' && result.value.devBuild).toBe(false);
  });

  it('reports release when an older host omits the field entirely', async () => {
    const result = await adapterReporting({
      platform: 'android',
      capabilities: CAPABILITIES,
    }).getCapabilityReport();

    expect(result.status === 'ok' && result.value.devBuild).toBe(false);
  });

  it('does not treat a truthy non-boolean as a dev build', async () => {
    // A release install tinted as dev is worse than a dev build left plain.
    const result = await adapterReporting({
      platform: 'android',
      capabilities: CAPABILITIES,
      devBuild: 'yes',
    }).getCapabilityReport();

    expect(result.status === 'ok' && result.value.devBuild).toBe(false);
  });

  it('still rejects a structurally invalid report', async () => {
    const result = await adapterReporting({
      platform: 'android',
      capabilities: [],
      devBuild: true,
    }).getCapabilityReport();

    expect(result.status).toBe('error');
  });
});

describe('capability report forward compatibility', () => {
  const report = (capabilities: unknown[]) =>
    adapterReporting({
      platform: 'android',
      capabilities,
    }).getCapabilityReport();

  it('skips a capability id this UI does not know and keeps the rest', async () => {
    const adapter = adapterReporting({
      platform: 'android',
      capabilities: [
        ...CAPABILITIES,
        { id: 'future-capability', state: 'enabled', reason: 'newer shell' },
      ],
    });
    const result = await adapter.getCapabilityReport();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Expected a valid report');
    expect(result.value.capabilities.map(({ id }) => id)).not.toContain(
      'future-capability',
    );
    expect(adapter.capability('image-share-intake').state).toBe('enabled');
    expect(
      adapter.capability('image-share-intake').reportVerified,
    ).toBeUndefined();
  });

  it('still rejects a malformed entry for a known id', async () => {
    const malformed = CAPABILITIES.map((capability) =>
      capability.id === 'haptics'
        ? { ...capability, state: 'sometimes' }
        : capability,
    );
    expect((await report(malformed)).status).toBe('error');
    const noReason = CAPABILITIES.map((capability) =>
      capability.id === 'haptics' ? { ...capability, reason: '' } : capability,
    );
    expect((await report(noReason)).status).toBe('error');
  });

  it('rejects a malformed entry for an optional known id', async () => {
    for (const id of ['image-share-intake', 'clipboard-image']) {
      const corrupted = CAPABILITIES.map((capability) =>
        capability.id === id
          ? { ...capability, state: 'sometimes' }
          : capability,
      );
      expect((await report(corrupted)).status).toBe('error');
    }
  });

  it('still rejects an entry that is not a capability at all', async () => {
    expect((await report([...CAPABILITIES, 'haptics'])).status).toBe('error');
    expect((await report([...CAPABILITIES, { state: 'enabled' }])).status).toBe(
      'error',
    );
  });

  it('still rejects duplicates and a missing required id', async () => {
    expect((await report([...CAPABILITIES, CAPABILITIES[0]])).status).toBe(
      'error',
    );
    expect(
      (
        await report(
          CAPABILITIES.filter(({ id }) => id !== 'capability-report'),
        )
      ).status,
    ).toBe('error');
    const unknownTwice = {
      id: 'future-capability',
      state: 'enabled',
      reason: 'x',
    };
    expect(
      (await report([...CAPABILITIES, unknownTwice, unknownTwice])).status,
    ).toBe('error');
  });
});
