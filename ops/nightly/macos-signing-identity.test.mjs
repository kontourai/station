import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  designatedRequirementFromCodesignOutput,
  runMacosSigningIdentityCli,
  selectNightlyMacosSigningIdentity,
  signingIdentityRecordsFromSecurityOutput,
} from './macos-signing-identity.mjs';

const CLI = resolve(import.meta.dirname, 'macos-signing-identity.mjs');

const APPLE_DISTRIBUTION = 'Apple Distribution: Kontour AI LLC (U7KHF2QAC4)';
const APPLE_DEVELOPMENT = 'Apple Development: Kontour AI LLC (U7KHF2QAC4)';
const DEVELOPER_ID = 'Developer ID Application: Kontour AI LLC (U7KHF2QAC4)';
const APPLE_DISTRIBUTION_SHA = 'A'.repeat(40);
const DEVELOPER_ID_SHA = 'B'.repeat(40);
const DEVELOPER_ID_RENEWAL_SHA = 'C'.repeat(40);
const STABLE_REQUIREMENT =
  'designated => anchor apple generic and identifier "io.kontourai.station.nightly" and certificate leaf[subject.OU] = "U7KHF2QAC4"';
const AD_HOC_CODESIGN_OUTPUT =
  'Executable=/Applications/Station Nightly.app/Contents/MacOS/Station Nightly\n# designated => cdhash H"deadbeef"';
const STABLE_CODESIGN_OUTPUT =
  'Executable=/Applications/Station Nightly.app/Contents/MacOS/Station Nightly\ndesignated => anchor apple generic and identifier "io.kontourai.station.nightly" and certificate leaf[subject.OU] = "U7KHF2QAC4"';

