import { describe, expect, it } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import { WebNativePlatformAdapter } from '../web';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

/**
 * archive#3677, 1 gap: nothing pinned the capability id →
 * adapter → EXACT Tauri command-name wiring, so a rename on either side
 * would have gone silently green (the component tests mock the hook, and
 * the Rust tests never see the JS command string).
 */

const BROKER_REPORT = completeNativeCapabilityReport('macos', {
  'native-consent-broker': { state: 'enabled' },
});
const NO_BROKER_REPORT = completeNativeCapabilityReport('macos', {
  'native-consent-broker': { state: 'unsupported' },
});

function adapterFor(
  report: ReturnType<typeof completeNativeCapabilityReport>,
  calls: Array<{ command: string; args?: unknown }>,
  outcome: unknown = { status: 'approved' },
) {
  return new TauriNativePlatformAdapter({
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'native_capability_report') {
        return {
          platform: 'macos',
          capabilities: report.capabilities,
        } as never;
      }
      return outcome as never;
    },
    listen: async () => () => {},
  });
}

describe('native consent broker host capability', () => {
  it('is unsupported in the web adapter, which keeps the distinct-origin consent page', async () => {
    const adapter = new WebNativePlatformAdapter();
    expect(adapter.capability('native-consent-broker').state).toBe(
      'unsupported',
    );
    await expect(adapter.reviewConsentNatively('txn-1')).resolves.toMatchObject(
      { status: 'unsupported', command: 'review-consent-natively' },
    );
  });

  it('invokes the exact Rust command name with the exact argument name once the host reports the capability', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = adapterFor(BROKER_REPORT, calls);
    await adapter.getCapabilityReport();

    await expect(adapter.reviewConsentNatively('txn-42')).resolves.toEqual({
      status: 'ok',
      value: { status: 'approved' },
    });
// Both halves are the contract with src-desktop/src/lib.rs: the command
// is `station_native_consent_review` and its one parameter arrives as
// `requestId` (serde renames `request_id` camelCase).
    expect(calls).toContainEqual({
      command: 'station_native_consent_review',
      args: { requestId: 'txn-42' },
    });
  });

  it('does not invoke anything while the host does not report the capability', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = adapterFor(NO_BROKER_REPORT, calls);
    await adapter.getCapabilityReport();

    await expect(adapter.reviewConsentNatively('txn-1')).resolves.toMatchObject(
      { status: 'unsupported', command: 'review-consent-natively' },
    );
    expect(
      calls.filter(({ command }) => command !== 'native_capability_report'),
    ).toEqual([]);
  });

  it('reports an error rather than a settled status when the host returns an unexpected shape', async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const adapter = adapterFor(BROKER_REPORT, calls, { notAStatus: true });
    await adapter.getCapabilityReport();

    await expect(adapter.reviewConsentNatively('txn-1')).resolves.toMatchObject(
      { status: 'error', command: 'review-consent-natively' },
    );
  });
});
