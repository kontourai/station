import { expect, test } from 'vitest';
import {
  createMacosNotarizedArtifacts,
  outerAppDesignatedRequirement,
} from './macos-notarized-artifacts.mjs';

const CERTIFICATE_BACKED_REQUIREMENT =
  'identifier "io.kontourai.station" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = U7KHF2QAC4';
const CURRENT_CODESIGN_OUTPUT = `Executable=/app/Station.app/Contents/MacOS/Station\ndesignated => ${CERTIFICATE_BACKED_REQUIREMENT}`;
const CURRENT_CODESIGN_CAPTURE = { status: 0, stdout: `designated => ${CERTIFICATE_BACKED_REQUIREMENT}`, stderr: 'Executable=/app/Station.app/Contents/MacOS/Station' };
const LEGACY_CODESIGN_OUTPUT = `Designated Requirement=${CERTIFICATE_BACKED_REQUIREMENT}`;

function fixture({
  files = ['Station.app'],
  reject = false,
  designatedRequirement = CURRENT_CODESIGN_OUTPUT,
  entitlementOutput = { status: 0, stdout: '', stderr: 'Executable=/app/Station.app\n' },
} = {}) {
  const calls = []; let signed = false; const removed = [];
  const fs = {
    existsSync: (file) => file === '/app/Station.app' || file === '/key' || (signed && file.endsWith('.sig')),
    mkdirSync() {}, mkdtempSync: () => '/scratch', readdirSync: () => files,
    rmSync: (file) => removed.push(file),
  };
  const run = (program, args, capture) => {
    calls.push([program, args, capture]);
    if (program === 'xcrun' && args[1] === 'submit') return { status: 0, stdout: JSON.stringify({ status: reject ? 'Invalid' : 'Accepted' }), stderr: '' };
    if (program === '/usr/libexec/PlistBuddy') return { status: 0, stdout: 'io.kontourai.station', stderr: '' };
    if (program === 'codesign' && args[0] === '-dvv') return { status: 0, stdout: '', stderr: 'Authority=Developer ID Application: Kontour AI LLC (U7KHF2QAC4)\nTeamIdentifier=U7KHF2QAC4\nTimestamp=now\nCodeDirectory flags=0x10000(runtime)' };
    if (program === 'codesign' && args.includes('-r-')) return typeof designatedRequirement === 'string' ? { status: 0, stdout: '', stderr: designatedRequirement } : designatedRequirement;
    if (program === 'codesign' && args.includes('--entitlements')) return entitlementOutput;
    if (program === 'npx') signed = true;
    return '';
  };
  const options = { app: '/app/Station.app', identity: 'Developer ID', notaryKey: '/key', notaryKeyId: 'key', notaryIssuer: 'issuer', assetsDir: '/assets', releaseTag: 'v1.2.3', architecture: 'aarch64', bundleId: 'io.kontourai.station' };
  return { calls, fs, options, removed, run };
}

function assertRejectedBeforeSubmission(designatedRequirement) {
  const { calls, fs, options, run } = fixture({ designatedRequirement });
  expect(() => createMacosNotarizedArtifacts(options, { fs, run })).toThrow(/designated requirement/i);
  expect(calls.some(([program, args]) => program === 'xcrun' && args[1] === 'submit')).toBe(false);
}

function assertEntitlementsRejectedBeforeSubmission(entitlementOutput) {
  const { calls, fs, options, run } = fixture({ entitlementOutput });
  expect(() => createMacosNotarizedArtifacts(options, { fs, run })).toThrow(/unexpected entitlements/i);
  expect(calls.some(([program, args]) => program === 'xcrun' && args[1] === 'submit')).toBe(false);
}

test('normalizes the current canonical and legacy designated-requirement output', () => {
  expect(outerAppDesignatedRequirement(CURRENT_CODESIGN_OUTPUT)).toBe(CERTIFICATE_BACKED_REQUIREMENT);
  expect(outerAppDesignatedRequirement(`  Designated Requirement = ${CERTIFICATE_BACKED_REQUIREMENT}\r\n`)).toBe(CERTIFICATE_BACKED_REQUIREMENT);
});

test('accepts the physical split-stream, current, and legacy designated-requirement output before submitting', () => {
  for (const designatedRequirement of [CURRENT_CODESIGN_CAPTURE, CURRENT_CODESIGN_OUTPUT, LEGACY_CODESIGN_OUTPUT]) {
    const { calls, fs, options, run } = fixture({ designatedRequirement });
    createMacosNotarizedArtifacts(options, { fs, run });
    expect(calls.some(([program, args]) => program === 'xcrun' && args[1] === 'submit')).toBe(true);
  }
});

test('uses the supported empty-entitlements output target for the outer app', () => {
  const { calls, fs, options, run } = fixture();
  createMacosNotarizedArtifacts(options, { fs, run });
  expect(calls).toContainEqual([
    'codesign',
    ['-d', '--entitlements', '-', '--xml', '/app/Station.app'],
    true,
  ]);
});

test('rejects deprecated-warning and non-exact outer empty-entitlements output before submission', () => {
  const executable = 'Executable=/app/Station.app\n';
  const variants = [
    {
      status: 0,
      stdout: '',
      stderr: `${executable}warning: Specifying ':' in the path is deprecated and will not work in a future release`,
    },
    { status: 0, stdout: '<plist version="1.0"/>', stderr: executable },
    { status: 0, stdout: '', stderr: 'Executable=/app/StationXapp\n' },
    { status: 0, stdout: '', stderr: `${executable}${executable}` },
    { status: 1, stdout: '', stderr: executable },
  ];
  for (const variant of variants) assertEntitlementsRejectedBeforeSubmission(variant);
});

