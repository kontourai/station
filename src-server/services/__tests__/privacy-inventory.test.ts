import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PrivacyInventoryEntry } from '../privacy-inventory.js';
import {
  assertPrivacyInventoryCoversUsageTelemetry,
  assertPrivacyRenderedArtifacts,
  PRIVACY_RENDERED_ARTIFACTS,
  renderPlayDataSafety,
  renderPrivacyInfo,
} from '../privacy-inventory.js';

describe('privacy inventory', () => {
  test('renders every store artifact from the single inventory', () => {
    expect(() =>
      assertPrivacyRenderedArtifacts((path) =>
        readFileSync(join(process.cwd(), path), 'utf8'),
      ),
    ).not.toThrow();
  });

  test('covers the real telemetry inventory', () => {
    expect(() => assertPrivacyInventoryCoversUsageTelemetry()).not.toThrow();
  });

  test('DRIFT DEFECT: a new telemetry property names the unreviewed collection', () => {
    expect(() =>
      assertPrivacyInventoryCoversUsageTelemetry({
        station_started: {
          properties: { version: {}, platform: {}, arch: {}, prompt: {} },
        },
      }),
    ).toThrow(
      'Privacy inventory drift: telemetry property "station_started.prompt" is not declared.',
    );
  });

  test('DRIFT DEFECT: an edited rendered declaration names the artifact', () => {
    expect(() =>
      assertPrivacyRenderedArtifacts((path) =>
        path === 'src-desktop/gen/apple/PrivacyInfo.xcprivacy'
          ? 'PrivacyInfo.xcprivacy edited outside the inventory'
          : PRIVACY_RENDERED_ARTIFACTS[path],
      ),
    ).toThrow(
      'Privacy inventory drift: rendered artifact "src-desktop/gen/apple/PrivacyInfo.xcprivacy" does not match the inventory.',
    );
  });

  /**
   * The renderer originally hardcoded `<false/>` for both Apple flags and typed
   * the inventory fields as the literal `false`, so an honest "this is linked"
   * declaration was unrepresentable AND unreachable — the iOS manifest would
   * have claimed unlinked regardless of what the inventory said. That is the
   * defect this inventory exists to prevent, sitting inside the renderer.
   * station#2484 is the entry that needs it.
   */
  test('propagates linkage and tracking from the inventory into the Apple manifest', () => {
    const entry = (
      linkedToIdentity: boolean,
      usedForTracking: boolean,
    ): PrivacyInventoryEntry => ({
      id: 'synthetic',
      storeDataType: 'Other Usage Data',
      linkedToIdentity,
      usedForTracking,
      purpose: 'Analytics',
      collection: 'synthetic',
      destination: 'synthetic',
      evidence: ['synthetic'],
    });

    expect(
      renderPrivacyInfo([entry(true, false)]),
      'a linked inventory entry did not render NSPrivacyCollectedDataTypeLinked true — the Apple manifest would declare unlinked whatever the inventory says',
    ).toContain('<key>NSPrivacyCollectedDataTypeLinked</key><true/>');
    expect(
      renderPrivacyInfo([entry(false, false)]),
      'an unlinked inventory entry did not render NSPrivacyCollectedDataTypeLinked false',
    ).toContain('<key>NSPrivacyCollectedDataTypeLinked</key><false/>');
    expect(
      renderPrivacyInfo([entry(false, true)]),
      'a tracking inventory entry did not render NSPrivacyCollectedDataTypeTracking true',
    ).toContain('<key>NSPrivacyCollectedDataTypeTracking</key><true/>');
  });

  test('propagates linkage from the inventory into Play Data Safety', () => {
    // Synthetic entries for the same reason as the Apple test above: asserting
    // the "Yes" branch against the REAL inventory made this test depend on some
    // entry happening to be linked, so it broke the moment station#2484 made
    // them all false — and would have silently stopped proving anything if it
    // had been written to assert the "No" branch instead.
    const entry = (linkedToIdentity: boolean): PrivacyInventoryEntry => ({
      id: 'synthetic',
      storeDataType: 'Performance and Diagnostics',
      linkedToIdentity,
      usedForTracking: false,
      purpose: 'Analytics',
      collection: 'synthetic',
      destination: 'synthetic',
      evidence: ['synthetic'],
    });

    expect(
      renderPlayDataSafety([entry(true)]),
      'a linked inventory entry did not flip the Play headline answer to Yes',
    ).toContain('- **Is any data linked to a user identity?** Yes.');
    expect(
      renderPlayDataSafety([entry(true)]),
      'a linked inventory entry did not render Linked=Yes in the Play summary table',
    ).toContain('| Analytics | Yes | No |');
    expect(
      renderPlayDataSafety([entry(false)]),
      'an unlinked inventory entry did not render the Play headline answer as No',
    ).toContain('- **Is any data linked to a user identity?** No.');
  });
});
