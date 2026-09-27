import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopeIncludes,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import { describe, expect, test } from 'vitest';
import { STATION_CAPABILITY_FLAGS } from '../station-capability-flags.js';

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
});
