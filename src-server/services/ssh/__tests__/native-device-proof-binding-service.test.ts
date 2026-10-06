import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  parsePairingScope,
} from '@kontourai/station-contracts';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { DevicePairingService } from '../device-pairing-service.js';
import {
  type NativeDeviceClientSurface,
  type NativeDeviceProofApprovalOperation,
  type NativeDeviceProofApprovalTuple,
  type NativeDeviceProofBinding,
  NativeDeviceProofBindingError,
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
  type NativeDeviceProofPublicJwk,
} from '../native-device-proof-binding-service.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_INSTANCE_ID = randomUUID();
const OPERATOR_APPROVAL = { kind: 'presented-credential' } as const;
const makeTempDir = trackTempDirs();
const BINDINGS_FILE = 'native-device-proof-bindings.json';
const APP_IDENTIFIER = 'station.desktop';
const CHANNEL = 'dev' as const;

function harness(environmentId = ENVIRONMENT_ID) {
  const homeDir = makeTempDir('station-proof-binding-');
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId,
  });
  const bindingService = new NativeDeviceProofBindingService({
    homeDir,
    pairing,
  });
  return { homeDir, pairing, bindingService };
}

function pairForBindings(service: DevicePairingService) {
  const offer = service.createOffer({
    endpoint: 'https://station.example.test',
  });
  const request = service.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Native shell',
    clientInstanceId: CLIENT_INSTANCE_ID,
  });
  service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
  const { device } = service.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    clientInstanceId: CLIENT_INSTANCE_ID,
  });
  return { deviceId: device.id };
}

function mintApproval(tuple: {
  operation: NativeDeviceProofApprovalOperation;
  stationId?: string;
  deviceId: string;
  bindingId: string;
  surface: NativeDeviceClientSurface;
  jwk: NativeDeviceProofPublicJwk;
}) {
  const authority = new NativeDeviceProofOperatorAuthority();
  const frozen: NativeDeviceProofApprovalTuple = {
    operation: tuple.operation,
    stationId: tuple.stationId ?? ENVIRONMENT_ID,
    deviceId: tuple.deviceId,
    bindingId: tuple.bindingId,
    surface: tuple.surface,
    jwk: tuple.jwk,
  };
  return authority.approve({
    operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    tuple: frozen,
  });
}

/**
 * Shared create harness: proposes one fresh canonical UUIDv4 candidate ID and
 * mints a matching create approval, exactly like the reviewed host flow.
 */
function createApproved(
  service: NativeDeviceProofBindingService,
  deviceId: string,
  opts: {
    bindingId?: string;
    surface?: NativeDeviceClientSurface;
    jwk?: NativeDeviceProofPublicJwk;
    stationId?: string;
  } = {},
): NativeDeviceProofBinding {
  const bindingId = opts.bindingId ?? randomUUID();
  const approvedSurface = opts.surface ?? surface();
  const jwk = opts.jwk ?? p256PublicJwk();
  return service.createBinding({
    bindingId,
    deviceId,
    surface: approvedSurface,
    jwk,
    approval: mintApproval({
      operation: 'create',
      stationId: opts.stationId,
      deviceId,
      bindingId,
      surface: approvedSurface,
      jwk,
    }),
  });
}

function revokeApproved(
  service: NativeDeviceProofBindingService,
  target: NativeDeviceProofBinding,
  opts: {
    surface?: NativeDeviceClientSurface;
    bindingId?: string;
    jwk?: NativeDeviceProofPublicJwk;
    stationId?: string;
  } = {},
) {
  const approvedSurface = opts.surface ?? target.surface;
  const bindingId = opts.bindingId ?? target.bindingId;
  const jwk = opts.jwk ?? target.deviceProof.jwk;
  return service.revokeBinding({
    bindingId,
    deviceId: target.deviceId,
    surface: approvedSurface,
    jwk,
    approval: mintApproval({
      operation: 'revoke',
      stationId: opts.stationId,
      deviceId: target.deviceId,
      bindingId,
      surface: approvedSurface,
      jwk,
    }),
  });
}

function p256PublicJwk(): NativeDeviceProofPublicJwk {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
}

function p256PrivateJwk(): NativeDeviceProofPublicJwk & { d: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return {
    kty: 'EC',
    crv: 'P-256',
    x: pub.x!,
    y: pub.y!,
    d: priv.d!,
  };
}

