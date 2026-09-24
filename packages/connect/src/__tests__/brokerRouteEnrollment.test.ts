import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  DeviceConnectionTrustRecord,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerClientGrantV1,
  SelfHostedBrokerRouteInvitationV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import { stationConnectionSigningKeyId } from '@kontourai/station-shared/connection-proof';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BrowserRoutingGrantCustody,
  type BrowserRoutingGrantStorage,
  encodeBrokerRouteInvitationFragment,
  parseBrokerRouteInvitationUrl,
  redeemBrokerRouteInvitation,
} from '../core/brokerRouteEnrollment.js';

const BROWSER_ORIGIN = 'https://client.example.test';
const BROKER_ORIGIN = 'https://broker.example.test';
const ROUTING_SECRET = 'R'.repeat(43);

class MemoryGrantStorage implements BrowserRoutingGrantStorage {
  readonly entries = new Map<string, unknown>();

  async read(key: string) {
    return this.entries.get(key) ?? null;
  }

  async write(key: string, grant: SelfHostedBrokerClientGrantV1) {
    this.entries.set(key, structuredClone(grant));
  }

  async removeIfCredentialId(key: string, credentialId: string) {
    const value = this.entries.get(key) as
      | SelfHostedBrokerClientGrantV1
      | undefined;
    if (value?.credential.id === credentialId) this.entries.delete(key);
  }
}

async function trustFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const signingKey: StationConnectionSigningKey = {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x!,
    y: jwk.y!,
  };
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 7,
    signingKey,
  };
  const trustRecord: DeviceConnectionTrustRecord = {
    schemaVersion: 1,
    revision: 2,
    status: 'approved',
    trust,
  };
  return { trust, trustRecord };
}

async function invitationFor(trust: ApprovedStationConnectionTrust) {
  return {
    version: 'station-broker-route-invitation/v1',
    brokerOrigin: BROKER_ORIGIN,
    scope: {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 3,
      browserOrigin: BROWSER_ORIGIN,
    },
    stationSigningKeyId: await stationConnectionSigningKeyId(trust),
    stationSigningGeneration: trust.generation,
    invitationId: randomUUID(),
    invitationSecret: 'I'.repeat(43),
    expiresAt: Date.now() + 60_000,
  } satisfies SelfHostedBrokerRouteInvitationV1;
}

