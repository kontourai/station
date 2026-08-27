import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  DEVICE_PAIRING_SCOPE,
  pairingScopeIncludes,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { skipIfCannotChmod } from '../../infra/__tests__/helpers/store-faults.js';
import { TerminalWebSocketServer } from '../../terminal/terminal-ws-server.js';
import {
  DevicePairingError,
  DevicePairingService,
  MANUAL_CODE_ENTROPY_BITS,
  manualCodeFromEntropy,
  type PairingApproval,
  type PairingRequesterPosition,
} from '../device-pairing-service.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
/**
 * The operator approving from a session that presented a credential — what
 * every pre-station#1490 `confirmRequest()` call implicitly assumed it was.
 */
const OPERATOR_APPROVAL: PairingApproval = { kind: 'presented-credential' };
const FLOOR_APPROVAL: PairingApproval = { kind: 'unauthenticated' };
const homes: string[] = [];

describe('manual pairing-code entropy (station#2060)', () => {
  test('rejects the modulo-biased byte tail while retaining accepted boundaries', () => {
    const bytes = Uint8Array.from([
      248,
      249,
      250,
      251,
      252,
      253,
      254,
      255,
      0,
      30,
      31,
      61,
      62,
      92,
      93,
      123,
      124,
      154,
      155,
      247,
      ...Array(12).fill(0),
    ]);

    const code = manualCodeFromEntropy(() => bytes);
    expect(code).toBe('2Z2Z2Z2Z2Z');
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    expect(MANUAL_CODE_ENTROPY_BITS).toBeCloseTo(49.54, 2);
  });

  test('fails loudly after bounded all-rejected entropy batches', () => {
    const readBytes = vi.fn(() => new Uint8Array(32).fill(255));

    expect(() => manualCodeFromEntropy(readBytes)).toThrow(
      'Manual pairing-code entropy source yielded insufficient bytes',
    );
    expect(readBytes).toHaveBeenCalledTimes(4);
  });

  test('fails loudly when the entropy source returns a malformed batch', () => {
    expect(() => manualCodeFromEntropy(() => new Uint8Array(31))).toThrow(
      'Manual pairing-code entropy source returned wrong size',
    );
  });
});

function harness(
  now = 1_000,
  options: {
    maxActiveOffers?: number;
    maxActiveCredentialsPerVerifiedIdentity?: number;
    maxActiveCredentialsWithoutVerifiedIdentity?: number;
  } = {},
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  let current = now;
  const service = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
    now: () => current,
    offerTtlMs: 1_000,
    maxActiveOffers: options.maxActiveOffers,
    maxActiveCredentialsPerVerifiedIdentity:
      options.maxActiveCredentialsPerVerifiedIdentity,
    maxActiveCredentialsWithoutVerifiedIdentity:
      options.maxActiveCredentialsWithoutVerifiedIdentity,
  });
  return { service, homeDir, advance: (ms: number) => (current += ms) };
}

function pair(
  service: DevicePairingService,
  name = 'Brian phone',
  clientInstanceId?: string,
) {
  const offer = service.createOffer({
    endpoint: 'https://station.example.test',
  });
  const request = service.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
    clientInstanceId,
  });
  service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
  return {
    offer,
    request,
    result: service.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      clientInstanceId,
    }),
  };
}