function thumbprintOf(jwk: { crv: string; kty: string; x: string; y: string }) {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
}

const DEFAULT_ROUTE_THUMBPRINT = thumbprintOf(p256PublicJwk());

function surface(
  overrides: Partial<NativeDeviceClientSurface> = {},
): NativeDeviceClientSurface {
  return {
    kind: 'station-native',
    appIdentifier: APP_IDENTIFIER,
    channel: CHANNEL,
    clientInstanceId: CLIENT_INSTANCE_ID,
    keyThumbprint: DEFAULT_ROUTE_THUMBPRINT,
    ...overrides,
  };
}

function storedBindings(homeDir: string): unknown[] {
  const stored = JSON.parse(
    readFileSync(join(homeDir, 'security', BINDINGS_FILE), 'utf8'),
  ) as { bindings: unknown[] };
  return stored.bindings;
}

describe('native device proof binding service (station#2893)', () => {
  test('minted approval cannot be rewritten to commit an unreviewed binding or key', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const bindingId = randomUUID();
    const approvedSurface = surface();
    const jwk = p256PublicJwk();
    const approval = mintApproval({
      operation: 'create',
      deviceId,
      bindingId,
      surface: approvedSurface,
      jwk,
    });
    const changedId = randomUUID();
    const changedKey = p256PublicJwk();
    expect(Reflect.set(approval.tuple, 'bindingId', changedId)).toBe(false);
    expect(
      Reflect.set(approval.tuple.surface, 'appIdentifier', 'other.app'),
    ).toBe(false);
    expect(Reflect.set(approval.tuple.jwk, 'x', changedKey.x)).toBe(false);
    expect(
      Reflect.set(approval, 'tuple', {
        ...approval.tuple,
        bindingId: changedId,
      }),
    ).toBe(false);
    expect(Reflect.set(approval, 'consume', () => undefined)).toBe(false);
    expect(() =>
      bindingService.createBinding({
        bindingId: changedId,
        deviceId,
        surface: approvedSurface,
        jwk: changedKey,
        approval,
      }),
    ).toThrow('binding_id_mismatch');
    expect(bindingService.bindingById({ bindingId: changedId })).toBeNull();
    const created = bindingService.createBinding({
      bindingId,
      deviceId,
      surface: approvedSurface,
      jwk,
      approval,
    });
    expect(created.bindingId).toBe(bindingId);
    expect(created.deviceProof.jwk).toEqual(jwk);
    expect(bindingService.bindingById({ bindingId: changedId })).toBeNull();
  });

  test('revocation approval refuses a wildcard ID or missing reviewed key', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = createApproved(bindingService, deviceId);
    for (const field of ['bindingId', 'jwk']) {
      const malformed = {
        operation: 'revoke' as const,
        deviceId,
        bindingId: created.bindingId,
        surface: created.surface,
        jwk: created.deviceProof.jwk,
      };
      Reflect.set(malformed, field, null);
      expect(() => mintApproval(malformed)).toThrow(
        'invalid_operator_approval',
      );
    }
    expect(
      bindingService.bindingById({ bindingId: created.bindingId })?.state,
    ).toBe('active');
  });

  test('approval minting refuses noncanonical surfaces and keys for either operation', () => {
    const { pairing } = harness();
    const { deviceId } = pairForBindings(pairing);
    const tuple = {
      deviceId,
      bindingId: randomUUID(),
      surface: surface(),
      jwk: p256PublicJwk(),
    };
    for (const operation of ['create', 'revoke'] as const) {
      for (const changed of [
        { surface: { ...tuple.surface, extra: 'unreviewed' } },
        { jwk: p256PrivateJwk() },
        { jwk: { ...tuple.jwk, x: 'not-a-coordinate' } },
      ]) {
        expect(() => mintApproval({ ...tuple, operation, ...changed })).toThrow(
          'invalid_operator_approval',
        );
      }
    }
  });

  test('create persists a full-surface binding tied to the approved device, station, and surface', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const jwk = p256PublicJwk();
    const approved = surface({ keyThumbprint: thumbprintOf(p256PublicJwk()) });
    const binding = createApproved(bindingService, deviceId, {
      surface: approved,
      jwk,
    });
    expect(binding.state).toBe('active');
    expect(binding.deviceId).toBe(deviceId);
    expect(binding.stationId).toBe(ENVIRONMENT_ID);
    expect(binding.surface).toEqual(approved);
    expect(binding.deviceProof.jwk).not.toHaveProperty('d');
    expect(binding.deviceProof.thumbprint).toBe(thumbprintOf(jwk));
    expect(binding.deviceScopeAtApproval).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
    const stored = JSON.parse(
      readFileSync(join(homeDir, 'security', BINDINGS_FILE), 'utf8'),
    );
    expect(stored.schemaVersion).toBe(1);
    expect(stored.bindings).toHaveLength(1);
    expect(stored.bindings[0].surface).toEqual(approved);
    expect(JSON.stringify(stored)).not.toContain('peerNonce');
  });

  test('returned binding ID equals the host-proposed candidate ID and survives reopen', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const proposed = randomUUID();
    const approved = surface();
    const created = createApproved(bindingService, deviceId, {
      bindingId: proposed,
      surface: approved,
    });
    expect(created.bindingId).toBe(proposed);
    const reopened = new NativeDeviceProofBindingService({ homeDir, pairing });
    const current = reopened.requireCurrentBinding({
      deviceId,
      surface: approved,
    });
    expect(current.binding.bindingId).toBe(proposed);
    expect(current.binding.surface).toEqual(approved);
    expect(current.binding.deviceProof.thumbprint).toBe(
      created.deviceProof.thumbprint,
    );
    expect(current.device.id).toBe(deviceId);
    expect(current.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
  });

  test('noncanonical binding IDs are refused before any state changes', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const badIds = [
      randomUUID().toUpperCase(),
      'not-a-uuid',
      '11111111-1111-1111-8111-111111111111',
      '11111111-1111-4111-4111-111111111111',
      '11111111-1111-4111-8111-1111111111110',
      '',
    ];
    for (const bindingId of badIds) {
      // The approval factory refuses to bind a noncanonical candidate ID.
      expect(() =>
        createApproved(bindingService, deviceId, { bindingId }),
      ).toThrow('invalid_operator_approval');
      expect(() => bindingService.bindingById({ bindingId })).toThrow(
        'invalid_binding_id',
      );
    }
    // A valid context presented with a noncanonical input ID still fails at
    // the service seam before any state changes.
    expect(() =>
      bindingService.createBinding({
        bindingId: randomUUID().toUpperCase(),
        deviceId,
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: mintApproval({
          operation: 'create',
          deviceId,
          bindingId: randomUUID(),
          surface: surface(),
          jwk: p256PublicJwk(),
        }),
      }),
    ).toThrow('invalid_binding_id');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
    expect(() =>
      new NativeDeviceProofOperatorAuthority().approve({
        operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        tuple: {
          operation: 'create',
          stationId: ENVIRONMENT_ID,
          deviceId,
          bindingId: randomUUID().toUpperCase(),
          surface: surface(),
          jwk: p256PublicJwk(),
        },
      }),
    ).toThrow('invalid_operator_approval');
  });

  test('an altered tuple or operation presented against the original approval context refuses without changing state', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const bindingId = randomUUID();
    const approved = surface();
    const jwk = p256PublicJwk();
    const created = createApproved(bindingService, deviceId, {
      bindingId,
      surface: approved,
      jwk,
    });
    // One fresh context frozen to the exact originally approved tuple.
    const originalContext = mintApproval({
      operation: 'create',
      deviceId,
      bindingId,
      surface: approved,
      jwk,
    });
    const alteredCases: Array<{
      name: string;
      input: {
        bindingId?: string;
        deviceId?: string;
        surface?: NativeDeviceClientSurface;
        jwk?: NativeDeviceProofPublicJwk;
      };
      operation?: 'create' | 'revoke';
    }> = [
      {
        name: 'changed binding ID',
        input: { bindingId: randomUUID() },
      },
      {
        name: 'changed device',
        input: { deviceId: randomUUID() },
      },
      {
        name: 'changed surface appIdentifier',
        input: { surface: surface({ appIdentifier: 'other.app' }) },
      },
      {
        name: 'changed surface client instance',
        input: { surface: surface({ clientInstanceId: randomUUID() }) },
      },
      {
        name: 'changed proof key with the approved thumbprint re-derived',
        input: { jwk: p256PublicJwk() },
      },
      {
        name: 'revocation presented against a create context',
        input: {},
        operation: 'revoke',
      },
    ];
    for (const { input, operation } of alteredCases) {
      const presentedBindingId = input.bindingId ?? bindingId;
      const presentedDeviceId = input.deviceId ?? deviceId;
      const presentedSurface = input.surface ?? approved;
      const presentedJwk = input.jwk ?? jwk;
      if (operation === 'revoke') {
        expect(() =>
          bindingService.revokeBinding({
            bindingId: presentedBindingId,
            jwk: presentedJwk,
            deviceId: presentedDeviceId,
            surface: presentedSurface,
            approval: originalContext,
          }),
        ).toThrow('operation_mismatch');
      } else {
        expect(() =>
          bindingService.createBinding({
            bindingId: presentedBindingId,
            deviceId: presentedDeviceId,
            surface: presentedSurface,
            jwk: presentedJwk,
            approval: originalContext,
          }),
        ).toThrow(NativeDeviceProofBindingError);
      }
    }
    // A context approved on another station refuses this station entirely.
    expect(() =>
      bindingService.createBinding({
        bindingId,
        deviceId,
        surface: approved,
        jwk,
        approval: mintApproval({
          operation: 'create',
          stationId: OTHER_ENVIRONMENT_ID,
          deviceId,
          bindingId,
          surface: approved,
          jwk,
        }),
      }),
    ).toThrow('station_mismatch');
    // Nothing changed: the original binding is still the single active record.
    const reopened = new NativeDeviceProofBindingService({ homeDir, pairing });
    expect(
      reopened.requireCurrentBinding({ deviceId, surface: approved }).binding
        .bindingId,
    ).toBe(created.bindingId);
    expect(storedBindings(homeDir)).toHaveLength(1);
  });

  test('binding ID reuse across active and revoked records is refused; exact active retry returns recorded state without re-approval', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const revokedId = randomUUID();
    const historical = createApproved(bindingService, deviceId, {
      bindingId: revokedId,
    });
    revokeApproved(bindingService, historical);

    // A revoked historical ID can never be reused, even with a fresh key.
    expect(() =>
      createApproved(bindingService, deviceId, { bindingId: revokedId }),
    ).toThrow('binding_id_conflict');

    // The exact active candidate readback returns its recorded state and
    // consumes nothing: the retry approval stays usable afterwards.
    const activeId = randomUUID();
    const activeJwk = p256PublicJwk();
    const activeSurface = surface();
    const created = createApproved(bindingService, deviceId, {
      bindingId: activeId,
      surface: activeSurface,
      jwk: activeJwk,
    });
    const retryApproval = mintApproval({
      operation: 'create',
      deviceId,
      bindingId: activeId,
      surface: activeSurface,
      jwk: activeJwk,
    });
    const retried = bindingService.createBinding({
      bindingId: activeId,
      deviceId,
      surface: activeSurface,
      jwk: activeJwk,
      approval: retryApproval,
    });
    expect(retried).toEqual(created);
    expect(storedBindings(homeDir)).toHaveLength(2);
    // The exact retry consumed nothing: the context is still intact.
    expect(() => retryApproval.consume()).not.toThrow();

    // Same ID but any changed tuple member conflicts with the active record.
    expect(() =>
      createApproved(bindingService, deviceId, {
        bindingId: activeId,
        jwk: p256PublicJwk(),
      }),
    ).toThrow('binding_id_conflict');
    expect(storedBindings(homeDir)).toHaveLength(2);
  });

  test('wrong station refuses create and revocation without touching stored state', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = createApproved(bindingService, deviceId);
    const otherStationBindings = new NativeDeviceProofBindingService({
      homeDir,
      pairing: {
        environmentId: () => OTHER_ENVIRONMENT_ID,
        listDevices: () => pairing.listDevices(),
      },
    });
    expect(() =>
      revokeApproved(otherStationBindings, created, {
        stationId: OTHER_ENVIRONMENT_ID,
      }),
    ).toThrow('binding_not_found');
    // A create approval naming the original station is also refused elsewhere.
    expect(() => createApproved(otherStationBindings, deviceId)).toThrow(
      'station_mismatch',
    );
    expect(
      bindingService.requireCurrentBinding({ deviceId, surface: surface() })
        .binding.bindingId,
    ).toBe(created.bindingId);
    expect(storedBindings(homeDir)).toHaveLength(1);
  });

  test('exact readback by binding ID distinguishes active, revoked and absent without mutations', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    expect(bindingService.bindingById({ bindingId: randomUUID() })).toBeNull();
    const bindingId = randomUUID();
    const created = createApproved(bindingService, deviceId, { bindingId });
    const active = bindingService.bindingById({ bindingId });
    expect(active?.state).toBe('active');
    expect(active?.bindingId).toBe(bindingId);
    revokeApproved(bindingService, created);
    const revoked = bindingService.bindingById({ bindingId });
    expect(revoked?.state).toBe('revoked');
    expect(revoked?.revocationReason).toBe('operator-revoked');
    expect(revoked?.revokedAt).toBeTypeOf('number');
    // Readback is a pure query: the store bytes are identical throughout.
    const snapshot = readFileSync(
      join(homeDir, 'security', BINDINGS_FILE),
      'utf8',
    );
    expect(bindingService.bindingById({ bindingId })).toEqual(revoked);
    expect(bindingService.bindingById({ bindingId: randomUUID() })).toBeNull();
    expect(readFileSync(join(homeDir, 'security', BINDINGS_FILE), 'utf8')).toBe(
      snapshot,
    );
  });

  test('revocation against a non-current device refuses', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = createApproved(bindingService, deviceId);
    pairing.revokeDevice(deviceId, 'operator-credential');
    expect(() => revokeApproved(bindingService, created)).toThrow(
      'device_not_active',
    );
  });

  test('any full-surface mismatch fails closed: wrong route-key thumbprint, appIdentifier, channel, client instance', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    createApproved(bindingService, deviceId, { surface: approved });
    const mismatches: NativeDeviceClientSurface[] = [
      surface({ keyThumbprint: thumbprintOf(p256PublicJwk()) }),
      surface({ appIdentifier: 'other.app' }),
      surface({ channel: 'stable' }),
      surface({ clientInstanceId: randomUUID() }),
    ];
    for (const mismatch of mismatches) {
      expect(
        bindingService.currentBinding({ deviceId, surface: mismatch }),
      ).toBeNull();
      expect(() =>
        bindingService.requireCurrentBinding({
          deviceId,
          surface: mismatch,
        }),
      ).toThrow('binding_unavailable');
    }
  });

  test('wrong device proof key never matches the binding; surface alone is not a proof', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    createApproved(bindingService, deviceId, { surface: approved });
    const current = bindingService.requireCurrentBinding({
      deviceId,
      surface: approved,
    });
    expect(bindingService.thumbprintMatches(current, p256PublicJwk())).toBe(
      false,
    );
  });

  test('route-key possession is not Device approval: the route key never satisfies the device-key check', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const routeKeyJwk = p256PublicJwk();
    const approved = surface({ keyThumbprint: thumbprintOf(routeKeyJwk) });
    createApproved(bindingService, deviceId, {
      surface: approved,
      jwk: p256PublicJwk(),
    });
    const current = bindingService.requireCurrentBinding({
      deviceId,
      surface: approved,
    });
    expect(bindingService.thumbprintMatches(current, routeKeyJwk)).toBe(false);
    expect(current.binding.deviceProof.thumbprint).not.toBe(
      current.binding.surface.keyThumbprint,
    );
  });

  test('a device proof key equal to the route key is refused', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const routeKeyJwk = p256PublicJwk();
    expect(() =>
      createApproved(bindingService, deviceId, {
        surface: surface({ keyThumbprint: thumbprintOf(routeKeyJwk) }),
        jwk: routeKeyJwk,
      }),
    ).toThrow('device_key_matches_route_key');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('noncanonical or extra-field surfaces are refused at the service seam', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const badSurfaces: unknown[] = [
      { ...surface(), kind: 'browser-extension' },
      { ...surface(), channel: 'canary' },
      surface({ appIdentifier: '-leading-dot' }),
      surface({ appIdentifier: 'a b' }),
      surface({ keyThumbprint: 'short' }),
      surface({ clientInstanceId: 'not-a-uuid' }),
      { ...surface(), extra: 'field' },
    ];
    const bindingId = randomUUID();
    const jwk = p256PublicJwk();
    const approval = mintApproval({
      operation: 'create',
      deviceId,
      bindingId,
      surface: surface(),
      jwk,
    });
    for (const bad of badSurfaces) {
      expect(() =>
        Reflect.apply(bindingService.createBinding, bindingService, [
          {
            bindingId,
            deviceId,
            surface: bad,
            jwk,
            approval,
          },
        ]),
      ).toThrow('invalid_native_surface');
    }
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('a failed replacement write leaves the last committed binding current', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = createApproved(bindingService, deviceId);
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const backup = join(homeDir, 'security', 'binding-backup.json');
    renameSync(path, backup);
    mkdirSync(path);
    try {
      expect(() => createApproved(bindingService, deviceId)).toThrow();
    } finally {
      rmSync(path, { recursive: true });
      renameSync(backup, path);
    }
    expect(
      bindingService.requireCurrentBinding({ deviceId, surface: surface() })
        .binding.bindingId,
    ).toBe(first.bindingId);
  });

  test('reopen refuses a symlinked sidecar even when its target is valid', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const backup = join(homeDir, 'security', 'sidecar-target.json');
    renameSync(path, backup);
    symlinkSync(backup, path);
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
  });

  test('reopen refuses a substituted thumbprint or two active bindings for one Device and client', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const original = JSON.parse(readFileSync(path, 'utf8'));
    const tampered = structuredClone(original);
    tampered.bindings[0].deviceProof.thumbprint = 'A'.repeat(43);
    writeFileSync(path, JSON.stringify(tampered));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
    const duplicated = structuredClone(original);
    duplicated.bindings.push({
      ...duplicated.bindings[0],
      bindingId: randomUUID(),
    });
    writeFileSync(path, JSON.stringify(duplicated));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
  });

  test('an old client-only sidecar without the approved surface fails closed on reload', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    const stored = legacy.bindings[0];
    delete stored.surface;
    stored.clientInstanceId = CLIENT_INSTANCE_ID;
    writeFileSync(path, JSON.stringify(legacy));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
  });

  test('revoke fails closed on later queries and refuses double revoke', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = createApproved(bindingService, deviceId);
    const [revoked] = revokeApproved(bindingService, created);
    expect(revoked.state).toBe('revoked');
    expect(revoked.revocationReason).toBe('operator-revoked');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
    expect(() =>
      bindingService.requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('binding_unavailable');
    expect(() => revokeApproved(bindingService, created)).toThrow(
      'binding_not_found',
    );
  });

  test('revocation bound to one full surface cannot target the binding through a different surface', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const binding = createApproved(bindingService, deviceId, {
      surface: approved,
    });
    expect(() =>
      revokeApproved(bindingService, binding, {
        surface: surface({ keyThumbprint: thumbprintOf(p256PublicJwk()) }),
      }),
    ).toThrow('binding_not_found');
    expect(
      bindingService.requireCurrentBinding({ deviceId, surface: approved })
        .binding.bindingId,
    ).toBe(binding.bindingId);
  });

  test('a revocation approval naming an exact binding ID only revokes that record', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const target = createApproved(bindingService, deviceId, {
      bindingId: randomUUID(),
      surface: surface({ clientInstanceId: randomUUID() }),
    });
    const other = createApproved(bindingService, deviceId);
    const [revoked] = revokeApproved(bindingService, target, {
      bindingId: target.bindingId,
      surface: target.surface,
    });
    expect(revoked.bindingId).toBe(target.bindingId);
    expect(
      bindingService.bindingById({ bindingId: other.bindingId })?.state,
    ).toBe('active');
    expect(
      bindingService.bindingById({ bindingId: target.bindingId })?.state,
    ).toBe('revoked');
    // Naming a missing ID finds nothing to revoke.
    expect(() =>
      revokeApproved(bindingService, other, { bindingId: randomUUID() }),
    ).toThrow('binding_not_found');
    expect(() =>
      revokeApproved(bindingService, other, { jwk: p256PublicJwk() }),
    ).toThrow('binding_not_found');
    expect(
      bindingService.bindingById({ bindingId: other.bindingId })?.state,
    ).toBe('active');
  });

  test('a delayed revocation of the reviewed binding cannot revoke its same-surface replacement', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const reviewed = createApproved(bindingService, deviceId);
    const approval = mintApproval({
      operation: 'revoke',
      deviceId,
      bindingId: reviewed.bindingId,
      surface: reviewed.surface,
      jwk: reviewed.deviceProof.jwk,
    });
    const replacement = createApproved(bindingService, deviceId);
    const snapshot = readFileSync(
      join(homeDir, 'security', BINDINGS_FILE),
      'utf8',
    );
    expect(() =>
      bindingService.revokeBinding({
        bindingId: reviewed.bindingId,
        deviceId,
        surface: reviewed.surface,
        jwk: reviewed.deviceProof.jwk,
        approval,
      }),
    ).toThrow('binding_not_found');
    expect(readFileSync(join(homeDir, 'security', BINDINGS_FILE), 'utf8')).toBe(
      snapshot,
    );
    expect(
      bindingService.requireCurrentBinding({
        deviceId,
        surface: replacement.surface,
      }).binding.bindingId,
    ).toBe(replacement.bindingId);
    expect(() => approval.consume()).not.toThrow();
    revokeApproved(bindingService, replacement);
    expect(
      bindingService.currentBinding({ deviceId, surface: replacement.surface }),
    ).toBeNull();
  });

  test('independent service handles observe revocation and cannot resurrect it on another write', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const created = createApproved(bindingService, deviceId, {
      surface: approved,
    });
    const other = new NativeDeviceProofBindingService({ homeDir, pairing });
    revokeApproved(other, created);
    expect(
      bindingService.currentBinding({ deviceId, surface: approved }),
    ).toBeNull();
    createApproved(bindingService, deviceId, {
      surface: surface({ clientInstanceId: randomUUID() }),
    });
    expect(
      new NativeDeviceProofBindingService({ homeDir, pairing }).currentBinding({
        deviceId,
        surface: approved,
      }),
    ).toBeNull();
  });

  test('key replacement revokes the prior binding and rebinds the new key under a new candidate ID', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = createApproved(bindingService, deviceId);
    const secondJwk = p256PublicJwk();
    const secondId = randomUUID();
    const second = createApproved(bindingService, deviceId, {
      bindingId: secondId,
      jwk: secondJwk,
    });
    expect(second.bindingId).toBe(secondId);
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(second.deviceProof.thumbprint).not.toBe(
      first.deviceProof.thumbprint,
    );
    const current = bindingService.requireCurrentBinding({
      deviceId,
      surface: surface(),
    });
    expect(current.binding.bindingId).toBe(second.bindingId);
    expect(current.binding.deviceProof.thumbprint).toBe(
      thumbprintOf(secondJwk),
    );
    expect(
      bindingService.bindingById({ bindingId: first.bindingId })?.state,
    ).toBe('revoked');
    const reopened = new NativeDeviceProofBindingService({
      homeDir,
      pairing,
    });
    const reloaded = reopened.requireCurrentBinding({
      deviceId,
      surface: surface(),
    });
    expect(reloaded.binding.bindingId).toBe(second.bindingId);
  });

  test('wrong device, revoked device, and legacy-unbound device all fail closed', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    pairing.revokeDevice(deviceId, 'operator-credential');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
    expect(() => createApproved(bindingService, deviceId)).toThrow(
      'device_not_active',
    );
    expect(() => createApproved(bindingService, randomUUID())).toThrow(
      'device_not_active',
    );
  });

  test('changed device scope fails closed until the binding is re-approved', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    pairing.setDeviceScope(
      deviceId,
      parsePairingScope(DEFAULT_GRANT_PAIRING_SCOPE)!.slice(0, 1),
      OPERATOR_APPROVAL,
    );
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('wrong or malformed proof keys are refused', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const truncated = p256PublicJwk();
    const bad = {
      ...truncated,
      x: `${truncated.x.slice(0, 42)}${truncated.x.endsWith('A') ? 'B' : 'A'}`,
    };
    const bindingId = randomUUID();
    const approvedSurface = surface();
    const approval = mintApproval({
      operation: 'create',
      deviceId,
      bindingId,
      surface: approvedSurface,
      jwk: truncated,
    });
    for (const jwk of [p256PrivateJwk(), bad]) {
      expect(() =>
        bindingService.createBinding({
          bindingId,
          deviceId,
          surface: approvedSurface,
          jwk,
          approval,
        }),
      ).toThrow('invalid_proof_jwk');
    }
  });

  test('corrupt or wrong-version sidecar fails closed instead of reading empty', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    createApproved(bindingService, deviceId);
    const path = join(homeDir, 'security', BINDINGS_FILE);
    writeFileSync(path, '{not json');
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, bindings: [] }));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('store_unavailable');
  });

  test('a tampered stored surface fails closed on reload', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    createApproved(bindingService, deviceId, { surface: approved });
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.bindings[0].surface.channel = 'nightly';
    writeFileSync(path, JSON.stringify(tampered));
    // A canonical-but-different stored surface simply answers nothing.
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: approved,
      }),
    ).toThrow('binding_unavailable');
    // A noncanonical stored surface poisons the whole store.
    const poisoned = JSON.parse(readFileSync(path, 'utf8'));
    poisoned.bindings[0].surface.channel = 'canary';
    writeFileSync(path, JSON.stringify(poisoned));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        surface: approved,
      }),
    ).toThrow('store_unavailable');
  });

  test('legacy paired device with no binding refuses current-binding lookups', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    expect(() =>
      bindingService.requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('binding_unavailable');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('raw request data cannot stand in for an operator approval context', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const forged = {
      operation: 'create',
      operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
      stationId: ENVIRONMENT_ID,
      deviceId,
      bindingId: randomUUID(),
      surface: surface(),
      jwk: p256PublicJwk(),
    };
    expect(() =>
      Reflect.apply(bindingService.createBinding, bindingService, [
        {
          bindingId: forged.bindingId,
          deviceId,
          surface: surface(),
          jwk: p256PublicJwk(),
          approval: forged,
        },
      ]),
    ).toThrow(NativeDeviceProofBindingError);
    expect(() =>
      Reflect.apply(bindingService.revokeBinding, bindingService, [
        {
          bindingId: forged.bindingId,
          deviceId,
          surface: surface(),
          jwk: forged.jwk,
          approval: forged,
        },
      ]),
    ).toThrow(NativeDeviceProofBindingError);
    expect(() =>
      new NativeDeviceProofOperatorAuthority().approve({
        operatorPrincipalId: 'human:someone-else:attacker',
        tuple: {
          operation: 'create',
          stationId: ENVIRONMENT_ID,
          deviceId,
          bindingId: randomUUID(),
          surface: surface(),
          jwk: p256PublicJwk(),
        },
      }),
    ).toThrow('operator_unauthorized');
    const foreignAuthority = new NativeDeviceProofOperatorAuthority();
    expect(() =>
      bindingService.createBinding({
        bindingId: randomUUID(),
        deviceId,
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: foreignAuthority.approve({
          operatorPrincipalId: 'human:attacker:x',
          tuple: {
            operation: 'create',
            stationId: ENVIRONMENT_ID,
            deviceId,
            bindingId: randomUUID(),
            surface: surface(),
            jwk: p256PublicJwk(),
          },
        }),
      }),
    ).toThrow('operator_unauthorized');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('a completed revocation cannot mutate its historical record again', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    // Creation consumes its approval; an exact matching retry is an
    // idempotent readback, so the one-use rule is observable on revocation.
    const created = createApproved(bindingService, deviceId);
    const revokeApproval = mintApproval({
      operation: 'revoke',
      deviceId,
      bindingId: created.bindingId,
      surface: created.surface,
      jwk: created.deviceProof.jwk,
    });
    bindingService.revokeBinding({
      bindingId: created.bindingId,
      deviceId,
      surface: created.surface,
      jwk: created.deviceProof.jwk,
      approval: revokeApproval,
    });
    expect(() => revokeApproval.consume()).toThrow('operator_approval_reused');
    expect(() =>
      bindingService.revokeBinding({
        bindingId: created.bindingId,
        deviceId,
        surface: created.surface,
        jwk: created.deviceProof.jwk,
        approval: revokeApproval,
      }),
    ).toThrow('binding_not_found');
  });

  test('public projections omit key material and scope internals', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const created = createApproved(bindingService, deviceId, {
      surface: approved,
    });
    const projection = bindingService.projectionOf(created);
    expect(projection).toEqual({
      bindingId: created.bindingId,
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      thumbprint: created.deviceProof.thumbprint,
      createdAt: created.createdAt,
      approvedAt: created.approvedAt,
      state: 'active',
    });
    expect(JSON.stringify(projection)).not.toContain('"x"');
    expect(JSON.stringify(projection)).not.toContain('orchestration');
    expect(JSON.stringify(projection)).not.toContain(
      approved.keyThumbprint.slice(0, 8),
    );
  });
});
