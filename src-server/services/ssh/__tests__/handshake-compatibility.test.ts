import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_PAIRING_PROTOCOL_VERSION,
  parsePublicStationHandshake,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import packageJson from '../../../../package.json' with { type: 'json' };
import { STATION_CAPABILITY_FLAGS } from '../../../capabilities/station-capability-flags.js';
import { configureRuntimePublicRoutes } from '../../../runtime/routes/runtime-routes.js';
import { projectFleetContributionManifest } from '../../connections/fleet-contribution-manifest.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-handshake-compat-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('public handshake compatibility block', () => {
  test('advertises the contract versions and the real package version', async () => {
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });

    const handshake = await service.getPublicHandshake();

    expect(handshake.compatibility).toEqual({
      // Not a hardcoded string: a build can never advertise a version it is
      // not. This is the one field that is a release version, on purpose.
      serverVersion: packageJson.version,
      protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
      minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
      capabilities: {
        remoteAuth: REMOTE_AUTH_PROTOCOL_VERSION,
        devicePairing: DEVICE_PAIRING_PROTOCOL_VERSION,
        environmentProof: STATION_PROOF_PROTOCOL_VERSION,
      },
    });
  });

  test('keeps the contract integers monotonic and the floor no higher than the current version', () => {
    expect(Number.isSafeInteger(STATION_COMPAT_PROTOCOL_VERSION)).toBe(true);
    expect(Number.isSafeInteger(STATION_COMPAT_MIN_CLIENT_PROTOCOL)).toBe(true);
    expect(STATION_COMPAT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
    // A floor above the current contract would mean the host refuses the
    // client this very repo ships.
    expect(STATION_COMPAT_MIN_CLIENT_PROTOCOL).toBeLessThanOrEqual(
      STATION_COMPAT_PROTOCOL_VERSION,
    );
  });

  test('is purely additive: every pre-existing handshake field is unchanged', async () => {
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });

    const handshake = await service.getPublicHandshake();
    const { compatibility, capabilities, ...legacyView } = handshake;

    // What a client built before this contract sees after JSON round-trip:
    // byte-identical to the previous document, plus two ignored keys.
    expect(legacyView).toEqual({
      schemaVersion: 1,
      environmentId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
    });
    expect(compatibility).toBeDefined();
    expect(capabilities).toBeDefined();
    expect(Object.keys(handshake).sort()).toEqual([
      'authentication',
      'capabilities',
      'compatibility',
      'environmentId',
      'schemaVersion',
      'transports',
    ]);
  });
});

describe('public handshake capability flags (station#1095)', () => {
  test('the current producer handshake is accepted by the consumer parser with its session window flag', async () => {
    const handshake = await new EnvironmentSecurityService({
      homeDir: makeHome(),
    }).getPublicHandshake();

    expect(parsePublicStationHandshake(handshake)?.capabilities).toMatchObject({
      sessionEventWindow: true,
    });
  });

  test('advertises the single registry source of truth verbatim', async () => {
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });

    const handshake = await service.getPublicHandshake();

    expect(handshake.capabilities).toEqual(STATION_CAPABILITY_FLAGS);
    expect(handshake.capabilities).toEqual({
      sshEnvironments: true,
      webPushNotifications: true,
      eventStreamResume: true,
      sessionEventWindow: true,
      scopedPairing: true,
      fleetInference: true,
    });
  });

  test('server route test: the live HTTP response includes the seeded flags', async () => {
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });
    const app = new Hono();
    // `app as never`: established pattern for this exact configurator in
    // runtime-auth-boundary.test.ts (its `HonoApp` parameter type is the
    // OpenAPIHono type `@voltagent/server-hono`'s configureApp expects,
    // which isn't independently constructible without a direct
    // `@hono/zod-openapi` dependency this repo doesn't take).
    configureRuntimePublicRoutes(app as never, service);

    const response = await app.request('/.well-known/station/v1');
    const body = (await response.json()) as {
      capabilities?: Record<string, boolean>;
    };

    expect(response.status).toBe(200);
    expect(body.capabilities).toEqual({
      sshEnvironments: true,
      webPushNotifications: true,
      eventStreamResume: true,
      sessionEventWindow: true,
      scopedPairing: true,
      fleetInference: true,
    });
    for (const buildIdentityField of [
      'build',
      'buildSha',
      'builtAt',
      'channel',
      'dirty',
      'shaSource',
    ]) {
      expect(body).not.toHaveProperty(buildIdentityField);
    }
  });

  // station#1398 §5.2 rule 1: whatever the fleet arc eventually advertises
  // here is a static protocol fact only. It must never become "this machine
  // has a GPU worth asking about" — the handshake is public and
  // unauthenticated, so anything in this body is readable by any LAN or
  // tailnet scanner. Written now, ahead of the flag, so the flag cannot
  // land without this guard already in place.
  //
  // The fixture is what makes this non-vacuous: the home this Station is
  // serving from has contribution turned ON and names a connection, and the
  // manifest projected from that same state provably contains the strings
  // asserted absent below. Without it the value-level assertions could only
  // ever pass.
  test('the public handshake discloses nothing about what this Station contributes', async () => {
    const homeDir = makeHome();
    const fleetContribution = {
      enabled: true,
      connectionIds: ['ollama-workstation'],
    };
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    writeFileSync(
      join(homeDir, 'config', 'app.json'),
      JSON.stringify(
        {
          defaultModel: 'qwen3-coder:30b',
          invokeModel: 'qwen3-coder:30b',
          structureModel: 'qwen3-coder:30b',
          fleetContribution,
        },
        null,
        2,
      ),
    );

    // Proof the fixture is live: this Station's own contributed subset does
    // carry the connection id and the provider model name.
    const manifest = projectFleetContributionManifest({
      projectedAt: new Date().toISOString(),
      config: fleetContribution,
      inventory: {
        schemaVersion: 'station.model-inventory/v2',
        observedAt: new Date().toISOString(),
        models: [
          {
            id: 'model:ollama-workstation:qwen3-coder:30b',
            connectionId: 'ollama-workstation',
            connectionKind: 'model',
            providerId: 'ollama-workstation',
            runtime: { id: 'ollama', version: null },
            adapter: null,
            model: {
              id: 'qwen3-coder:30b',
              revision: null,
              quantization: null,
            },
            providerModel: 'qwen3-coder:30b',
            aliases: ['qwen3-coder:30b'],
            displayName: 'qwen3-coder:30b',
            locality: 'local',
            availability: 'available',
            freshness: 'live',
            observedAt: new Date().toISOString(),
            effectiveContextTokens: 32_768,
            toolSurface: null,
            supportsVision: null,
          },
        ],
        diagnostics: [],
      },
    });
    const contributed = JSON.stringify(manifest).toLowerCase();
    expect(manifest.participation).toBe('contributing');
    expect(contributed).toContain('ollama-workstation');
    expect(contributed).toContain('qwen3-coder');

    const service = new EnvironmentSecurityService({ homeDir });
    const app = new Hono();
    configureRuntimePublicRoutes(app as never, service);

    const response = await app.request('/.well-known/station/v1');
    const body = (await response.text()).toLowerCase();

    expect(response.status).toBe(200);
    for (const forbidden of [
      'contribut',
      'connectionids',
      'providermodel',
      'participation',
      'ollama-workstation',
      'qwen3-coder',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