function grantFor(
  invitation: SelfHostedBrokerRouteInvitationV1,
  credentialId = 'client-grant-0001',
): SelfHostedBrokerClientGrantV1 {
  return {
    version: 'station-broker-client-grant/v1',
    brokerOrigin: invitation.brokerOrigin,
    scope: structuredClone(invitation.scope),
    stationSigningKeyId: invitation.stationSigningKeyId,
    stationSigningGeneration: invitation.stationSigningGeneration,
    credential: { id: credentialId, secret: ROUTING_SECRET },
    expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('broker route invitation enrollment and custody', () => {
  beforeEach(() => vi.stubGlobal('location', { origin: BROWSER_ORIGIN }));
  afterEach(() => vi.unstubAllGlobals());

  test('refuses a trust mismatch before consuming the invitation', async () => {
    const { trustRecord } = await trustFixture();
    const invitation = await invitationFor({
      ...trustRecord.trust,
      stationId: randomUUID(),
    });
    const fetch = vi.fn();
    const custody = new BrowserRoutingGrantCustody({
      storage: new MemoryGrantStorage(),
    });

    await expect(
      redeemBrokerRouteInvitation({
        invitation,
        trustRecord,
        trustStore: { read: async () => trustRecord },
        custody,
        request: fetch,
      }),
    ).rejects.toThrow('broker_route_trust_required');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('invitation codec uses only the bounded Computers URL fragment', async () => {
    const { trust } = await trustFixture();
    const invitation = await invitationFor(trust);
    const fragment = encodeBrokerRouteInvitationFragment(invitation);
    const url = new URL(`/connections/computers${fragment}`, BROWSER_ORIGIN);
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#relay-invite=')).toBe(true);
    expect(parseBrokerRouteInvitationUrl(url.href)).toEqual(invitation);

    expect(() =>
      parseBrokerRouteInvitationUrl(
        `${BROWSER_ORIGIN}/connections/computers?relay-invite=${url.hash.slice('#relay-invite='.length)}`,
      ),
    ).toThrow('broker_invitation_fragment_invalid');
    expect(() =>
      parseBrokerRouteInvitationUrl(
        `https://other.example.test/connections/computers${fragment}`,
      ),
    ).toThrow('broker_invitation_fragment_invalid');
    expect(() =>
      parseBrokerRouteInvitationUrl(
        `${BROWSER_ORIGIN}/connections/computers#relay-invite=not*base64`,
      ),
    ).toThrow('broker_invitation_fragment_invalid');
    expect(() =>
      parseBrokerRouteInvitationUrl(
        `${BROWSER_ORIGIN}/connections/computers#relay-invite=${'A'.repeat(5500)}`,
      ),
    ).toThrow('broker_invitation_fragment_invalid');
  });

  test('redeems without Station credentials and forgets only its local grant copy', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const grant = grantFor(invitation);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(grant),
    );

    await redeemBrokerRouteInvitation({
      invitation,
      trustRecord,
      trustStore: { read: async () => trustRecord },
      custody,
      request: fetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BROKER_ORIGIN}/broker/v1/grants/redeem`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(String(init?.body)).toContain(invitation.invitationSecret);
    expect(String(init?.body)).not.toContain('Authorization');

    const first = custody.capture();
    const second = custody.capture();
    expect(first.id).toBe(grant.credential.id);
    expect(first.secret).toBe(grant.credential.secret);
    expect(first.isCurrent()).toBe(true);
    expect(second.id).toBe(first.id);

    await custody.replace(
      grantFor(invitation, 'client-grant-0002'),
      trustRecord,
      {
        read: async () => trustRecord,
      },
    );
    expect(first.isCurrent()).toBe(false);
    expect(custody.capture().id).toBe('client-grant-0002');
    await custody.forgetLocal();
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');
    expect(storage.entries.size).toBe(0);
  });

  test('does not persist a grant if trust is revoked while redemption is in flight', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    let reads = 0;
    const trustStore = {
      read: async () => {
        reads += 1;
        return reads === 1
          ? trustRecord
          : {
              ...trustRecord,
              revision: trustRecord.revision + 1,
              status: 'revoked' as const,
            };
      },
    };

    await expect(
      redeemBrokerRouteInvitation({
        invitation,
        trustRecord,
        trustStore,
        custody,
        request: async () => jsonResponse(grantFor(invitation)),
      }),
    ).rejects.toThrow('broker_route_trust_retired');
    expect(storage.entries.size).toBe(0);
  });

  test('a delayed redemption cannot overwrite a newer same-route enrollment', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitationA = await invitationFor(trust);
    const invitationB = await invitationFor(trust);
    const grantA = grantFor(invitationA, 'client-grant-delayed');
    const grantB = grantFor(invitationB, 'client-grant-current');
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const responseA = deferred<Response>();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const trustStore = { read: async () => trustRecord };

    const redeemA = redeemBrokerRouteInvitation({
      invitation: invitationA,
      trustRecord,
      trustStore,
      custody,
      request: async () => {
        requestStarted();
        return responseA.promise;
      },
    });
    await started;
    const redeemB = redeemBrokerRouteInvitation({
      invitation: invitationB,
      trustRecord,
      trustStore,
      custody,
      request: async () => jsonResponse(grantB),
    });
    await expect(redeemA).rejects.toThrow('broker_grant_stale');
    await redeemB;
    responseA.resolve(jsonResponse(grantA));

    expect(custody.capture().id).toBe(grantB.credential.id);
    expect([...storage.entries.values()]).toEqual([grantB]);
  });

  test('forgetLocal cancels a pending redemption before its response arrives', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const response = deferred<Response>();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const pending = redeemBrokerRouteInvitation({
      invitation,
      trustRecord,
      trustStore: { read: async () => trustRecord },
      custody,
      request: async () => {
        requestStarted();
        return response.promise;
      },
    });
    await started;
    await custody.forgetLocal();
    await expect(pending).rejects.toThrow('broker_grant_stale');
    response.resolve(jsonResponse(grantFor(invitation)));
    expect(storage.entries.size).toBe(0);
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');
  });

  test('abort during post-response trust read prevents custody installation', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const trustRead = deferred<DeviceConnectionTrustRecord | null>();
    let postResponseReadStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (postResponseReadStarted = resolve),
    );
    let readCount = 0;
    const trustStore = {
      read: async () => {
        readCount += 1;
        if (readCount === 2) {
          postResponseReadStarted();
          return trustRead.promise;
        }
        return trustRecord;
      },
    };
    const controller = new AbortController();
    const pending = redeemBrokerRouteInvitation({
      invitation,
      trustRecord,
      trustStore,
      custody,
      signal: controller.signal,
      request: async () => jsonResponse(grantFor(invitation)),
    });
    await started;
    controller.abort(new Error('user-cancelled'));
    await expect(pending).rejects.toThrow('user-cancelled');
    trustRead.resolve(trustRecord);
    expect(storage.entries.size).toBe(0);
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');
  });

  test('rechecks signing generation on restore and at each connection start', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const trustStore = { read: async () => trustRecord };
    await custody.replace(grantFor(invitation), trustRecord, trustStore);
    const route = {
      brokerOrigin: BROKER_ORIGIN,
      browserOrigin: BROWSER_ORIGIN,
      scope: invitation.scope,
    };
    expect(await custody.assertBoundToTrust(trustRecord, route)).toBe(true);

    const rotated = {
      ...trustRecord,
      revision: trustRecord.revision + 1,
      trust: {
        ...trustRecord.trust,
        generation: trustRecord.trust.generation + 1,
      },
    };
    const replacementTrustStore = { read: async () => rotated };
    expect(await custody.assertBoundToTrust(rotated, route)).toBe(false);
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');

    const restoreStorage = new MemoryGrantStorage();
    const storedGrant = grantFor(invitation, 'client-grant-stored');
    await restoreStorage.write(
      [BROKER_ORIGIN, trust.stationId, trust.enrollmentId, BROWSER_ORIGIN].join(
        '\n',
      ),
      storedGrant,
    );
    const restored = new BrowserRoutingGrantCustody({
      storage: restoreStorage,
    });
    expect(
      await restored.restore({
        brokerOrigin: BROKER_ORIGIN,
        scope: invitation.scope,
        trustRecord: rotated,
        trustStore: replacementTrustStore,
      }),
    ).toBe(false);
    expect(restoreStorage.entries.size).toBe(0);
  });

  test('a late same-route write cannot delete a newer grant', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const first = grantFor(invitation, 'client-grant-first');
    const second = grantFor(invitation, 'client-grant-second');
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (firstWriteStarted = resolve),
    );
    const gate = new Promise<void>((resolve) => (releaseFirstWrite = resolve));
    class DelayedStorage extends MemoryGrantStorage {
      writeCount = 0;
      override async write(key: string, grant: SelfHostedBrokerClientGrantV1) {
        this.writeCount += 1;
        if (this.writeCount === 1) {
          firstWriteStarted();
          await gate;
        }
        await super.write(key, grant);
      }
    }
    const storage = new DelayedStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const trustStore = { read: async () => trustRecord };

    const firstWrite = custody.replace(first, trustRecord, trustStore);
    await started;
    const secondWrite = custody.replace(second, trustRecord, trustStore);
    releaseFirstWrite();
    await expect(firstWrite).rejects.toThrow('broker_grant_stale');
    await secondWrite;
    expect(custody.capture().id).toBe(second.credential.id);
    expect(storage.entries.size).toBe(1);
    expect([...storage.entries.values()]).toEqual([second]);
  });

  test('a late restore cannot overwrite a replacement grant', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const stored = grantFor(invitation, 'client-grant-stored');
    const replacement = grantFor(invitation, 'client-grant-replaced');
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    class DelayedReadStorage extends MemoryGrantStorage {
      override async read(key: string) {
        readStarted();
        await gate;
        return super.read(key);
      }
    }
    const storage = new DelayedReadStorage();
    await storage.write(
      [BROKER_ORIGIN, trust.stationId, trust.enrollmentId, BROWSER_ORIGIN].join(
        '\n',
      ),
      stored,
    );
    const custody = new BrowserRoutingGrantCustody({ storage });
    const restore = custody.restore({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
      trustRecord,
      trustStore: { read: async () => trustRecord },
    });
    await started;
    const replace = custody.replace(replacement, trustRecord, {
      read: async () => trustRecord,
    });
    releaseRead();
    await expect(restore).resolves.toBe(false);
    await replace;
    expect(custody.capture().id).toBe(replacement.credential.id);
  });

  test('route cleanup removes a persisted grant after restart', async () => {
    const { trust } = await trustFixture();
    const invitation = await invitationFor(trust);
    const grant = grantFor(invitation);
    const storage = new MemoryGrantStorage();
    await storage.write(
      [BROKER_ORIGIN, trust.stationId, trust.enrollmentId, BROWSER_ORIGIN].join(
        '\n',
      ),
      grant,
    );
    const restartedCustody = new BrowserRoutingGrantCustody({ storage });

    await restartedCustody.forgetRoute({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
    });
    expect(storage.entries.size).toBe(0);
    expect(() => restartedCustody.capture()).toThrow(
      'broker_credential_unavailable',
    );
  });

  test('route cleanup preserves a concurrent replacement credential', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const previous = grantFor(invitation, 'client-grant-previous');
    const replacement = grantFor(invitation, 'client-grant-replacement');
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    class DelayedReadStorage extends MemoryGrantStorage {
      override async read(key: string) {
        readStarted();
        await gate;
        return super.read(key);
      }
    }
    const storage = new DelayedReadStorage();
    await storage.write(
      [BROKER_ORIGIN, trust.stationId, trust.enrollmentId, BROWSER_ORIGIN].join(
        '\n',
      ),
      previous,
    );
    const custody = new BrowserRoutingGrantCustody({ storage });
    const forgetting = custody.forgetRoute({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
    });
    await started;
    const replacing = custody.replace(replacement, trustRecord, {
      read: async () => trustRecord,
    });
    releaseRead();
    await Promise.all([forgetting, replacing]);

    expect(custody.capture().id).toBe(replacement.credential.id);
    expect([...storage.entries.values()]).toEqual([replacement]);
  });

  test('route cleanup invalidates a replacement awaiting its first trust read', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storage = new MemoryGrantStorage();
    const custody = new BrowserRoutingGrantCustody({ storage });
    const pendingTrust = deferred<DeviceConnectionTrustRecord | null>();
    let trustReadStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (trustReadStarted = resolve),
    );
    const trustStore = {
      read: async () => {
        trustReadStarted();
        return pendingTrust.promise;
      },
    };

    const replacing = custody.replace(
      grantFor(invitation),
      trustRecord,
      trustStore,
    );
    await started;
    await custody.forgetRoute({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
    });
    pendingTrust.resolve(trustRecord);
    await expect(replacing).rejects.toThrow('broker_grant_stale');
    expect(storage.entries.size).toBe(0);
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');
  });

  test('route cleanup cancels restore waiting on its trust read', async () => {
    const { trust, trustRecord } = await trustFixture();
    const invitation = await invitationFor(trust);
    const storedGrant = grantFor(invitation, 'client-grant-pending-restore');
    const storage = new MemoryGrantStorage();
    await storage.write(
      [BROKER_ORIGIN, trust.stationId, trust.enrollmentId, BROWSER_ORIGIN].join(
        '\n',
      ),
      storedGrant,
    );
    const custody = new BrowserRoutingGrantCustody({ storage });
    const trustRead = deferred<DeviceConnectionTrustRecord | null>();
    let trustReadStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (trustReadStarted = resolve),
    );
    const restore = custody.restore({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
      trustRecord,
      trustStore: {
        read: async () => {
          trustReadStarted();
          return trustRead.promise;
        },
      },
    });
    await started;

    await custody.forgetRoute({
      brokerOrigin: BROKER_ORIGIN,
      scope: invitation.scope,
    });
    trustRead.resolve(trustRecord);
    await expect(restore).resolves.toBe(false);
    expect(storage.entries.size).toBe(0);
    expect(() => custody.capture()).toThrow('broker_credential_unavailable');
  });
});