function pairTailnet(
  service: DevicePairingService,
  {
    login,
    name = 'Tailnet device',
    clientInstanceId,
  }: {
    login: string;
    name?: string;
    clientInstanceId?: string;
  },
) {
  const offer = service.createOffer({
    endpoint: 'https://station.example.test',
  });
  const request = service.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
    clientInstanceId,
    source: 'tailnet',
    requester: { provider: 'tailscale-serve', login },
  });
  service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
  return {
    offer,
    request,
    exchange: () =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId,
      }),
  };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('DevicePairingService', () => {
  test('records durable usage shape and only a server-derived coarse peer class', () => {
    const { service, advance } = harness();
    const paired = pair(service).result;

    expect(paired.device).toMatchObject({
      activityTracking: 'tracked-since-issued',
      usageCount: 0,
      lastSeenFrom: null,
      lastActiveDay: null,
    });

    expect(service.recordCredentialActivity(paired.credential, 'lan')).toBe(
      true,
    );
    advance(24 * 60 * 60_000);
    expect(service.recordCredentialActivity(paired.credential)).toBe(true);

    expect(service.identifyDevice(paired.credential)).toMatchObject({
      usageCount: 2,
      lastSeenFrom: null,
      lastActiveDay: '1970-01-02',
    });
    expect(
      service.recordCredentialActivity('not-a-credential', 'tailnet'),
    ).toBe(false);
  });

  test('tracks a successful credential use at the established minutely cadence', () => {
    const { service, advance, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');

    expect(service.verifyCredential(paired.credential)).toBe(true);
    expect(service.listDevices()[0]).toMatchObject({
      issuedAt: 1_000,
      lastUsedAt: 1_000,
    });
    const firstWrite = readFileSync(registryPath, 'utf8');

    advance(59_000);
    expect(service.verifyCredential(paired.credential)).toBe(true);
    expect(readFileSync(registryPath, 'utf8')).toBe(firstWrite);

    advance(1_000);
    expect(service.verifyCredential(paired.credential)).toBe(true);
    expect(service.listDevices()[0].lastUsedAt).toBe(1_000 + 60_000);
  });

  test('surfaces legacy records with no issue or use timestamp as unavailable', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    delete raw.devices[0].issuedAt;
    // The genuine historical on-disk spelling for never-used was an explicit
    // null, not an absent key — normalization must strip it, never expose it.
    raw.devices[0].lastUsedAt = null;
    writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    const reloaded = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(reloaded.listDevices()[0]).not.toHaveProperty('issuedAt');
    expect(reloaded.listDevices()[0]).not.toHaveProperty('lastUsedAt');
    expect(reloaded.verifyCredential(paired.credential)).toBe(true);
  });

  test('a missing legacy key also reads as never used after reload', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    delete raw.devices[0].issuedAt;
    delete raw.devices[0].lastUsedAt;
    writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    const reloaded = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(reloaded.listDevices()[0]).not.toHaveProperty('lastUsedAt');
    expect(reloaded.verifyCredential(paired.credential)).toBe(true);
  });

  test('upgrades the concrete v1 registry to explicit unobserved activity state', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    raw.schemaVersion = 1;
    delete raw.devices[0].activityTracking;
    delete raw.devices[0].lastSeenFrom;
    delete raw.devices[0].usageCount;
    delete raw.devices[0].lastActiveDay;
    delete raw.devices[0].revocation;
    writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    const upgraded = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(upgraded.identifyDevice(paired.credential)).toMatchObject({
      activityTracking: 'unobserved-before-activity-tracking',
      usageCount: null,
      lastSeenFrom: null,
      lastActiveDay: null,
      revocation: { state: 'not-revoked' },
    });
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
    });
  });

  test('rejects v2-only and unknown nested fields instead of projecting corrupted registry state', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    raw.schemaVersion = 1;
    delete raw.devices[0].activityTracking;
    delete raw.devices[0].lastSeenFrom;
    delete raw.devices[0].usageCount;
    delete raw.devices[0].lastActiveDay;
    raw.devices[0].revocation = { state: 'not-revoked' };
    writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    expect(
      () =>
        new DevicePairingService({ homeDir, environmentId: ENVIRONMENT_ID }),
    ).toThrow(/Invalid paired-device/);

    raw.schemaVersion = 2;
    raw.devices[0].activityTracking = 'tracked-since-issued';
    raw.devices[0].lastSeenFrom = null;
    raw.devices[0].usageCount = 0;
    raw.devices[0].lastActiveDay = null;
    raw.devices[0].requester = {
      provider: 'tailscale-serve',
      login: 'a',
      extra: true,
    };
    raw.devices[0].source = 'tailnet';
    raw.devices[0].revocation = { state: 'not-revoked', extra: true };
    writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    expect(
      () =>
        new DevicePairingService({ homeDir, environmentId: ENVIRONMENT_ID }),
    ).toThrow(/Invalid paired-device/);
    expect(service.verifyCredential(paired.credential)).toBe(true);
  });

  test('rejects contradictory recorded revocation actor and reason combinations', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
    raw.devices[0].revokedAt = 1_000;

    for (const revocation of [
      {
        state: 'recorded',
        actor: 'operator-credential',
        reason: 'same-client-replacement',
      },
      {
        state: 'recorded',
        actor: 'same-client-replacement',
        reason: 'owner-request',
      },
    ]) {
      raw.devices[0].revocation = revocation;
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
      expect(
        () =>
          new DevicePairingService({ homeDir, environmentId: ENVIRONMENT_ID }),
      ).toThrow(/Invalid paired-device/);
    }
    expect(service.verifyCredential(paired.credential)).toBe(true);
  });

  test('records bounded revocation provenance and refuses to erase a live credential', () => {
    const { service } = harness();
    const paired = pair(service).result;

    expect(() =>
      service.removeRevokedDevice(paired.device.id, 'operator-credential'),
    ).toThrowError(new DevicePairingError('device_active'));
    expect(service.verifyCredential(paired.credential)).toBe(true);

    expect(
      service.revokeDevice(paired.device.id, 'operator-credential'),
    ).toMatchObject({
      revokedAt: 1_000,
      revocation: {
        state: 'recorded',
        actor: 'operator-credential',
        reason: 'owner-request',
      },
    });
    expect(service.verifyCredential(paired.credential)).toBe(false);
    expect(
      service.removeRevokedDevice(paired.device.id, 'operator-credential'),
    ).toMatchObject({
      id: paired.device.id,
    });
    expect(service.listDevices()).toEqual([]);
  });

  test('bounds active credentials per verified requester without blocking replacement or re-pair', () => {
    const { service } = harness(1_000, {
      maxActiveCredentialsPerVerifiedIdentity: 1,
    });
    const requester = 'owner@example.test';
    const clientInstanceId = '11111111-1111-4111-8111-111111111111';
    const original = pairTailnet(service, {
      login: requester,
      name: 'Original',
      clientInstanceId,
    }).exchange();

    // A replacement is one atomic change: the older credential is revoked
    // in the snapshot before the per-identity capacity check runs.
    const replacement = pairTailnet(service, {
      login: requester,
      name: 'Replacement',
      clientInstanceId,
    }).exchange();
    expect(replacement.replacement).toBe('superseded');
    expect(service.verifyCredential(original.credential)).toBe(false);
    expect(service.verifyCredential(replacement.credential)).toBe(true);

    const blocked = pairTailnet(service, {
      login: requester,
      name: 'Overflow',
      clientInstanceId: '22222222-2222-4222-8222-222222222222',
    });
    expect(blocked.exchange).toThrowError(
      new DevicePairingError('identity_credential_quota_reached'),
    );
    expect(
      service.listDevices().filter((device) => device.revokedAt === null),
    ).toHaveLength(1);

    // A deliberate revocation frees the identity's one active credential;
    // retrying the still-confirmed exchange is safe because the failed quota
    // admission did not mutate the registry or consume its offer.
    service.revokeDevice(replacement.device.id, 'operator-credential');
    const repaired = blocked.exchange();
    expect(repaired.device.requester).toEqual({
      provider: 'tailscale-serve',
      login: requester,
    });
    expect(service.verifyCredential(repaired.credential)).toBe(true);
  });

  test('records home-possession locality only when exchange is told to, and omits it from the public device', () => {
    const { service } = harness();
    const ordinary = pair(service, 'Ordinary pairing').result;
    expect(service.credentialLocality(ordinary.credential)).toBeUndefined();
    expect(ordinary.device).not.toHaveProperty('locality');

    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'unproven',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Home possession',
      source: 'same-origin',
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
    const minted = service.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      locality: 'home-possession',
    });
    expect(service.credentialLocality(minted.credential)).toBe(
      'home-possession',
    );
    expect(minted.device).not.toHaveProperty('locality');
  });

  test('records the mint KIND only alongside a possession proof, resolves it privately, and omits it from the public device (station#3677 PR 3)', () => {
    const { service, homeDir } = harness();

    // Ordinary pairing: no locality, no kind.
    const ordinary = pair(service, 'Ordinary pairing').result;
    expect(service.credentialMintKind(ordinary.credential)).toBeUndefined();
    expect(ordinary.device).not.toHaveProperty('mintKind');

    const mint = (
      input: {
        locality?: 'home-possession';
        mintKind?: 'local-grant' | 'ui-bootstrap';
      },
      name: string,
    ) => {
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      const request = service.requestPairing({
        requesterPosition: 'unproven',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        source: 'same-origin',
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      return service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        ...input,
      });
    };

    // The two real mint paths resolve their own kinds.
    const localGrant = mint(
      { locality: 'home-possession', mintKind: 'local-grant' },
      'Desktop app',
    );
    expect(service.credentialMintKind(localGrant.credential)).toBe(
      'local-grant',
    );
    expect(localGrant.device).not.toHaveProperty('mintKind');

    const uiBootstrap = mint(
      { locality: 'home-possession', mintKind: 'ui-bootstrap' },
      'Host browser',
    );
    expect(service.credentialMintKind(uiBootstrap.credential)).toBe(
      'ui-bootstrap',
    );

    // A kind WITHOUT the possession proof is never recorded — it would be a
    // mint-path label with no derivation behind it. The resolver ALSO checks
    // locality, so the write-side guard is invisible through the public API
    // (fault-injection round: removing it alone changed nothing observable);
    // assert on the PERSISTED record so each layer is pinned independently —
    // the stored registry must never carry the underived label a future raw
    // reader would otherwise trust.
    const kindOnly = mint({ mintKind: 'local-grant' }, 'No possession');
    expect(service.credentialMintKind(kindOnly.credential)).toBeUndefined();
    const persisted = JSON.parse(
      readFileSync(join(homeDir, 'security', 'paired-devices.json'), 'utf8'),
    ) as { devices: Array<{ name: string; mintKind?: string }> };
    expect(
      persisted.devices.find((device) => device.name === 'No possession')
        ?.mintKind,
    ).toBeUndefined();
    expect(
      persisted.devices.find((device) => device.name === 'Desktop app')
        ?.mintKind,
    ).toBe('local-grant');

    // A pre-#3677 record: possession with no recorded kind reads undefined,
    // which the native broker treats as "not local-grant" (fail closed).
    const preExisting = mint({ locality: 'home-possession' }, 'Pre-#3677');
    expect(service.credentialMintKind(preExisting.credential)).toBeUndefined();
    expect(service.credentialLocality(preExisting.credential)).toBe(
      'home-possession',
    );

    // The registry must still LOAD with the new field present (review
    // round 1, HIGH): the strict key check rejects any unknown key, so a
    // persisted field the reader does not know makes the whole registry
    // unreadable at the next boot — every paired device lost.
    const reloaded = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(reloaded.credentialMintKind(localGrant.credential)).toBe(
      'local-grant',
    );
    expect(reloaded.credentialMintKind(uiBootstrap.credential)).toBe(
      'ui-bootstrap',
    );
    expect(reloaded.verifyCredential(localGrant.credential)).toBe(true);
  });

  test('refuses a hand-written mint kind that no possession proof backs, and an unknown kind (station#3677 PR 3)', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    const registryPath = join(homeDir, 'security', 'paired-devices.json');

    for (const injected of [
      // A kind with no locality: the underived label a raw editor could add.
      { mintKind: 'local-grant' },
      // A locality-backed but unknown kind.
      { locality: 'home-possession', mintKind: 'operator-said-so' },
    ]) {
      const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
      Object.assign(raw.devices[0], injected);
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
      expect(
        () =>
          new DevicePairingService({
            homeDir,
            environmentId: ENVIRONMENT_ID,
          }),
      ).toThrowError('Invalid paired-device record');
    }
    expect(service.verifyCredential(paired.credential)).toBe(true);
  });

  test('station#3816: an operator can NARROW a paired device without unpairing it', () => {
    const { service, homeDir } = harness();
    const paired = pair(service, 'Phone').result;
    // Whatever it paired with, the operator can set it to read-only — the
    // point of the change: narrowing used to mean unpairing and starting
    // over, which pushes people to over-grant at pairing time.
    const narrowed = service.setDeviceScope(
      paired.device.id,
      ['orchestration:read'],
      OPERATOR_APPROVAL,
    );
    expect(narrowed.scope).toBe('orchestration:read');
    // The device keeps its identity and its credential keeps working.
    expect(narrowed.id).toBe(paired.device.id);
    expect(service.verifyCredential(paired.credential)).toBe(true);

    // Persisted before it is exposed: a restart must not restore what the
    // operator just took away.
    const reloaded = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(
      reloaded.listDevices().find((d) => d.id === paired.device.id)?.scope,
    ).toBe('orchestration:read');
  });

  test('station#3816: operator promotion is the mechanism consent:decide always declared and never had', () => {
    const { service } = harness();
    const paired = pair(service, 'Phone').result;
    const promoted = service.setDeviceScope(
      paired.device.id,
      ['orchestration:read', 'orchestration:operate', 'consent:decide'],
      OPERATOR_APPROVAL,
    );
    // Serialised in vocabulary order, not the caller's spelling.
    expect(promoted.scope).toBe(
      'orchestration:read orchestration:operate consent:decide',
    );
  });

  test('station#3816: a token with no legitimate promotion path is refused', () => {
    const { service } = harness();
    const paired = pair(service, 'Phone').result;
    // access:manage is inherited by migrated, scope-omitting and
    // continuity-flow credentials — a permanently ambiguous population the
    // contracts say must not grow. There is deliberately no promotion path
    // to it, so offering one here would widen exactly that set.
    expect(() =>
      service.setDeviceScope(
        paired.device.id,
        ['orchestration:read', 'access:manage'],
        OPERATOR_APPROVAL,
      ),
    ).toThrowError(new DevicePairingError('scope_not_grantable'));
    // Unchanged: a refused change changes nothing.
    expect(
      service.listDevices().find((d) => d.id === paired.device.id)?.scope,
    ).toBe(paired.device.scope);
  });

  test('station#3816: an unknown token, an empty scope, a revoked device, and a non-operator are all refused', () => {
    const { service } = harness();
    const paired = pair(service, 'Phone').result;

    expect(() =>
      service.setDeviceScope(
        paired.device.id,
        ['orchestration:invent' as never],
        OPERATOR_APPROVAL,
      ),
    ).toThrowError(new DevicePairingError('invalid_scope'));
    expect(() =>
      service.setDeviceScope(paired.device.id, [], OPERATOR_APPROVAL),
    ).toThrowError(new DevicePairingError('invalid_scope'));
    // Only an operator-shaped approval reaches this at all.
    expect(() =>
      service.setDeviceScope(paired.device.id, ['orchestration:read'], {
        kind: 'pairing-code',
      } as never),
    ).toThrowError(new DevicePairingError('approval_requires_operator'));

    service.revokeDevice(paired.device.id, 'operator-credential');
    expect(() =>
      service.setDeviceScope(
        paired.device.id,
        ['orchestration:read'],
        OPERATOR_APPROVAL,
      ),
    ).toThrowError(new DevicePairingError('device_revoked'));
  });

  test('never lets a shared client instance revoke another verified identity', () => {
    const { service } = harness();
    const clientInstanceId = '11111111-1111-4111-8111-111111111111';
    const owner = pairTailnet(service, {
      login: 'owner@example.test',
      clientInstanceId,
    }).exchange();
    const other = pairTailnet(service, {
      login: 'other@example.test',
      clientInstanceId,
    }).exchange();

    expect(other.replacement).toBe('none');
    expect(service.verifyCredential(owner.credential)).toBe(true);
    expect(service.verifyCredential(other.credential)).toBe(true);
  });

  test('never lets one identityless source replace another by client instance', () => {
    const { service } = harness();
    const clientInstanceId = '11111111-1111-4111-8111-111111111111';
    const first = pair(service, 'Pairing code', clientInstanceId).result;
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Same app from same origin',
      clientInstanceId,
      source: 'same-origin',
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
    const second = service.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      clientInstanceId,
    });

    expect(second.replacement).toBe('none');
    expect(service.verifyCredential(first.credential)).toBe(true);
    expect(service.verifyCredential(second.credential)).toBe(true);
  });

  test('does not merge distinct server-verified requester identities into one quota', () => {
    const { service } = harness(1_000, {
      maxActiveCredentialsPerVerifiedIdentity: 1,
    });

    expect(
      pairTailnet(service, { login: 'first@example.test' }).exchange(),
    ).toMatchObject({ device: { revokedAt: null } });
    expect(
      pairTailnet(service, { login: 'second@example.test' }).exchange(),
    ).toMatchObject({ device: { revokedAt: null } });
  });

  test('bounds identityless issuance globally without treating a client instance as an identity', () => {
    const { service } = harness(1_000, {
      maxActiveCredentialsWithoutVerifiedIdentity: 1,
    });
    const first = pair(
      service,
      'First browser',
      '11111111-1111-4111-8111-111111111111',
    ).result;
    const blockedOffer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const blockedRequest = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: blockedOffer.offerId,
      proof: blockedOffer.challenge,
      deviceName: 'Rotated client instance',
      clientInstanceId: '22222222-2222-4222-8222-222222222222',
    });
    service.confirmRequest(blockedRequest.requestId, OPERATOR_APPROVAL);

    expect(() =>
      service.exchange({
        offerId: blockedOffer.offerId,
        proof: blockedOffer.challenge,
        requestId: blockedRequest.requestId,
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrowError(
      new DevicePairingError('unattributed_credential_quota_reached'),
    );
    expect(() =>
      service.exchange({
        offerId: blockedOffer.offerId,
        proof: blockedOffer.challenge,
        requestId: blockedRequest.requestId,
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow(
      'Credential grant quota reached. Open Paired Devices in the connection manager to review last-used grants and revoke stale ones.',
    );
    expect(service.verifyCredential(first.credential)).toBe(true);

    service.revokeDevice(first.device.id, 'operator-credential');
    expect(() =>
      service.exchange({
        offerId: blockedOffer.offerId,
        proof: blockedOffer.challenge,
        requestId: blockedRequest.requestId,
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).not.toThrow();
  });

  test('accepts cleartext http for loopback, LAN, and tailnet endpoints but not public hosts', () => {
    const { service } = harness();
    for (const endpoint of [
      'http://localhost:3141',
      'http://127.0.0.1:3141',
      'http://192.168.1.20:3141',
      'http://10.0.0.5:3141',
      'http://172.16.4.2:3141',
      'http://100.77.142.114:3151', // tailnet CGNAT
      'http://tauri.localhost',
    ]) {
      expect(() => service.createOffer({ endpoint })).not.toThrow();
    }
    // A public host over cleartext is still rejected.
    expect(() =>
      service.createOffer({ endpoint: 'http://station.example.test' }),
    ).toThrowError(new DevicePairingError('invalid_request'));
    // Public https remains valid.
    expect(() =>
      service.createOffer({ endpoint: 'https://station.example.test' }),
    ).not.toThrow();
  });

  test('requires verified requester provenance for every tailnet request', () => {
    const { service } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const base = {
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Tailnet browser',
    };

    expect(() =>
      service.requestPairing({ ...base, source: 'tailnet' } as never),
    ).toThrowError(new DevicePairingError('invalid_request'));
    expect(() =>
      service.requestPairing({
        requesterPosition: 'off-box',
        ...base,
        source: 'same-origin',
        requester: {
          provider: 'tailscale-serve',
          login: 'brian@example.test',
        },
      } as never),
    ).toThrowError(new DevicePairingError('invalid_request'));

    expect(
      service.requestPairing({
        requesterPosition: 'off-box',
        ...base,
        source: 'tailnet',
        requester: {
          provider: 'tailscale-serve',
          login: 'brian@example.test',
        },
      }),
    ).toMatchObject({
      source: 'tailnet',
      requester: { login: 'brian@example.test' },
    });
  });

  test('exchanges a host-confirmed offer once and persists only a credential hash', () => {
    const { service, homeDir } = harness();
    const { offer, request, result } = pair(service);

    expect(result.environmentId).toBe(ENVIRONMENT_ID);
    expect(service.verifyCredential(result.credential)).toBe(true);
    expect(service.listDevices()).toEqual([
      expect.objectContaining({ name: 'Brian phone', revokedAt: null }),
    ]);
    expect(() =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      }),
    ).toThrowError(new DevicePairingError('request_not_confirmed'));

    const persisted = readFileSync(
      join(homeDir, 'security', 'paired-devices.json'),
      'utf8',
    );
    expect(persisted).not.toContain(result.credential);
    expect(persisted).not.toContain(offer.challenge);
    expect(persisted).not.toContain(offer.manualCode);
    if (process.platform !== 'win32') {
      expect(
        statSync(join(homeDir, 'security', 'paired-devices.json')).mode & 0o777,
      ).toBe(0o600);
    }
  });

  test('confirmation and expiry mint no credential before a successful exchange', () => {
    const { service, advance } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Pending phone',
    });

    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
    expect(service.listDevices()).toEqual([]);

    advance(1_001);
    expect(() =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrowError(new DevicePairingError('offer_expired'));
    expect(service.listDevices()).toEqual([]);
  });

  test('atomically supersedes only older active grants from the same client instance', () => {
    const { service } = harness();
    const clientInstanceId = '11111111-1111-4111-8111-111111111111';
    const original = pair(
      service,
      'Original display name',
      clientInstanceId,
    ).result;
    const replacement = pair(
      service,
      'Renamed display name',
      clientInstanceId,
    ).result;

    expect(replacement.replacement).toBe('superseded');
    expect(service.verifyCredential(original.credential)).toBe(false);
    expect(service.verifyCredential(replacement.credential)).toBe(true);
    expect(service.listDevices()).toEqual([
      expect.objectContaining({
        id: original.device.id,
        name: 'Original display name',
        revokedAt: 1_000,
        revocation: {
          state: 'recorded',
          actor: 'same-client-replacement',
          reason: 'same-client-replacement',
        },
      }),
      expect.objectContaining({
        id: replacement.device.id,
        name: 'Renamed display name',
        revokedAt: null,
      }),
    ]);
    for (const device of service.listDevices()) {
      expect(device).not.toHaveProperty('clientInstanceId');
    }
  });

  test('reuses the unsuffixed display name only for the same client instance', () => {
    const { service } = harness();
    const clientInstanceId = '11111111-1111-4111-8111-111111111111';
    const first = pair(service, 'Same display name', clientInstanceId).result;
    const replacement = pair(
      service,
      'Same display name',
      clientInstanceId,
    ).result;

    expect(first.device.name).toBe('Same display name');
    expect(replacement.device.name).toBe('Same display name');
    expect(replacement.replacement).toBe('superseded');
    expect(service.verifyCredential(first.credential)).toBe(false);
  });

  test('rejects an exchange whose client identity differs from the approved request', () => {
    const { service } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Brian phone',
      clientInstanceId: '11111111-1111-4111-8111-111111111111',
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);

    expect(() =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrowError(new DevicePairingError('invalid_request'));
    expect(service.listDevices()).toEqual([]);
  });

  test('does not add a client identity only after an identity-less request was approved', () => {
    const { service } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Legacy phone',
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);

    expect(() =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toThrowError(new DevicePairingError('invalid_request'));
    expect(service.listDevices()).toEqual([]);
  });

  test('does not infer a client instance from display name or supersede another device', () => {
    const { service } = harness();
    const first = pair(
      service,
      'Same display name',
      '11111111-1111-4111-8111-111111111111',
    ).result;
    const second = pair(
      service,
      'Same display name',
      '22222222-2222-4222-8222-222222222222',
    ).result;

    expect(first.replacement).toBe('none');
    expect(second.replacement).toBe('none');
    expect(service.verifyCredential(first.credential)).toBe(true);
    expect(service.verifyCredential(second.credential)).toBe(true);
    expect(service.listDevices()).toEqual([
      expect.objectContaining({ name: 'Same display name', revokedAt: null }),
      expect.objectContaining({
        name: 'Same display name (2)',
        revokedAt: null,
      }),
    ]);
  });

  // These tests induce a persistence fault by revoking write permission on
  // the security directory, which some hosts cannot express: on Windows,
  // chmod maps to the read-only attribute, which does not block creating or
  // renaming files inside a directory, and root bypasses modes entirely, so
  // the injection never fires there (station#3259). The restart round-trips
  // those hosts would otherwise lose run unconditionally below.
  describe.skipIf(skipIfCannotChmod)('chmod-induced persistence faults', () => {
    test('a persistence fault leaves a same-instance replacement entirely unapplied', () => {
      const { service, homeDir } = harness();
      const clientInstanceId = '11111111-1111-4111-8111-111111111111';
      const original = pair(service, 'Original phone', clientInstanceId).result;
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      const request = service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Replacement phone',
        clientInstanceId,
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);

      const securityDir = join(homeDir, 'security');
      chmodSync(securityDir, 0o500);
      try {
        expect(() =>
          service.exchange({
            offerId: offer.offerId,
            proof: offer.challenge,
            requestId: request.requestId,
            clientInstanceId,
          }),
        ).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(securityDir, 0o700);
      }

      expect(service.verifyCredential(original.credential)).toBe(true);
      expect(service.listDevices()).toEqual([
        expect.objectContaining({ id: original.device.id, revokedAt: null }),
      ]);
      expect(
        readFileSync(join(homeDir, 'security', 'paired-devices.json'), 'utf8'),
      ).not.toContain('Replacement phone');
    });

    test('persists revocation before changing live state, so failure, retry, and restart agree', () => {
      const { service, homeDir } = harness();
      const paired = pair(service).result;
      const securityDir = join(homeDir, 'security');
      chmodSync(securityDir, 0o500);
      try {
        expect(() =>
          service.revokeDevice(paired.device.id, 'operator-credential'),
        ).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(securityDir, 0o700);
      }
      expect(service.verifyCredential(paired.credential)).toBe(true);

      service.revokeDevice(paired.device.id, 'operator-credential');
      expect(service.verifyCredential(paired.credential)).toBe(false);
      const restarted = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });
      expect(restarted.verifyCredential(paired.credential)).toBe(false);
    });

    test('persists activity before changing live state, so failure, retry, and restart agree', () => {
      const { service, homeDir } = harness();
      const paired = pair(service).result;
      const securityDir = join(homeDir, 'security');
      chmodSync(securityDir, 0o500);
      try {
        expect(() =>
          service.recordCredentialActivity(paired.credential, 'lan'),
        ).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(securityDir, 0o700);
      }
      expect(service.identifyDevice(paired.credential)?.usageCount).toBe(0);

      expect(service.recordCredentialActivity(paired.credential, 'lan')).toBe(
        true,
      );
      const restarted = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });
      expect(restarted.identifyDevice(paired.credential)).toMatchObject({
        usageCount: 1,
        lastSeenFrom: 'lan',
      });
    });
  });

  test('a revocation survives restart', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    service.revokeDevice(paired.device.id, 'operator-credential');
    expect(service.verifyCredential(paired.credential)).toBe(false);
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.verifyCredential(paired.credential)).toBe(false);
  });

  test('recorded activity survives restart', () => {
    const { service, homeDir } = harness();
    const paired = pair(service).result;
    expect(service.recordCredentialActivity(paired.credential, 'lan')).toBe(
      true,
    );
    const restarted = new DevicePairingService({
      homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(restarted.identifyDevice(paired.credential)).toMatchObject({
      usageCount: 1,
      lastSeenFrom: 'lan',
    });
  });

  test('suffixes a device name that collides with an existing active paired device', () => {
    const { service } = harness();
    pair(service, 'Mac · Chrome');

    const { request, result } = pair(service, 'Mac · Chrome');
    expect(request.deviceName).toBe('Mac · Chrome (2)');
    expect(result.device.name).toBe('Mac · Chrome (2)');

    const { request: third } = pair(service, 'Mac · Chrome');
    expect(third.deviceName).toBe('Mac · Chrome (3)');

    expect(service.listDevices().map((device) => device.name)).toEqual([
      'Mac · Chrome',
      'Mac · Chrome (2)',
      'Mac · Chrome (3)',
    ]);
  });

  test('does not suffix a name that only collides with a revoked device', () => {
    const { service } = harness();
    const first = pair(service, 'Mac · Chrome');
    service.revokeDevice(first.result.device.id, 'operator-credential');

    const { request } = pair(service, 'Mac · Chrome');
    expect(request.deviceName).toBe('Mac · Chrome');
  });

  test('truncates a long colliding device name so its suffix stays within the length limit', () => {
    const { service } = harness();
    const longName = 'X'.repeat(64);
    pair(service, longName);

    const { request } = pair(service, longName);
    expect(request.deviceName).toBe(`${'X'.repeat(60)} (2)`);
    expect(request.deviceName.length).toBe(64);
  });

  test('suffixes a device name that collides with another still-pending request', () => {
    const { service } = harness();
    const offerA = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestA = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerA.offerId,
      proof: offerA.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestA.deviceName).toBe('Mac · Chrome');

    const offerB = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestB = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerB.offerId,
      proof: offerB.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestB.deviceName).toBe('Mac · Chrome (2)');

    const offerC = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestC = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerC.offerId,
      proof: offerC.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestC.deviceName).toBe('Mac · Chrome (3)');
  });

  test('suffixes a device name that collides with a confirmed-but-not-yet-exchanged request', () => {
    const { service } = harness();
    const offerA = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestA = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerA.offerId,
      proof: offerA.challenge,
      deviceName: 'Mac · Chrome',
    });
    service.confirmRequest(requestA.requestId, OPERATOR_APPROVAL);

    const offerB = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestB = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerB.offerId,
      proof: offerB.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestB.deviceName).toBe('Mac · Chrome (2)');
  });

  test('does not reserve a name from an expired pending request', () => {
    const { service, advance } = harness();
    const offerA = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerA.offerId,
      proof: offerA.challenge,
      deviceName: 'Mac · Chrome',
    });

    advance(2_000); // harness offerTtlMs is 1_000

    const offerB = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestB = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerB.offerId,
      proof: offerB.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestB.deviceName).toBe('Mac · Chrome');
  });

  test('does not reserve a name from a denied (cancelled) request', () => {
    const { service } = harness();
    const offerA = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestA = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerA.offerId,
      proof: offerA.challenge,
      deviceName: 'Mac · Chrome',
    });
    service.denyRequest(requestA.requestId);

    const offerB = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const requestB = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offerB.offerId,
      proof: offerB.challenge,
      deviceName: 'Mac · Chrome',
    });
    expect(requestB.deviceName).toBe('Mac · Chrome');
  });

  test('truncates a colliding emoji-heavy name without splitting a surrogate pair, even at a double-digit suffix', () => {
    const { service } = harness();
    const emojiName = '😀'.repeat(32);
    expect(emojiName.length).toBe(64);

    for (let index = 0; index < 9; index += 1) {
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: emojiName,
      });
    }

    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: emojiName,
    });

    expect(request.deviceName.endsWith(' (10)')).toBe(true);
    expect(request.deviceName.length).toBeLessThanOrEqual(64);
    // Lone surrogates would round-trip as U+FFFD through UTF-8 persistence.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        request.deviceName,
      ),
    ).toBe(false);
  });

  test('rejects expired, cancelled, altered, and unconfirmed offers', () => {
    const { service, advance } = harness();
    const expired = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    advance(1_001);
    expect(() =>
      service.requestPairing({
        requesterPosition: 'off-box',
        offerId: expired.offerId,
        proof: expired.challenge,
        deviceName: 'Phone',
      }),
    ).toThrowError(new DevicePairingError('offer_expired'));

    const cancelled = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    service.cancelOffer(cancelled.offerId);
    expect(() =>
      service.requestPairing({
        requesterPosition: 'off-box',
        offerId: cancelled.offerId,
        proof: cancelled.challenge,
        deviceName: 'Phone',
      }),
    ).toThrowError(new DevicePairingError('offer_unavailable'));

    const altered = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    expect(() =>
      service.requestPairing({
        requesterPosition: 'off-box',
        offerId: altered.offerId,
        proof: `${altered.challenge}x`,
        deviceName: 'Phone',
      }),
    ).toThrowError(new DevicePairingError('invalid_request'));

    const requested = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: altered.offerId,
      proof: altered.manualCode.toLowerCase(),
      deviceName: 'Phone',
    });
    expect(() =>
      service.exchange({
        offerId: altered.offerId,
        proof: altered.challenge,
        requestId: requested.requestId,
      }),
    ).toThrowError(new DevicePairingError('request_not_confirmed'));
  });

  test('bounds active offers and prunes expired offers before allocating', () => {
    const { service, advance } = harness(1_000, { maxActiveOffers: 2 });
    const requestAccess = (deviceName: string) =>
      service.requestAccess({
        requesterPosition: 'off-box',
        endpoint: 'https://station.example.test',
        deviceName,
      });

    requestAccess('First browser');
    requestAccess('Second browser');
    expect(() => requestAccess('Third browser')).toThrowError(
      new DevicePairingError('offer_capacity_reached'),
    );

    advance(1_001);
    expect(requestAccess('Third browser')).toEqual(
      expect.objectContaining({ environmentId: ENVIRONMENT_ID }),
    );
    expect(service.listRequests()).toEqual([
      expect.objectContaining({ deviceName: 'Third browser' }),
    ]);
  });

  test('denies a pending request and makes that decision final for exchange', () => {
    const { service } = harness();
    const access = service.requestAccess({
      requesterPosition: 'off-box',
      endpoint: 'https://station.example.test',
      deviceName: 'Unknown browser',
    });

    expect(service.denyRequest(access.requestId)).toMatchObject({
      requestId: access.requestId,
      expiresAt: access.expiresAt,
      status: 'denied',
    });
    expect(service.listRequests()).toEqual([]);
    expect(() =>
      service.exchange({
        offerId: access.offerId,
        proof: access.proof,
        requestId: access.requestId,
      }),
    ).toThrowError(new DevicePairingError('request_denied'));
  });

  test('revokes one device immediately without disrupting another', () => {
    const { service } = harness();
    const first = pair(service, 'First phone').result;
    const second = pair(service, 'Second phone').result;

    service.revokeDevice(first.device.id, 'operator-credential');

    expect(service.verifyCredential(first.credential)).toBe(false);
    expect(service.verifyCredential(second.credential)).toBe(true);
    expect(service.listDevices()).toEqual([
      expect.objectContaining({ name: 'First phone', revokedAt: 1_000 }),
      expect.objectContaining({ name: 'Second phone', revokedAt: null }),
    ]);
  });

  test('rejects a revoked device on its next remote websocket authentication', async () => {
    const { service } = harness();
    const paired = pair(service, 'Terminal phone').result;
    const terminal = new TerminalWebSocketServer(
      {
        subscribe: () => () => undefined,
        open: () => undefined,
        close: () => undefined,
      } as never,
      {
        classifyPeer: () => 'remote',
        verifyCredential: (credential) => service.verifyCredential(credential),
        authTimeoutMs: 100,
      },
    );
    const wss = terminal.start(0, '127.0.0.1');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing websocket address');
    const authenticate = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(socket, 'open');
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: paired.credential,
        }),
      );
      return socket;
    };

    const accepted = await authenticate();
    const [ack] = await once(accepted, 'message');
    expect(JSON.parse(ack.toString()).type).toBe('authenticated');
    accepted.close();
    await once(accepted, 'close');

    service.revokeDevice(paired.device.id, 'operator-credential');
    const rejected = await authenticate();
    const [code] = await once(rejected, 'close');
    expect(code).toBe(4401);

    terminal.stop();
    if (wss.address()) await once(wss, 'close');
  });

  test('allows only one winner when confirmed exchange attempts race', async () => {
    const { service } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Racing phone',
    });
    service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
    const exchange = () =>
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(exchange),
      Promise.resolve().then(exchange),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(service.listDevices()).toHaveLength(1);
  });

  test('rejects a registry from another environment instead of credential confusion', () => {
    const { homeDir, service } = harness();
    pair(service);
    expect(
      () =>
        new DevicePairingService({
          homeDir,
          environmentId: '22222222-2222-4222-8222-222222222222',
        }),
    ).toThrow(/environment/);
  });

  test('clears offers and every device credential when the environment resets', () => {
    const { service } = harness();
    const paired = pair(service).result;
    const pendingOffer = service.createOffer({
      endpoint: 'https://station.example.test',
    });

    service.resetEnvironment('22222222-2222-4222-8222-222222222222');

    expect(service.verifyCredential(paired.credential)).toBe(false);
    expect(service.listDevices()).toEqual([]);
    expect(() =>
      service.requestPairing({
        requesterPosition: 'off-box',
        offerId: pendingOffer.offerId,
        proof: pendingOffer.challenge,
        deviceName: 'Old offer',
      }),
    ).toThrowError(new DevicePairingError('invalid_offer'));
  });

  describe('Web Push subscriptions', () => {
    const subscription = () => ({
      endpoint: 'https://push.example.test/subscription/abc',
      keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
    });

    test('identifies a paired device by credential, sharing the timing-safe lookup with verifyCredential', () => {
      const { service } = harness();
      const paired = pair(service, 'Brian phone').result;

      expect(service.identifyDevice(paired.credential)).toMatchObject({
        id: paired.device.id,
        name: 'Brian phone',
      });
      expect(service.identifyDevice('unknown-credential')).toBeNull();
    });

    test('never surfaces a push subscription through publicDevice/identifyDevice/listDevices', () => {
      const { service } = harness();
      const paired = pair(service, 'Brian phone').result;
      service.setPushSubscription(paired.device.id, subscription());

      for (const device of [
        service.identifyDevice(paired.credential),
        service.listDevices()[0],
      ]) {
        expect(device).not.toHaveProperty('pushSubscription');
      }
    });

    test('subscribes, lists for fan-out, and clears idempotently', () => {
      const { service } = harness();
      const paired = pair(service, 'Brian phone').result;

      expect(service.listPushSubscriptions()).toEqual([]);

      service.setPushSubscription(paired.device.id, subscription());
      expect(service.listPushSubscriptions()).toEqual([
        { deviceId: paired.device.id, subscription: subscription() },
      ]);

      // Idempotent: clearing twice is a no-op the second time, not an error.
      service.clearPushSubscription(paired.device.id);
      service.clearPushSubscription(paired.device.id);
      expect(service.listPushSubscriptions()).toEqual([]);
    });

    test('throws device_not_found for an unknown device id on set/clear', () => {
      const { service } = harness();
      expect(() =>
        service.setPushSubscription('unknown-device-id', subscription()),
      ).toThrowError(new DevicePairingError('device_not_found'));
      expect(() =>
        service.clearPushSubscription('unknown-device-id'),
      ).toThrowError(new DevicePairingError('device_not_found'));
    });

    test('revoking a device explicitly nulls its push subscription and excludes it from fan-out', () => {
      const { homeDir, service } = harness();
      const paired = pair(service, 'Brian phone').result;
      service.setPushSubscription(paired.device.id, subscription());
      expect(service.listPushSubscriptions()).toHaveLength(1);

      service.revokeDevice(paired.device.id, 'operator-credential');

      expect(service.listPushSubscriptions()).toEqual([]);
      expect(service.identifyDevice(paired.credential)).toBeNull();

      // The AC is "revocation removes them" — assert against the persisted
      // registry itself, not just this instance's memory: the on-disk record
      // must carry a nulled subscription so a restart cannot resurrect it.
      const raw = JSON.parse(
        readFileSync(join(homeDir, 'security', 'paired-devices.json'), 'utf8'),
      );
      const stored = raw.devices.find(
        (device: { id: string }) => device.id === paired.device.id,
      );
      expect(stored.pushSubscription).toBeNull();
      expect(stored.revokedAt).not.toBeNull();
    });

    test('rejects an invalid subscription shape from a corrupt registry load', () => {
      const { service, homeDir } = harness();
      pair(service, 'Brian phone');
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
      raw.devices[0].pushSubscription = { endpoint: 'not-https', keys: {} };
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, {
        mode: 0o600,
      });

      expect(
        () =>
          new DevicePairingService({
            homeDir,
            environmentId: ENVIRONMENT_ID,
          }),
      ).toThrow(/push subscription/);
    });

    test('rejects unknown registry and device-record fields instead of surfacing hand-edited state', () => {
      const { service, homeDir } = harness();
      pair(service, 'Brian phone');
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
      raw.devices[0].untrustedAttribution = 'invented';
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, {
        mode: 0o600,
      });

      expect(
        () =>
          new DevicePairingService({
            homeDir,
            environmentId: ENVIRONMENT_ID,
          }),
      ).toThrowError('Invalid paired-device record');

      delete raw.devices[0].untrustedAttribution;
      raw.unknownRegistryField = true;
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, {
        mode: 0o600,
      });
      expect(
        () =>
          new DevicePairingService({
            homeDir,
            environmentId: ENVIRONMENT_ID,
          }),
      ).toThrowError('Invalid paired-device registry schema or environment');
    });

    test('treats a missing pushSubscription field on an older registry record as null (additive)', () => {
      const { service, homeDir } = harness();
      pair(service, 'Brian phone');
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
      delete raw.devices[0].pushSubscription;
      writeFileSync(registryPath, `${JSON.stringify(raw)}\n`, {
        mode: 0o600,
      });

      const reloaded = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });
      expect(reloaded.listPushSubscriptions()).toEqual([]);
    });
  });

  describe('scoped pairing (station#1098)', () => {
    test('an offer created without an explicit scope defaults to full access', () => {
      const { service } = harness();
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      expect(offer.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
      const { result } = pair(service);
      expect(result.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
    });

    test('an offer created with a preset scope carries it through request and exchange (AC2)', () => {
      const { service } = harness();
      const readOnlyScope = pairingScopePresetString('read-only');
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
        scope: readOnlyScope,
      });
      expect(offer.scope).toBe(readOnlyScope);

      const request = service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Read-only phone',
      });
      expect(request.scope).toBe(readOnlyScope);

      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      const result = service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });
      expect(result.device.scope).toBe(readOnlyScope);
      expect(
        pairingScopeIncludes(result.device.scope, 'orchestration:read'),
      ).toBe(true);
      expect(
        pairingScopeIncludes(result.device.scope, 'orchestration:operate'),
      ).toBe(false);
    });

    test('the standard preset excludes access:manage even though it grants terminal:operate', () => {
      const { service } = harness();
      const standardScope = pairingScopePresetString('standard');
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
        scope: standardScope,
      });
      expect(pairingScopeIncludes(offer.scope, 'terminal:operate')).toBe(true);
      expect(pairingScopeIncludes(offer.scope, 'access:manage')).toBe(false);
    });

    test('rejects an unknown or malformed scope string', () => {
      const { service } = harness();
      for (const scope of [
        '',
        'not-a-real-scope',
        'orchestration:read,extra',
      ]) {
        expect(() =>
          service.createOffer({
            endpoint: 'https://station.example.test',
            scope,
          }),
        ).toThrowError(new DevicePairingError('invalid_request'));
      }
    });

    test('migrates a pre-scoping (station:interactive) device to full access with no forced re-pair (R4/AC3)', () => {
      const { homeDir } = harness();
      const registryPath = join(homeDir, 'security', 'paired-devices.json');

      // A registry exactly as it would have looked before scoped pairing
      // shipped: the fixed legacy scope marker, and a credential this test
      // can still present in plaintext (only its hash is ever persisted).
      const legacyCredential = 'legacy-plaintext-credential-not-yet-scoped-01';
      const credentialHash = createHash('sha256')
        .update(legacyCredential)
        .digest('base64url');
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          devices: [
            {
              id: 'legacy-device',
              name: 'Old phone',
              scope: DEVICE_PAIRING_SCOPE,
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
              credentialHash,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );

      const migrated = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });

      // AC3: the exact same credential still authenticates post-upgrade.
      expect(migrated.verifyCredential(legacyCredential)).toBe(true);
      const device = migrated.identifyDevice(legacyCredential);
      expect(device?.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
      expect(pairingScopeIncludes(device!.scope, 'access:manage')).toBe(true);

      // The migration is durable on disk, not just in this instance's
      // memory: a fresh load (no intervening mutation) already sees the
      // migrated shape.
      const onDisk = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(onDisk.devices[0].scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
    });

    test('leaves an already-scoped registry record untouched on load', () => {
      const { service, homeDir } = harness();
      const readOnlyScope = pairingScopePresetString('read-only');
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
        scope: readOnlyScope,
      });
      const request = service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Read-only phone',
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });

      const reloaded = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });
      expect(reloaded.listDevices()).toEqual([
        expect.objectContaining({ scope: readOnlyScope }),
      ]);
    });
  });

  describe('delegation preset + PairedDevice.kind (station#1123 slice 1)', () => {
    test('an offer created without an explicit kind exchanges to kind "device"', () => {
      const { service } = harness();
      const { result } = pair(service);
      expect(result.device.kind).toBe('device');
    });

    test('an offer created with kind "delegation" exchanges to a delegation-kind device carrying the delegation preset scope', () => {
      const { service } = harness();
      const delegationScope = pairingScopePresetString('delegation');
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
        scope: delegationScope,
        kind: 'delegation',
      });
      const request = service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Peer: box-b',
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      const result = service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });

      expect(result.device.kind).toBe('delegation');
      expect(result.device.scope).toBe(delegationScope);
      expect(
        pairingScopeIncludes(result.device.scope, 'orchestration:read'),
      ).toBe(true);
      expect(
        pairingScopeIncludes(result.device.scope, 'orchestration:operate'),
      ).toBe(true);
      // The whole point of the dedicated preset: no terminal, unlike standard.
      expect(
        pairingScopeIncludes(result.device.scope, 'terminal:operate'),
      ).toBe(false);

      // Listed and revocable from the very same registry/API a device uses.
      expect(service.listDevices()).toEqual([
        expect.objectContaining({ id: result.device.id, kind: 'delegation' }),
      ]);
      const revoked = service.revokeDevice(
        result.device.id,
        'operator-credential',
      );
      expect(revoked.kind).toBe('delegation');
      expect(revoked.revokedAt).not.toBeNull();
      expect(service.verifyCredential(result.credential)).toBe(false);
    });

    test('rejects an unknown kind', () => {
      const { service } = harness();
      const invalidKind = 'operator' as unknown as 'device' | 'delegation';
      expect(() =>
        service.createOffer({
          endpoint: 'https://station.example.test',
          kind: invalidKind,
        }),
      ).toThrowError(new DevicePairingError('invalid_request'));
    });

    test('a device paired before "kind" existed reads back as "device" with no forced re-pair', () => {
      const { homeDir } = harness();
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      const legacyCredential = 'legacy-plaintext-credential-no-kind-field-01';
      const credentialHash = createHash('sha256')
        .update(legacyCredential)
        .digest('base64url');
      // A registry exactly as station#1098-shipped scoped pairing wrote it —
      // scope present, `kind` not yet invented, so no such key at all.
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          devices: [
            {
              id: 'pre-kind-device',
              name: 'Old phone',
              scope: DEFAULT_GRANT_PAIRING_SCOPE,
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
              credentialHash,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );

      const migrated = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });

      expect(migrated.identifyDevice(legacyCredential)?.kind).toBe('device');
      expect(migrated.listDevices()).toEqual([
        expect.objectContaining({ id: 'pre-kind-device', kind: 'device' }),
      ]);
    });
  });

  /**
   * station#1878 slice 1 — the pairing request already carries `source` and
   * (for a tailnet request) a verified `requester`; `confirmRequest` weighs
   * both before approval and `exchange()` used to drop them on the floor.
   * These prove the exact record `exchange()` writes, not an imagined shape.
   */
  describe('device provenance (station#1878 slice 1)', () => {
    test('a same-origin request exchanges to a device record carrying source "same-origin" and no requester', () => {
      const { service } = harness();
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      const request = service.requestPairing({
        requesterPosition: 'unproven',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Same-origin browser',
        source: 'same-origin',
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      const result = service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });

      expect(result.device.source).toBe('same-origin');
      expect(result.device).not.toHaveProperty('requester');
      expect(service.listDevices()).toEqual([
        expect.objectContaining({
          id: result.device.id,
          source: 'same-origin',
        }),
      ]);
    });

    test('a pairing-code request (the default provenance requestPairing/pair() exercises) exchanges to a device record carrying source "pairing-code"', () => {
      const { service } = harness();
      const { result } = pair(service);

      expect(result.device.source).toBe('pairing-code');
      expect(result.device).not.toHaveProperty('requester');
    });

    test('a tailnet request exchanges to a device record carrying source "tailnet" and the verified requester', () => {
      const { service } = harness();
      const offer = service.createOffer({
        endpoint: 'https://station.example.test',
      });
      const request = service.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Tailnet laptop',
        source: 'tailnet',
        requester: {
          provider: 'tailscale-serve',
          login: 'brian@example.test',
          displayName: 'Brian',
        },
      });
      service.confirmRequest(request.requestId, OPERATOR_APPROVAL);
      const result = service.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
      });

      expect(result.device.source).toBe('tailnet');
      expect(result.device.requester).toEqual({
        provider: 'tailscale-serve',
        login: 'brian@example.test',
        displayName: 'Brian',
      });
      // Listed and revocable the same way as any other device — the new
      // fields ride the same registry, not a side channel.
      expect(service.listDevices()).toEqual([
        expect.objectContaining({
          id: result.device.id,
          source: 'tailnet',
          requester: {
            provider: 'tailscale-serve',
            login: 'brian@example.test',
            displayName: 'Brian',
          },
        }),
      ]);
      const revoked = service.revokeDevice(
        result.device.id,
        'operator-credential',
      );
      expect(revoked.source).toBe('tailnet');
      expect(revoked.requester).toEqual({
        provider: 'tailscale-serve',
        login: 'brian@example.test',
        displayName: 'Brian',
      });
    });

    test('a device paired before "source"/"requester" existed reads back with neither key, not a guessed default', () => {
      const { homeDir } = harness();
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      const legacyCredential = 'legacy-plaintext-credential-no-provenance-01';
      const credentialHash = createHash('sha256')
        .update(legacyCredential)
        .digest('base64url');
      // A registry exactly as station#1123 slice 1 shipped it — `kind`
      // present, `source`/`requester` not yet invented, so no such keys at
      // all.
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          devices: [
            {
              id: 'pre-provenance-device',
              name: 'Old phone',
              scope: DEFAULT_GRANT_PAIRING_SCOPE,
              kind: 'device',
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
              credentialHash,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );

      const migrated = new DevicePairingService({
        homeDir,
        environmentId: ENVIRONMENT_ID,
      });

      expect(migrated.identifyDevice(legacyCredential)?.id).toBe(
        'pre-provenance-device',
      );
      const [device] = migrated.listDevices();
      expect(device).not.toHaveProperty('source');
      expect(device).not.toHaveProperty('requester');
    });

    test('rejects a persisted requester that is not paired with a tailnet source', () => {
      const { homeDir } = harness();
      const registryPath = join(homeDir, 'security', 'paired-devices.json');
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          schemaVersion: 1,
          environmentId: ENVIRONMENT_ID,
          devices: [
            {
              id: 'corrupted-device',
              name: 'Old phone',
              scope: DEFAULT_GRANT_PAIRING_SCOPE,
              kind: 'device',
              createdAt: 1,
              lastUsedAt: null,
              revokedAt: null,
              credentialHash: createHash('sha256')
                .update('x')
                .digest('base64url'),
              source: 'same-origin',
              requester: {
                provider: 'tailscale-serve',
                login: 'attacker@example.test',
              },
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );

      expect(
        () =>
          new DevicePairingService({
            homeDir,
            environmentId: ENVIRONMENT_ID,
          }),
      ).toThrowError('Invalid paired-device record');
    });
  });
});

