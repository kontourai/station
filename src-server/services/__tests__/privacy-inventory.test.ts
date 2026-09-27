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
  renderPrivacyPolicy,
} from '../privacy-inventory.js';

function syntheticEntry(
  linkedToIdentity: boolean,
  usedForTracking: boolean,
): PrivacyInventoryEntry {
  return {
    id: 'synthetic',
    storeDataType: 'Other User Content',
    linkedToIdentity,
    usedForTracking,
    purpose: 'App Functionality',
    collection: 'synthetic condition',
    destination: 'synthetic destination',
    evidence: ['synthetic source'],
  };
}

describe('privacy inventory', () => {
  test('renders every store artifact from the single inventory', () => {
    expect(() =>
      assertPrivacyRenderedArtifacts((path) =>
        readFileSync(join(process.cwd(), path), 'utf8'),
      ),
    ).not.toThrow();
  });

  test('keeps default renderer output byte-identical to the committed artifacts', () => {
    for (const [path, rendered] of [
      ['src-desktop/gen/apple/PrivacyInfo.xcprivacy', renderPrivacyInfo()],
      ['docs/reference/play-data-safety.md', renderPlayDataSafety()],
      ['docs/privacy-policy.md', renderPrivacyPolicy()],
    ]) {
      expect(Buffer.from(rendered)).toEqual(
        readFileSync(join(process.cwd(), path)),
      );
    }
  });

  const flagPairs = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const;
  for (const [firstLinked, firstTracking] of flagPairs) {
    for (const [lastLinked, lastTracking] of flagPairs) {
      test(`aggregates duplicate Apple flags ${firstLinked}/${firstTracking} then ${lastLinked}/${lastTracking}`, () => {
        const first = syntheticEntry(firstLinked, firstTracking);
        const last = {
          ...syntheticEntry(lastLinked, lastTracking),
          id: 'second-synthetic',
        };
        const before = structuredClone([first, last]);
        const linked = firstLinked || lastLinked;
        const tracking = firstTracking || lastTracking;
        const rendered = renderPrivacyInfo([first, last]);
        expect(rendered).toBe(
          renderPrivacyInfo([syntheticEntry(linked, tracking)]),
        );
        expect(rendered).toBe(renderPrivacyInfo([last, first]));
        expect(rendered).toContain(
          `<key>NSPrivacyCollectedDataTypeLinked</key><${linked}/><key>NSPrivacyCollectedDataTypeTracking</key><${tracking}/>`,
        );
        expect(rendered).toContain(
          `<key>NSPrivacyTracking</key>\n  <${tracking}/>`,
        );
        expect([first, last]).toEqual(before);
      });
    }
  }

  test('keeps Apple category and purpose groups separate', () => {
    const rendered = renderPrivacyInfo([
      syntheticEntry(true, true),
      { ...syntheticEntry(false, false), purpose: 'Analytics' },
      { ...syntheticEntry(false, false), storeDataType: 'Audio Data' },
    ]);
    expect(rendered).toContain(
      '<string>NSPrivacyCollectedDataTypeOtherUserContent</string><key>NSPrivacyCollectedDataTypeLinked</key><false/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string>NSPrivacyCollectedDataTypePurposeAnalytics</string>',
    );
    expect(rendered).toContain(
      '<string>NSPrivacyCollectedDataTypeAudioData</string><key>NSPrivacyCollectedDataTypeLinked</key><false/><key>NSPrivacyCollectedDataTypeTracking</key><false/>',
    );
  });

  test.each(flagPairs)(
    'uses only supplied Play inventory with linked=%s tracking=%s',
    (linked, tracking) => {
      const entry = syntheticEntry(linked, tracking);
      const rendered = renderPlayDataSafety([entry]);
      expect(rendered).toContain(
        `- **Is any data used for tracking?** ${tracking ? 'Yes.' : 'No.'}`,
      );
      expect(rendered).toContain(
        `| \`synthetic\` | Other User Content | Conditional as described | synthetic destination | App Functionality | ${linked ? 'Yes' : 'No'} | ${tracking ? 'Yes' : 'No'} |`,
      );
      const detail = rendered.split('## Inventory mapping and evidence\n\n')[1];
      expect(detail).toContain(
        `| \`synthetic\` | Other User Content | ${linked} | ${tracking} | App Functionality | synthetic condition | synthetic destination | \`synthetic source\` |`,
      );
      expect(rendered).not.toContain('product-usage-telemetry');
      expect(entry).toEqual(syntheticEntry(linked, tracking));
    },
  );

  test('reports tracking for mixed Play entries in either order and none for empty input', () => {
    const tracked = syntheticEntry(false, true);
    const untracked = { ...syntheticEntry(false, false), id: 'untracked' };
    for (const inventory of [
      [tracked, untracked],
      [untracked, tracked],
    ]) {
      expect(renderPlayDataSafety(inventory)).toContain(
        '- **Is any data used for tracking?** Yes.',
      );
    }
    expect(renderPlayDataSafety([])).toContain(
      '- **Is any data used for tracking?** No.',
    );
    expect(renderPlayDataSafety([])).not.toContain('| `');
    expect(renderPrivacyInfo([])).toContain(
      '<key>NSPrivacyTracking</key>\n  <false/>',
    );
  });

  test('renders the published policy as a public projection without private-repository framing', () => {
    const policy = renderPrivacyPolicy();
    expect(policy).toContain(
      'The published page is a public projection of this inventory: it states the same facts without the contributor-oriented code-evidence paths.',
    );
    expect(policy).not.toContain('this repository is private');
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
   * archive#2484 is the entry that needs it.
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
    // entry happening to be linked, so it broke the moment archive#2484 made
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
