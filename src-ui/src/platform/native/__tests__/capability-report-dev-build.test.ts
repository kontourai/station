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
 * under a passing-looking name (station#1667). A `Record` over the closed
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
  it('preserves a trusted mobile build-default HTTPS origin', async () => {
    const result = await adapterReporting({
      platform: 'android',
      channel: 'beta',
      capabilities: CAPABILITIES,
      devBuild: false,
      mobileDefaultEndpoint: 'https://station.example.test:8442',
    }).getCapabilityReport();

    expect(result.status === 'ok' && result.value.mobileDefaultEndpoint).toBe(
      'https://station.example.test:8442',
    );
  });

  it.each([
    'tauri://localhost',
    'http://100.64.0.1:28141',
    'https://user:secret@station.example.test',
    'https://station.example.test/path',
  ])(
    'drops an unsafe mobile build default without rejecting the report: %s',
    async (endpoint) => {
      const result = await adapterReporting({
        platform: 'android',
        capabilities: CAPABILITIES,
        mobileDefaultEndpoint: endpoint,
      }).getCapabilityReport();

      expect(result.status).toBe('ok');
      expect(
        result.status === 'ok' && result.value.mobileDefaultEndpoint,
      ).toBeUndefined();
    },
  );
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