/**
 * station#1490 — approval is the step that converts a position into durable
 * authority, so `confirmRequest` (not the HTTP boundary alone) decides what a
 * caller who presented no credential may approve. The rule it enforces: such a
 * caller may approve only a request this host could PROVE came from another
 * network stack (`isDefinitelyOffBox`, applied at the boundary and carried
 * here as `requesterPosition`).
 */
describe('confirmRequest approval guard (station#1490)', () => {
  function accessRequest(
    service: DevicePairingService,
    requesterPosition: PairingRequesterPosition,
    name = 'Tunnel probe',
  ) {
    return service.requestAccess({
      endpoint: 'https://station.example.test',
      deviceName: name,
      requesterPosition,
    });
  }

  test('refuses an unauthenticated approval of a request whose origin is unproven', () => {
    const { service } = harness();
    const access = accessRequest(service, 'unproven');

    expect(() =>
      service.confirmRequest(access.requestId, FLOOR_APPROVAL),
    ).toThrowError(
      expect.objectContaining({ code: 'approval_requires_operator' }),
    );
    // The refusal must leave the request approvable by someone else, not
    // consume it: a denial that also destroyed the request would be a way to
    // grief the operator's own pending pairings.
    expect(service.listRequests()).toEqual([
      expect.objectContaining({
        requestId: access.requestId,
        status: 'pending',
      }),
    ]);
    // And no credential is mintable, which is the property that actually
    // matters — a refusal that still left the request confirmable would be
    // cosmetic.
    expect(() =>
      service.exchange({
        offerId: access.offerId,
        proof: access.proof,
        requestId: access.requestId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'request_not_confirmed' }));
  });

  test('the same request is approvable by a caller that presented a credential', () => {
    const { service } = harness();
    const access = accessRequest(service, 'unproven');

    expect(
      service.confirmRequest(access.requestId, OPERATOR_APPROVAL).status,
    ).toBe('confirmed');
    expect(
      service.exchange({
        offerId: access.offerId,
        proof: access.proof,
        requestId: access.requestId,
      }).device.name,
    ).toBe('Tunnel probe');
  });

  test('still lets an unauthenticated caller approve a device that reached this Station from off-box', () => {
    const { service } = harness();
    // The primary journey: a phone on the LAN opens Station's own UI and asks
    // for access; the operator approves from an unenrolled browser at the
    // machine, presenting nothing. Note the grant is the unscoped default —
    // this is also the regression guard for refusing that journey on
    // provenance or scope grounds.
    const access = accessRequest(service, 'off-box', 'Brian phone');

    expect(
      service.confirmRequest(access.requestId, FLOOR_APPROVAL).status,
    ).toBe('confirmed');
    expect(
      service.exchange({
        offerId: access.offerId,
        proof: access.proof,
        requestId: access.requestId,
      }).device.scope,
    ).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
  });

  test('still lets an unauthenticated caller approve the scanned pairing-code journey', () => {
    const { service } = harness();
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const request = service.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Brian phone',
      source: 'pairing-code',
      requesterPosition: 'off-box',
    });

    expect(
      service.confirmRequest(request.requestId, FLOOR_APPROVAL).status,
    ).toBe('confirmed');
  });

  test('refuses an unauthenticated approval of a pairing-code request of unproven origin', () => {
    const { service } = harness();
    // The recombination that request provenance alone cannot distinguish: an
    // offer minted on the floor, its challenge read straight out of the
    // response, and a "pairing code" request submitted from the same position.
    const offer = service.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const request = service.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Recombined probe',
      source: 'pairing-code',
      requesterPosition: 'unproven',
    });

    expect(() =>
      service.confirmRequest(request.requestId, FLOOR_APPROVAL),
    ).toThrowError(
      expect.objectContaining({ code: 'approval_requires_operator' }),
    );
  });

  test('an unrecognized approval kind fails closed rather than inheriting the floor', () => {
    const { service } = harness();
    const access = accessRequest(service, 'unproven', 'Future caller');

    // The guard must not read "not the unauthenticated literal" as
    // "credentialed": a third kind added later has to be classified
    // deliberately, not admitted by falling off the end of a comparison.
    const unknownApproval = {
      kind: 'operator-was-here',
    } as unknown as PairingApproval;
    expect(() =>
      service.confirmRequest(access.requestId, unknownApproval),
    ).toThrowError(
      expect.objectContaining({ code: 'approval_requires_operator' }),
    );
  });

  // station#1887: `access:approve` is grantable ONLY by an operator promoting
  // an already-paired device. These pin both directions — that the promotion
  // works, and that the authority it confers cannot be self-granted from the
  // historical loopback compatibility floor, which station#2051 retired for
  // ordinary callers; the service-level guard remains defense in depth.
  describe('device approval authority (station#1887)', () => {
    test('an operator can promote a paired device, and the token is not granted at pairing time', () => {
      const { service } = harness();
      const { result } = pair(service);
      const deviceId = service.listDevices()[0]!.id;

      // Pairing itself never confers it, whatever preset was used.
      expect(service.credentialMayApprovePairing(result.credential)).toBe(
        false,
      );

      const promoted = service.setDeviceApprovalAuthority(
        deviceId,
        true,
        OPERATOR_APPROVAL,
      );
      expect(promoted.scope.split(' ')).toContain('access:approve');
      expect(service.credentialMayApprovePairing(result.credential)).toBe(true);

      // Demotion removes exactly that token and leaves the rest intact.
      const demoted = service.setDeviceApprovalAuthority(
        deviceId,
        false,
        OPERATOR_APPROVAL,
      );
      expect(demoted.scope.split(' ')).not.toContain('access:approve');
      expect(demoted.scope.split(' ')).toContain('orchestration:read');
      expect(service.credentialMayApprovePairing(result.credential)).toBe(
        false,
      );
    });

    test('an unauthenticated caller cannot promote — no off-box exception', () => {
      const { service } = harness();
      const { result } = pair(service);
      const deviceId = service.listDevices()[0]!.id;

      // Unlike approving a REQUEST, promotion has no "the subject is provably
      // elsewhere" mitigating fact, so there is no position that earns it.
      expect(() =>
        service.setDeviceApprovalAuthority(deviceId, true, {
          kind: 'unauthenticated',
        }),
      ).toThrow(/approval_requires_operator/);
      expect(service.credentialMayApprovePairing(result.credential)).toBe(
        false,
      );
    });

    test('the local-grant (desktop shell) path may promote', () => {
      const { service } = harness();
      const { result } = pair(service);
      const deviceId = service.listDevices()[0]!.id;
      service.setDeviceApprovalAuthority(deviceId, true, {
        kind: 'local-grant',
      });
      expect(service.credentialMayApprovePairing(result.credential)).toBe(true);
    });

    test('a revoked device cannot be promoted — a tombstone is not re-armed', () => {
      const { service } = harness();
      const { result } = pair(service);
      const deviceId = service.listDevices()[0]!.id;
      service.revokeDevice(deviceId, 'operator-credential');

      expect(() =>
        service.setDeviceApprovalAuthority(deviceId, true, OPERATOR_APPROVAL),
      ).toThrow(/device_revoked/);
      expect(service.credentialMayApprovePairing(result.credential)).toBe(
        false,
      );
    });

    test('promotion is idempotent and keeps the stored scope canonical', () => {
      const { service } = harness();
      pair(service);
      const deviceId = service.listDevices()[0]!.id;
      const first = service.setDeviceApprovalAuthority(
        deviceId,
        true,
        OPERATOR_APPROVAL,
      );
      const second = service.setDeviceApprovalAuthority(
        deviceId,
        true,
        OPERATOR_APPROVAL,
      );
      expect(second.scope).toBe(first.scope);
      // Vocabulary order, not append order — the stored string must not drift
      // by how it was assembled.
      const tokens = first.scope.split(' ');
      expect([...tokens].sort()).toEqual(tokens.slice().sort());
      expect(tokens.at(-1)).toBe('access:approve');
    });
  });
});
