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

function mintApproval() {
  const authority = new NativeDeviceProofOperatorAuthority();
  return authority.approve({
    operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
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

describe('native device proof binding service (station#2893)', () => {
  test('create persists a full-surface binding tied to the approved device, station, and surface', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const jwk = p256PublicJwk();
    const approved = surface({ keyThumbprint: thumbprintOf(p256PublicJwk()) });
    const binding = bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk,
      approval: mintApproval(),
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

  test('reopen loads the same full-surface binding and answers exact requireCurrentBinding', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const created = bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const reopened = new NativeDeviceProofBindingService({ homeDir, pairing });
    const current = reopened.requireCurrentBinding({
      deviceId,
      surface: approved,
    });
    expect(current.binding.bindingId).toBe(created.bindingId);
    expect(current.binding.surface).toEqual(approved);
    expect(current.binding.deviceProof.thumbprint).toBe(
      created.deviceProof.thumbprint,
    );
    expect(current.device.id).toBe(deviceId);
    expect(current.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
  });

  test('any full-surface mismatch fails closed: wrong route-key thumbprint, appIdentifier, channel, client instance', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
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
      bindingService.createBinding({
        deviceId,
        surface: surface({ keyThumbprint: thumbprintOf(routeKeyJwk) }),
        jwk: routeKeyJwk,
        approval: mintApproval(),
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
      surface({ kind: 'browser-extension' as never }),
      surface({ channel: 'canary' as never }),
      surface({ appIdentifier: '-leading-dot' }),
      surface({ appIdentifier: 'a b' }),
      surface({ keyThumbprint: 'short' }),
      surface({ clientInstanceId: 'not-a-uuid' }),
      { ...surface(), extra: 'field' },
    ];
    for (const bad of badSurfaces) {
      expect(() =>
        bindingService.createBinding({
          deviceId,
          surface: bad as NativeDeviceClientSurface,
          jwk: p256PublicJwk(),
          approval: mintApproval(),
        }),
      ).toThrow('invalid_native_surface');
    }
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('a failed replacement write leaves the last committed binding current', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const backup = join(homeDir, 'security', 'binding-backup.json');
    renameSync(path, backup);
    mkdirSync(path);
    try {
      expect(() =>
        bindingService.createBinding({
          deviceId,
          surface: surface(),
          jwk: p256PublicJwk(),
          approval: mintApproval(),
        }),
      ).toThrow();
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const path = join(homeDir, 'security', BINDINGS_FILE);
    const backup = join(homeDir, 'sidecar-target.json');
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const [revoked] = bindingService.revokeBinding({
      deviceId,
      surface: surface(),
      approval: mintApproval(),
    });
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
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        surface: surface(),
        approval: mintApproval(),
      }),
    ).toThrow('binding_not_found');
  });

  test('revocation cannot target an approved binding through a different native surface', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const binding = bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        surface: surface({ keyThumbprint: thumbprintOf(p256PublicJwk()) }),
        approval: mintApproval(),
      }),
    ).toThrow('binding_not_found');
    expect(
      bindingService.requireCurrentBinding({ deviceId, surface: approved })
        .binding.bindingId,
    ).toBe(binding.bindingId);
  });

  test('independent service handles observe revocation and cannot resurrect it on another write', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const other = new NativeDeviceProofBindingService({ homeDir, pairing });
    other.revokeBinding({
      deviceId,
      surface: approved,
      approval: mintApproval(),
    });
    expect(
      bindingService.currentBinding({ deviceId, surface: approved }),
    ).toBeNull();
    bindingService.createBinding({
      deviceId,
      surface: surface({ clientInstanceId: randomUUID() }),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    expect(
      new NativeDeviceProofBindingService({ homeDir, pairing }).currentBinding({
        deviceId,
        surface: approved,
      }),
    ).toBeNull();
  });

  test('key replacement revokes the prior binding and rebinds the new key', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const secondJwk = p256PublicJwk();
    const second = bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: secondJwk,
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    pairing.revokeDevice(deviceId, 'operator-credential');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
    expect(() =>
      bindingService.createBinding({
        deviceId,
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('device_not_active');
    expect(() =>
      bindingService.createBinding({
        deviceId: randomUUID(),
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('device_not_active');
  });

  test('wrong station refuses the binding without touching stored state', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const otherStationBindings = new NativeDeviceProofBindingService({
      homeDir,
      pairing: {
        environmentId: () => OTHER_ENVIRONMENT_ID,
        listDevices: () => pairing.listDevices(),
      },
    });
    expect(
      otherStationBindings.currentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toBeNull();
    expect(() =>
      otherStationBindings.requireCurrentBinding({
        deviceId,
        surface: surface(),
      }),
    ).toThrow('binding_unavailable');
  });

  test('changed device scope fails closed until the binding is re-approved', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    expect(() =>
      bindingService.createBinding({
        deviceId,
        surface: surface(),
        jwk: p256PrivateJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('invalid_proof_jwk');
    const truncated = p256PublicJwk();
    const bad = {
      ...truncated,
      x: `${truncated.x.slice(0, 42)}${truncated.x.endsWith('A') ? 'B' : 'A'}`,
    };
    expect(() =>
      bindingService.createBinding({
        deviceId,
        surface: surface(),
        jwk: bad,
        approval: mintApproval(),
      }),
    ).toThrow('invalid_proof_jwk');
  });

  test('corrupt or wrong-version sidecar fails closed instead of reading empty', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
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
        surface: surface(),
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
        surface: surface(),
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
      operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
      approvalId: randomUUID(),
      approvedAt: Date.now(),
    };
    expect(() =>
      bindingService.createBinding({
        deviceId,
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: forged as never,
      }),
    ).toThrow(NativeDeviceProofBindingError);
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        surface: surface(),
        approval: forged as never,
      }),
    ).toThrow(NativeDeviceProofBindingError);
    expect(() =>
      new NativeDeviceProofOperatorAuthority().approve({
        operatorPrincipalId: 'human:someone-else:attacker',
      }),
    ).toThrow('operator_unauthorized');
    const foreignAuthority = new NativeDeviceProofOperatorAuthority();
    expect(() =>
      bindingService.createBinding({
        deviceId,
        surface: surface(),
        jwk: p256PublicJwk(),
        approval: foreignAuthority.approve({
          operatorPrincipalId: 'human:attacker:x',
        }),
      }),
    ).toThrow('operator_unauthorized');
    expect(
      bindingService.currentBinding({ deviceId, surface: surface() }),
    ).toBeNull();
  });

  test('a consumed approval cannot authorize a second mutation', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approval = mintApproval();
    bindingService.createBinding({
      deviceId,
      surface: surface(),
      jwk: p256PublicJwk(),
      approval,
    });
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        surface: surface(),
        approval,
      }),
    ).toThrow('operator_approval_reused');
  });

  test('public projections omit key material and scope internals', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approved = surface();
    const created = bindingService.createBinding({
      deviceId,
      surface: approved,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
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