test('rejects duplicate, malformed, unexpected, oversized, or invalid split-stream designated requirements before submission', () => {
  const valid = `designated => ${CERTIFICATE_BACKED_REQUIREMENT}`;
  const variants = [
    { status: 0, stdout: valid, stderr: `Executable=/app/Station.app/Contents/MacOS/Station\n${valid}` },
    { status: 0, stdout: valid, stderr: `Designated Requirement=${CERTIFICATE_BACKED_REQUIREMENT}` },
    { status: 0, stdout: valid, stderr: 'Designated Requirement=' },
    { status: 0, stdout: valid, stderr: `designated  => ${CERTIFICATE_BACKED_REQUIREMENT}` },
    { status: 0, stdout: valid, stderr: 'codesign emitted another diagnostic' },
    { status: 0, stdout: valid, stderr: 'Executable=/app/Station.app\nExecutable=/app/Station.app' },
    { status: 0, stdout: `${valid}\n${'x'.repeat(64 * 1024)}`, stderr: '' },
    { status: 1, stdout: valid, stderr: 'Executable=/app/Station.app' },
    { status: 0, stdout: `designated => ${CERTIFICATE_BACKED_REQUIREMENT.replace('anchor apple generic', 'anchor apple')}`, stderr: 'Executable=/app/Station.app' },
    { status: 0, stdout: `designated => ${CERTIFICATE_BACKED_REQUIREMENT.replace('U7KHF2QAC4', 'NOTKONTOUR')}`, stderr: 'Executable=/app/Station.app' },
    { status: 0, stdout: `designated => ${CERTIFICATE_BACKED_REQUIREMENT.replace('io.kontourai.station', 'io.kontourai.station.beta')}`, stderr: 'Executable=/app/Station.app' },
    { status: 0, stdout: `designated => ${CERTIFICATE_BACKED_REQUIREMENT} and cdhash H"deadbeef"`, stderr: 'Executable=/app/Station.app' },
  ];
  for (const variant of variants) assertRejectedBeforeSubmission(variant);
});

test('rejects malformed, ambiguous, mixed, ad-hoc, or non-Kontour designated requirements before submission', () => {
  const variants = [
    'designated => cdhash H"deadbeef"',
    CURRENT_CODESIGN_OUTPUT.replace('anchor apple generic', 'anchor apple'),
    CURRENT_CODESIGN_OUTPUT.replace('io.kontourai.station', 'io.kontourai.station.beta'),
    CURRENT_CODESIGN_OUTPUT.replace('U7KHF2QAC4', 'NOTKONTOUR'),
    CURRENT_CODESIGN_OUTPUT.replace('certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and ', ''),
    CURRENT_CODESIGN_OUTPUT.replace('certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and ', ''),
    `${CURRENT_CODESIGN_OUTPUT} or identifier "io.kontourai.station"`,
    CURRENT_CODESIGN_OUTPUT.replace('designated => ', 'designated => => '),
    LEGACY_CODESIGN_OUTPUT.replace('Requirement=', 'Requirement=='),
    'designated =>',
    'codesign produced no designated requirement',
    `${CURRENT_CODESIGN_OUTPUT}\ndesignated => ${CERTIFICATE_BACKED_REQUIREMENT}`,
    `${CURRENT_CODESIGN_OUTPUT}\n${LEGACY_CODESIGN_OUTPUT}`,
    `${CURRENT_CODESIGN_OUTPUT}\nDesignated Requirement=`,
    `${CURRENT_CODESIGN_OUTPUT}\nDesignated  Requirement=${CERTIFICATE_BACKED_REQUIREMENT}`,
    `${CURRENT_CODESIGN_OUTPUT}\nDesignated => ${CERTIFICATE_BACKED_REQUIREMENT}`,
    `${CURRENT_CODESIGN_OUTPUT}\nDESIGNATED => ${CERTIFICATE_BACKED_REQUIREMENT}`,
    `${CURRENT_CODESIGN_OUTPUT}\nDESIGNATED REQUIREMENT=${CERTIFICATE_BACKED_REQUIREMENT}`,
  ];
  for (const variant of variants) assertRejectedBeforeSubmission(variant);
});

test('does not assess Gatekeeper until the accepted app has been stapled', () => {
  const { calls, fs, options, run } = fixture();
  createMacosNotarizedArtifacts(options, { fs, run });
  const assess = calls.findIndex(([p, a]) => p === 'spctl' && a.includes('execute') && a.includes('/app/Station.app'));
  const staple = calls.findIndex(([p, a]) => p === 'xcrun' && a[1] === 'staple' && a.includes('/app/Station.app'));
  const submit = calls.findIndex(([p, a]) => p === 'xcrun' && a[1] === 'submit' && a.includes('/scratch/notarization-input.zip'));
  expect(submit).toBeLessThan(staple); expect(staple).toBeLessThan(assess);
});

test('cleans scratch state when notarization rejects', () => {
  const { fs, options, removed, run } = fixture({ reject: true });
  expect(() => createMacosNotarizedArtifacts(options, { fs, run })).toThrow(/rejected/);
  expect(removed).toContain('/scratch');
});

test('rejects a DMG root other than exactly the expected application', () => {
  const { fs, options, run } = fixture({ files: ['Contents'] });
  expect(() => createMacosNotarizedArtifacts(options, { fs, run })).toThrow(/exactly/);
});
