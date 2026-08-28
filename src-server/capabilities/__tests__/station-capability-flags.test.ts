import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopeIncludes,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import { describe, expect, test } from 'vitest';
import { STATION_CAPABILITY_FLAGS } from '../station-capability-flags.js';

describe('STATION_CAPABILITY_FLAGS (station#1095 registry)', () => {
  test('seeds exactly the real, existing features this slice + station#1092 + station#1398 claim', () => {
    expect(STATION_CAPABILITY_FLAGS).toEqual({
      sshEnvironments: true,
      webPushNotifications: true,
      eventStreamResume: true,
      sessionEventWindow: true,
      scopedPairing: true,
      fleetInference: true,
    });
  });

  test('every declared value is a real boolean (not a truthy/falsy stand-in)', () => {
    for (const value of Object.values(STATION_CAPABILITY_FLAGS)) {
      expect(typeof value).toBe('boolean');
    }
  });
});

describe('fleetInference is protocol support, never participation (station#1398 §3.3/§5.2)', () => {
  // The load-bearing test of this slice's handshake half. `fleetInference`
  // means "this build understands the `inference:invoke` token"; a build
  // that advertises it while `parsePairingScope` still rejects the token
  // invites a peer to mint a grant this Station refuses outright. The
  // coupling is two-way on purpose: it fails if the flag is advertised
  // early, AND it fails if the scope lands without the flag.
  test('is advertised if and only if this build can parse the inference:invoke token', () => {
    const buildParsesToken = parsePairingScope('inference:invoke') !== null;
    expect(Boolean(STATION_CAPABILITY_FLAGS.fleetInference)).toBe(
      buildParsesToken,
    );
  });

  test('slice 2 therefore advertises both the token and the flag', () => {
    expect(parsePairingScope('inference:invoke')).toEqual(['inference:invoke']);
    expect(STATION_CAPABILITY_FLAGS.fleetInference).toBe(true);
  });

  test('advertising the token did not widen the default grant (the decoupling this flip depended on)', () => {
    // The flag could only become honest because adding `inference:invoke`
    // to the vocabulary stopped implying anything about what an unscoped,
    // migrated, or bootstrap grant carries. If this regresses, the flag is
    // still "true" but every such credential silently gained fleet
    // invocation and every older peer is handed an unparseable string.
    expect(DEFAULT_GRANT_PAIRING_SCOPE).toBe(
      'orchestration:read orchestration:operate terminal:operate access:manage',
    );
    expect(
      pairingScopeIncludes(DEFAULT_GRANT_PAIRING_SCOPE, 'inference:invoke'),
    ).toBe(false);
  });

  test('the registry never reads Station config, so participation cannot leak into the public handshake', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../station-capability-flags.ts'),
      'utf-8',
    );
    // Strip block comments first, then line comments anywhere on a line —
    // a whole-line `//` filter would miss `fleetInference: derive(), // note`
    // and every `/* … */` docblock, so a real leak sitting next to a comment
    // could read as commentary and pass.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    // A later edit that derives any flag from the contribution opt-in — or
    // from AppConfig at all — turns a static protocol fact into a runtime
    // disclosure that any unauthenticated LAN scanner can read.
    for (const forbidden of [
      'fleetContribution',
      'AppConfig',
      'getAppConfig',
      'ConnectionService',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  test('no flag key or value names a contributed model, a connection, or a count', () => {
    const serialized = JSON.stringify(STATION_CAPABILITY_FLAGS).toLowerCase();
    for (const forbidden of [
      'contribut',
      'connectionids',
      'models',
      'participation',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // archive#1887: the token and its enforcement land in this slice; the
  // OPERATOR SURFACES (CLI verb, host route, device-list toggle) do not.
  // Until an operator can actually promote a device, advertising the
  // capability would be a false claim in the direction that matters — a
  // client would discover an affordance no human can reach. This pins the
  // flag OFF, so slice 2 has to turn it on deliberately, in the same change
  // that ships the surfaces.
  test('devicePairingApproval is NOT advertised until an operator surface exists (station#1887)', () => {
    expect(STATION_CAPABILITY_FLAGS.devicePairingApproval).toBeUndefined();
  });
});
