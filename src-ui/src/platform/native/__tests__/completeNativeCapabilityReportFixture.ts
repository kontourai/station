import type {
  NativeCapabilityId,
  NativeCapabilityReport,
  NativeCapabilityState,
} from '../types';

type CapabilityFixtureValue = Readonly<{
  state: NativeCapabilityState;
  reason: string;
}>;

export type NativeCapabilityFixtureOverrides = Partial<
  Record<NativeCapabilityId, Partial<CapabilityFixtureValue>>
>;

/**
 * One complete Tauri report for UI fixtures. Keeping this exhaustive means a
 * newly declared native capability must be considered here before a synthetic
 * host can claim to have returned a complete report.
 */
const COMPLETE_NATIVE_CAPABILITY_FIXTURE = {
  'capability-report': {
    state: 'enabled',
    reason: 'fixture',
  },
  'desktop-tray': {
    state: 'disabled',
    reason: 'fixture',
  },
  haptics: {
    state: 'disabled',
    reason: 'fixture',
  },
  'host-event-bridge': {
    state: 'enabled',
    reason: 'fixture',
  },
  'host-credential-broker': {
    state: 'enabled',
    reason: 'fixture',
  },
  'native-consent-broker': {
    state: 'enabled',
    reason: 'fixture',
  },
  'local-browser-preview': {
    state: 'disabled',
    reason: 'fixture',
  },
  'workspace-pane-pop-out': {
    state: 'disabled',
    reason: 'fixture',
  },
  'pairing-deep-link': {
    state: 'disabled',
    reason: 'fixture',
  },
  'remote-push': {
    state: 'unsupported',
    reason: 'fixture',
  },
  'share-intake': {
    state: 'disabled',
    reason: 'fixture',
  },
} satisfies Record<NativeCapabilityId, CapabilityFixtureValue>;

export function completeNativeCapabilityReport(
  platform: NativeCapabilityReport['platform'] = 'macos',
  overrides: NativeCapabilityFixtureOverrides = {},
): NativeCapabilityReport {
  return {
    platform,
    capabilities: (
      Object.entries(COMPLETE_NATIVE_CAPABILITY_FIXTURE) as Array<
        [NativeCapabilityId, CapabilityFixtureValue]
      >
    ).map(([id, capability]) => ({
      id,
      ...capability,
      ...overrides[id],
    })),
  };
}