describe('Nightly macOS signing identity', () => {
  it('selects the one approved identity deterministically from mocked security output', () => {
    const output = `
      2) ${'D'.repeat(40)} "Other Developer ID Application: Elsewhere (AAAAAAA)"
      1) ${DEVELOPER_ID_SHA} "${DEVELOPER_ID}"
      3) ${'0'.repeat(40)} "Mac Developer: Kontour AI LLC (U7KHF2QAC4)"
    `;
    const discovered = signingIdentityRecordsFromSecurityOutput(output);

    expect(discovered).toEqual([
      { fingerprint: DEVELOPER_ID_SHA, name: DEVELOPER_ID },
    ]);
    expect(
      selectNightlyMacosSigningIdentity({ discoveredIdentities: discovered }),
    ).toBe(DEVELOPER_ID_SHA);
  });

  it('resolves renewal-overlap certificates only through their exact approved fingerprint', () => {
    const discovered = [
      { fingerprint: DEVELOPER_ID_SHA, name: DEVELOPER_ID },
      { fingerprint: DEVELOPER_ID_RENEWAL_SHA, name: DEVELOPER_ID },
    ];

    expect(() =>
      selectNightlyMacosSigningIdentity({
        explicitIdentity: DEVELOPER_ID,
        discoveredIdentities: discovered,
      }),
    ).toThrow(/exact SHA-1 fingerprint/);
    expect(
      selectNightlyMacosSigningIdentity({
        explicitIdentity: DEVELOPER_ID_RENEWAL_SHA,
        discoveredIdentities: discovered,
      }),
    ).toBe(DEVELOPER_ID_RENEWAL_SHA);
    expect(() =>
      selectNightlyMacosSigningIdentity({
        explicitIdentity: APPLE_DISTRIBUTION_SHA,
        discoveredIdentities: discovered,
      }),
    ).toThrow(/not an installed approved/);
  });

  it('deduplicates one certificate repeated by multiple Keychain search entries', () => {
    const output = `
      1) ${DEVELOPER_ID_SHA} "${DEVELOPER_ID}"
      2) ${DEVELOPER_ID_SHA} "${DEVELOPER_ID}"
    `;
    const discovered = signingIdentityRecordsFromSecurityOutput(output);

    expect(discovered).toEqual([
      { fingerprint: DEVELOPER_ID_SHA, name: DEVELOPER_ID },
    ]);
    expect(
      selectNightlyMacosSigningIdentity({ discoveredIdentities: discovered }),
    ).toBe(DEVELOPER_ID_SHA);
  });

  it('prefers an explicit approved identity but rejects ad-hoc and unapproved choices', () => {
    const discovered = [{ fingerprint: DEVELOPER_ID_SHA, name: DEVELOPER_ID }];

    expect(
      selectNightlyMacosSigningIdentity({
        explicitIdentity: DEVELOPER_ID_SHA,
        discoveredIdentities: discovered,
      }),
    ).toBe(DEVELOPER_ID_SHA);
    expect(() =>
      selectNightlyMacosSigningIdentity({
        explicitIdentity: '-',
        discoveredIdentities: discovered,
      }),
    ).toThrow(/ad-hoc signing/);
    expect(() =>
      selectNightlyMacosSigningIdentity({
        explicitIdentity: APPLE_DISTRIBUTION,
        discoveredIdentities: discovered,
      }),
    ).toThrow(/Developer ID Application/);
  });

  it('rejects App Store and development identities even when a caller passes matching fingerprint records directly', () => {
    for (const name of [APPLE_DISTRIBUTION, APPLE_DEVELOPMENT]) {
      const discovered = [{ fingerprint: APPLE_DISTRIBUTION_SHA, name }];
      expect(() =>
        selectNightlyMacosSigningIdentity({
          explicitIdentity: APPLE_DISTRIBUTION_SHA,
          discoveredIdentities: discovered,
        }),
      ).toThrow(/not an installed approved/);
      expect(() =>
        selectNightlyMacosSigningIdentity({ discoveredIdentities: discovered }),
      ).toThrow(/No approved Kontour Developer ID Application/);
    }
  });

  it('requires an actionable explicit choice when stable identities are absent or ambiguous', () => {
    expect(() =>
      selectNightlyMacosSigningIdentity({ discoveredIdentities: [] }),
    ).toThrow(/No approved Kontour/);
    expect(() =>
      selectNightlyMacosSigningIdentity({
        discoveredIdentities: [
          { fingerprint: DEVELOPER_ID_SHA, name: DEVELOPER_ID },
          { fingerprint: DEVELOPER_ID_RENEWAL_SHA, name: DEVELOPER_ID },
        ],
      }),
    ).toThrow(/Multiple approved Kontour/);
  });

  it('parses the certificate-backed designated requirement and rejects CDHash-only output', () => {
    expect(
      designatedRequirementFromCodesignOutput(STABLE_CODESIGN_OUTPUT),
    ).toBe(STABLE_REQUIREMENT.slice('designated => '.length));
    expect(() =>
      designatedRequirementFromCodesignOutput(AD_HOC_CODESIGN_OUTPUT),
    ).toThrow(/CDHash-only/);
  });

  // The installer pipes the existing app's `codesign -d -r-` output into this
  // CLI mode with the validated candidate requirement and stops on non-zero.
  it('allows the one observable ad-hoc migration but refuses a stable requirement change at the installer CLI', () => {
    const candidate = STABLE_REQUIREMENT.slice('designated => '.length);
    const transition = (existingCodesignOutput, candidateRequirement) =>
      spawnSync(
        process.execPath,
        [CLI, '--designated-requirement-transition', candidateRequirement],
        { input: existingCodesignOutput, encoding: 'utf8' },
      );

    const adHoc = transition(AD_HOC_CODESIGN_OUTPUT, candidate);
    expect(adHoc.status).toBe(0);
    expect(adHoc.stdout).toContain(
      'Migrating the existing ad-hoc Station Nightly signature',
    );

    const unchanged = transition(STABLE_CODESIGN_OUTPUT, candidate);
    expect(unchanged).toMatchObject({ status: 0, stdout: '', stderr: '' });

    const changed = transition(
      STABLE_CODESIGN_OUTPUT,
      'anchor apple generic and identifier "io.kontourai.station.nightly" and certificate leaf[subject.OU] = "OTHERTEAM"',
    );
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(
      'Existing Station Nightly has a different stable designated requirement',
    );

    const unreadable = transition('Executable=/Applications/x\n', candidate);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain('no readable designated requirement');
  });

  it('does not read interactive stdin before normal identity selection', async () => {
    await expect(
      runMacosSigningIdentityCli({
        currentIdentity: () => DEVELOPER_ID_SHA,
        readInput: () => {
          throw new Error('stdin must stay untouched for normal selection');
        },
      }),
    ).resolves.toBe(DEVELOPER_ID_SHA);
  });
});
