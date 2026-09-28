import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  parsePairingScope,
} from '@kontourai/station-contracts';
import { afterEach, describe, expect, test } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { DevicePairingService } from '../device-pairing-service.js';
import {
  NativeDeviceProofBindingError,
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
  type NativeDeviceProofPublicJwk,
} from '../native-device-proof-binding-service.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_INSTANCE_ID = randomUUID();
const OPERATOR_APPROVAL = { kind: 'presented-credential' } as const;
const homes: string[] = [];
const BINDINGS_FILE = 'native-device-proof-bindings.json';

function harness(environmentId = ENVIRONMENT_ID) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-proof-binding-'));
  homes.push(homeDir);
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

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('native device proof binding service (station#2893)', () => {
  test('create persists a binding tied to the approved device, station, and client', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const jwk = p256PublicJwk();
    const binding = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk,
      approval: mintApproval(),
    });
    expect(binding.state).toBe('active');
    expect(binding.deviceId).toBe(deviceId);
    expect(binding.stationId).toBe(ENVIRONMENT_ID);
    expect(binding.clientInstanceId).toBe(CLIENT_INSTANCE_ID);
    expect(binding.deviceProof.jwk).not.toHaveProperty('d');
    expect(binding.deviceProof.thumbprint).toBe(thumbprintOf(jwk));
    expect(binding.deviceScopeAtApproval).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
    const stored = JSON.parse(
      readFileSync(join(homeDir, 'security', BINDINGS_FILE), 'utf8'),
    );
    expect(stored.schemaVersion).toBe(1);
    expect(stored.bindings).toHaveLength(1);
  });

  test('reopen loads the same binding; verifier reads the exact current binding and device scope', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const reopened = new NativeDeviceProofBindingService({ homeDir, pairing });
    const current = reopened.requireCurrentBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(current.binding.bindingId).toBe(created.bindingId);
    expect(current.binding.deviceProof.thumbprint).toBe(
      created.deviceProof.thumbprint,
    );
    expect(current.device.id).toBe(deviceId);
    expect(current.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
  });

  test('a failed replacement write leaves the last committed binding current', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
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
          clientInstanceId: CLIENT_INSTANCE_ID,
          jwk: p256PublicJwk(),
          approval: mintApproval(),
        }),
      ).toThrow();
    } finally {
      rmSync(path, { recursive: true });
      renameSync(backup, path);
    }
    expect(
      bindingService.requireCurrentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }).binding.bindingId,
    ).toBe(first.bindingId);
  });

  test('reopen refuses a symlinked sidecar even when its target is valid', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('store_unavailable');
  });

  test('reopen refuses a substituted thumbprint or two active bindings for one Device and client', () => {
    const { homeDir, pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('store_unavailable');
  });

  test('revoke fails closed on later queries and refuses double revoke', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const [revoked] = bindingService.revokeBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      approval: mintApproval(),
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.revocationReason).toBe('operator-revoked');
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toBeNull();
    expect(() =>
      bindingService.requireCurrentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('binding_unavailable');
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
        approval: mintApproval(),
      }),
    ).toThrow('binding_not_found');
  });

  test('key replacement revokes the prior binding and rebinds the new key', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const first = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    const secondJwk = p256PublicJwk();
    const second = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: secondJwk,
      approval: mintApproval(),
    });
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(second.deviceProof.thumbprint).not.toBe(
      first.deviceProof.thumbprint,
    );
    const current = bindingService.requireCurrentBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(current.binding.bindingId).toBe(second.bindingId);
    expect(current.binding.deviceProof.thumbprint).toBe(
      thumbprintOf(secondJwk),
    );
    const reopened = new NativeDeviceProofBindingService({
      homeDir: homes[homes.length - 1]!,
      pairing,
    });
    const reloaded = reopened.requireCurrentBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(reloaded.binding.bindingId).toBe(second.bindingId);
  });

  test('wrong device, revoked device, and legacy-unbound device all fail closed', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    pairing.revokeDevice(deviceId, 'operator-credential');
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toBeNull();
    expect(() =>
      bindingService.createBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
        jwk: p256PublicJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('device_not_active');
    expect(() =>
      bindingService.createBinding({
        deviceId: randomUUID(),
        clientInstanceId: CLIENT_INSTANCE_ID,
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
      clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toBeNull();
    expect(() =>
      otherStationBindings.requireCurrentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('binding_unavailable');
  });

  test('wrong client instance id never matches the binding', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: randomUUID(),
      }),
    ).toBeNull();
    expect(() =>
      bindingService.createBinding({
        deviceId,
        clientInstanceId: 'not-a-uuid',
        jwk: p256PublicJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('invalid_client_instance_id');
  });

  test('changed device scope fails closed until the binding is re-approved', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval: mintApproval(),
    });
    pairing.setDeviceScope(
      deviceId,
      parsePairingScope(DEFAULT_GRANT_PAIRING_SCOPE)!.slice(0, 1),
      OPERATOR_APPROVAL,
    );
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toBeNull();
  });

  test('wrong or malformed proof keys are refused', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    expect(() =>
      bindingService.createBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
        jwk: p256PrivateJwk(),
        approval: mintApproval(),
      }),
    ).toThrow('invalid_proof_jwk');
    const truncated = p256PublicJwk();
    const bad = {
      ...truncated,
      x: `${truncated.x.slice(0, 42)}A`,
    };
    expect(() =>
      bindingService.createBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
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
      clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('store_unavailable');
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, bindings: [] }));
    expect(() =>
      new NativeDeviceProofBindingService({
        homeDir,
        pairing,
      }).requireCurrentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('store_unavailable');
  });

  test('legacy paired device with no binding refuses current-binding lookups', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    expect(() =>
      bindingService.requireCurrentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toThrow('binding_unavailable');
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
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
        clientInstanceId: CLIENT_INSTANCE_ID,
        jwk: p256PublicJwk(),
        approval: forged as never,
      }),
    ).toThrow(NativeDeviceProofBindingError);
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
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
        clientInstanceId: CLIENT_INSTANCE_ID,
        jwk: p256PublicJwk(),
        approval: foreignAuthority.approve({
          operatorPrincipalId: 'human:attacker:x',
        }),
      }),
    ).toThrow('operator_unauthorized');
    expect(
      bindingService.currentBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
      }),
    ).toBeNull();
  });

  test('a consumed approval cannot authorize a second mutation', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const approval = mintApproval();
    bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
      jwk: p256PublicJwk(),
      approval,
    });
    expect(() =>
      bindingService.revokeBinding({
        deviceId,
        clientInstanceId: CLIENT_INSTANCE_ID,
        approval,
      }),
    ).toThrow('operator_approval_reused');
  });

  test('public projections omit key material and scope internals', () => {
    const { pairing, bindingService } = harness();
    const { deviceId } = pairForBindings(pairing);
    const created = bindingService.createBinding({
      deviceId,
      clientInstanceId: CLIENT_INSTANCE_ID,
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
  });
});
