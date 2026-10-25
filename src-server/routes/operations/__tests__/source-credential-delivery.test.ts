import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import {
  createStationHomeBackup,
  createStationHomeUpdateBackup,
  restoreStationHomeBackup,
  restoreStationHomeUpdateBackup,
} from '@kontourai/station-shared/station-home-archive';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod/v3';
import {
  analyticsReviewUrl,
  fetchAnalyticsRecipientSetup,
  fetchAnalyticsReview,
  performAnalyticsSetup,
} from '../../../../packages/sdk/src/client/analytics-enrollment.js';
import { setClientCredentialResolver } from '../../../../packages/sdk/src/client/http.js';
import { privateUsageFixture } from '../../../../packages/telemetry-broker/src/__tests__/private-usage-fixture.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { captureAnalyticsHomeActivation } from '../../../analytics/analytics-activation.js';
import type { PrivateUsageTarget } from '../../../analytics/private-usage-client.js';
import { RecipientStore } from '../../../analytics/recipient-store.js';
import {
  sourceCredentialDeliverySchema,
  sourceCredentialHash,
} from '../../../analytics/source-credential.js';
import { SourceEnrollmentStore } from '../../../analytics/source-enrollment-store.js';
import { sourceDeliveryProofSchema } from '../../../analytics/source-export-proof.js';
import {
  type SourceApprovalActor,
  SourceGrantApprovalStore,
} from '../../../analytics/source-grant-store.js';
import { readAuthorizedUsageExport } from '../../../analytics/usage-export-reader.js';
import { readAuthorizedUsageInvalidations } from '../../../analytics/usage-invalidation-reader.js';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createRecipientCandidateRoutes } from '../recipient-candidates.js';
import { createSourceEnrollmentRoutes } from '../source-enrollments.js';
import { createSourceGrantApprovalRoutes } from '../source-grant-approvals.js';
import { createSourceGrantExportRoutes } from '../source-grant-export.js';

const temporary = trackTempDirs();

function snapshotHome(homeDir: string, mode: 'normal' | 'update') {
  const backupDir = join(temporary('activation-snapshot-'), 'backup');
  const backup =
    mode === 'normal'
      ? createStationHomeBackup({ homeDir, outputDir: backupDir })
      : createStationHomeUpdateBackup({ homeDir, backupDir });
  return () => {
    if (mode === 'normal') {
      restoreStationHomeBackup({
        homeDir,
        backupDir: backup.backupDir,
        confirm: true,
      });
    } else {
      restoreStationHomeUpdateBackup({ homeDir, backupDir: backup.backupDir });
    }
  };
}

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const sourceId = '01234567-89ab-4cde-8fab-0123456789ab';
const recipientId = '11234567-89ab-4cde-8fab-0123456789ab';
const approvalId = '21234567-89ab-4cde-8fab-0123456789ab';
const sourceBase = '/api/analytics/source-grant-approvals';
const recipientBase = '/api/analytics/recipient-candidates';
const now = Date.parse('2026-10-24T00:00:00.000Z');
const defaults = { sourceId, recipientId, approvalId, now };
async function fixture(
  options: {
    sourceStationId?: string;
    sourceOrigin?: string;
    sources?: Map<string, Hono>;
    sourceId?: string;
    recipientId?: string;
    approvalId?: string;
    now?: number;
    receivingHome?: string;
    target?: (assertPerson: () => Promise<void>) => PrivateUsageTarget;
  } = {},
) {
  const sourceName = options.sourceStationId ?? 'source-station';
  const sourceOrigin = options.sourceOrigin ?? 'https://source.example.test';
  const sourceId = options.sourceId ?? defaults.sourceId,
    recipientId = options.recipientId ?? defaults.recipientId,
    approvalId = options.approvalId ?? defaults.approvalId;
  let now = options.now ?? defaults.now;

  const sourceHome = join(temporary('credential-source-'), 'home'),
    receivingHome =
      options.receivingHome ?? join(temporary('credential-receiver-'), 'home');
  ensureStationHomeSchemaSync(sourceHome);
  ensureStationHomeSchemaSync(receivingHome);
  let sourceTenant = 'tenant-a';
  let sourceIdentity = sourceName;
  let wireMode: 'normal' | 'oversized' | 'content' | 'head-unsupported' =
    'normal';
  let canceledBodies = 0;
  const networkRequests: Array<{ path: string; authenticated: boolean }> = [];
  let exportOwnerCheck = async () => {};
  let receivingUser = 'human:tailscale:alice',
    receivingTenant = 'tenant-a',
    approvalCurrent = true;
  const actor = (stationId: string): SourceApprovalActor => {
    const activation = captureAnalyticsHomeActivation(
      stationId === sourceName ? sourceHome : receivingHome,
    );
    const userId =
      stationId === sourceName ? 'human:tailscale:alice' : receivingUser;
    const tenantId = stationId === sourceName ? 'tenant-a' : receivingTenant;
    return {
      sourceStationId: stationId,
      userId,
      mode: 'hosted',
      tenantId,
      ownerIds: [userId],
      approvalCredentialId: 'approved-device',
      approvalBindingSha256: 'a'.repeat(64),
      async assertCurrent() {
        try {
          activation.assertCurrent();
        } catch {
          throw new AuthorityObservationRejected(403, 'authority_changed');
        }
        if (
          stationId !== sourceName &&
          (receivingUser !== userId || receivingTenant !== tenantId)
        )
          throw new AuthorityObservationRejected(403, 'authority_changed');
      },
      async assertApprovalCurrent() {
        await this.assertCurrent();
        if (!approvalCurrent)
          throw new AuthorityObservationRejected(403, 'authority_changed');
      },
    };
  };
  const sourceActor = actor(sourceName);
  const enrollments = new SourceEnrollmentStore(sourceHome, () => now);
  const intent = await enrollments.prepare(sourceActor, {
    operationId: sourceId,
    proposedDestination: {
      stationId: 'receiving-station',
      origin: 'https://receiving.example.test',
    },
    scope: 'individual',
    expiresAt: new Date(now + 86400000).toISOString(),
    retention: { mode: 'live-mirror' },
  });
  const recipients = new RecipientStore(
    receivingHome,
    () => now,
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!options.sources) expect(url.origin).toBe(sourceOrigin);
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      const authenticated = new Headers(init?.headers).has('authorization');
      networkRequests.push({ path: url.pathname, authenticated });
      if (url.pathname === '/.well-known/station/v1')
        expect(authenticated).toBe(false);
      const remote = options.sources ? options.sources.get(url.origin) : source;
      if (!remote) throw new Error('Unknown source origin');
      let response = await remote.request(url.href, init);
      if (
        wireMode === 'head-unsupported' &&
        init?.method === 'HEAD' &&
        response.status === 204
      )
        response = new Response(null, {
          status: 200,
          headers: response.headers,
        });
      if (
        url.pathname.includes('/source-grant-export/') &&
        init?.method !== 'HEAD' &&
        response.ok
      ) {
        if (wireMode === 'oversized') {
          await response.body?.cancel();
          const headers = response.headers;
          response = new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              },
              cancel() {
                canceledBodies++;
              },
            }),
            { headers },
          );
        } else if (wireMode === 'content') {
          const body = z
            .object({
              data: z
                .object({
                  observations: z.array(
                    z
                      .object({ receipts: z.array(z.record(z.unknown())) })
                      .passthrough(),
                  ),
                })
                .passthrough(),
            })
            .passthrough()
            .parse(await response.json());
          const receipt = body.data.observations[0]?.receipts[0];
          if (!receipt) throw new Error('Missing source fixture receipt');
          receipt.prompt =
            'content must not cross the canonical summary boundary';
          response = Response.json(body, { headers: response.headers });
        }
      }
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    },
  );
  const recipient = await recipients.prepare(actor('receiving-station'), {
    operationId: recipientId,
    proposedSourceOrigin: sourceOrigin,
    sourceIntent: intent,
  });
  const channel = new ConsentChannelService({ now: () => now });
  channel.markListening(4321);
  const approvals = new SourceGrantApprovalStore(sourceHome, () => now);
  const source = new Hono().route(
    sourceBase,
    createSourceGrantApprovalRoutes({
      channel,
      enrollments,
      approvals,
      capture: async () => actor(sourceName),
      now: () => now,
    }),
  );
  source.route(
    '/api/analytics/source-enrollments',
    createSourceEnrollmentRoutes({
      store: enrollments,
      capture: async () => actor(sourceName),
    }),
  );
  source.get('/.well-known/station/v1', (c) =>
    c.json({
      schemaVersion: 1,
      environmentId: sourceIdentity,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
      compatibility: {
        serverVersion: 'test',
        protocolVersion: 1,
        minClientProtocol: 1,
      },
    }),
  );
  options.sources?.set(sourceOrigin, source);
  const facts = new EventStore(join(sourceHome, 'facts.sqlite'));
  stores.push(facts);
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [
      { id: 'tenant-a', authority: 'source-a.example.test' },
      { id: 'tenant-b', authority: 'source-b.example.test' },
    ],
  });
  source.route(
    '/api/analytics/source-grant-export',
    createSourceGrantExportRoutes({
      currentRevision: () => facts.usageExportRevision(),
      readInvalidations: (authority, request, authorizationContext) =>
        readAuthorizedUsageInvalidations({
          store: facts,
          authority,
          stationId: sourceName,
          request,
          authorizationContext,
          personalOwnerIds: () => undefined,
        }),
      authorize: (_request, id, credential, proof) =>
        approvals.authorizeExport(
          sourceName,
          id,
          credential,
          proof,
          async (owner) => {
            if (!approvalCurrent || owner.tenantId !== sourceTenant)
              throw new AuthorityObservationRejected(403, 'authority_changed');
            await exportOwnerCheck();
            return sessionReadAuthorityFromRequest(
              owner.userId,
              { tenantId: tenantId(sourceTenant) },
              registry,
            );
          },
        ),
      read: (authority, query, authorizationContext) =>
        readAuthorizedUsageExport({
          store: facts,
          authority,
          stationId: sourceName,
          request: query,
          personalOwnerIds: () => undefined,
          authorizationContext,
        }),
    }),
  );
  const receivingChannel = new ConsentChannelService({ now: () => now });
  receivingChannel.markListening(4323);
  const receiving = new Hono().route(
    recipientBase,
    createRecipientCandidateRoutes({
      channel: receivingChannel,
      store: recipients,
      ...(options.target
        ? {
            captureSyncTarget: async (
              _request: Request,
              assertPerson: () => Promise<void>,
            ) => {
              await assertPerson();
              const target = options.target;
              if (!target) throw new Error('Missing sync target');
              return target(assertPerson);
            },
          }
        : {}),
      capture: async () => actor('receiving-station'),
    }),
  );
  const consent = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: () => false,
      identifyDevice: () => null,
      resolveGrantedScope: () => undefined,
    },
  });
  const receivingConsent = createConsentApp({
    channel: receivingChannel,
    credentials: {
      verifyOperatorCredential: (value) => value === 'fixture-operator',
      identifyDevice: () => null,
      resolveGrantedScope: () => undefined,
    },
  });
  const completeReview = async (request: Response, consent: Hono) => {
    expect(request.status).toBe(200);
    const result = z
      .object({ approval: z.object({ reviewUrl: z.string() }) })
      .parse(await request.json());
    const cookie = request.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Missing requester session');
    const reviewUrl = new URL(result.approval.reviewUrl);
    const headers = {
      host: reviewUrl.host,
      cookie,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    expect(
      (
        await consent.request(reviewUrl.href, {
          headers: { ...headers, cookie: 'station-device=fixture-operator' },
        })
      ).status,
    ).toBe(403);
    const review = await consent.request(reviewUrl.href, { headers });
    expect(review.status).toBe(200);
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];
    if (!nonce) throw new Error('Missing review nonce');
    reviewUrl.pathname += '/decide';
    expect(
      (
        await consent.request(reviewUrl.href, {
          method: 'POST',
          headers: {
            ...headers,
            cookie: 'station-device=fixture-operator',
            origin: reviewUrl.origin,
            'sec-fetch-site': 'same-origin',
            'sec-fetch-user': '?1',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ decision: 'approve', nonce }),
        })
      ).status,
    ).toBe(403);
    const decision = await consent.request(reviewUrl.href, {
      method: 'POST',
      headers: {
        ...headers,
        origin: reviewUrl.origin,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ decision: 'approve', nonce }),
    });
    expect(decision.status).toBe(200);
  };
  const approve = async () => {
    const request = await source.request(sourceBase, {
      method: 'POST',
      headers: { host: '127.0.0.1:4320' },
      body: JSON.stringify({
        operationId: approvalId,
        sourceOperationId: sourceId,
        recipientCandidate: recipient.candidate,
      }),
    });
    await completeReview(request, consent);
  };
  const delivery = () =>
    source.request(`${sourceBase}/${approvalId}/delivery`, { method: 'POST' });
  const materialize = (value: unknown) =>
    receiving.request(`${recipientBase}/${recipientId}/credentials`, {
      method: 'POST',
      body: JSON.stringify(value),
    });
  return {
    completeSourceReview: (response: Response) =>
      completeReview(response, consent),
    completeAddressReview: (response: Response) =>
      completeReview(response, receivingConsent),
    sourceHome,
    receivingHome,
    receivingActor: () => actor('receiving-station'),
    facts,
    advanceClock: (duration: number) => {
      now += duration;
    },
    expireOutboxes: () =>
      recipients.expireSyncOutboxes('receiving-station', async () => {}),
    syncRecipient: (id: string, value: unknown) =>
      receiving.request(`${recipientBase}/${id}/sync`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    sync: (value: unknown) =>
      receiving.request(`${recipientBase}/${recipientId}/sync`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    syncStatus: () => receiving.request(`${recipientBase}/${recipientId}`),
    query: (value: unknown) =>
      receiving.request(`${recipientBase}/${recipientId}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    privateExportHeaders: async () => {
      const file = z
        .object({
          records: z.array(
            z.object({
              sourceCredential: z.object({
                payload: z.object({ credential: z.string() }),
                proof: sourceDeliveryProofSchema,
              }),
            }),
          ),
        })
        .parse(
          JSON.parse(
            await readFile(
              join(receivingHome, 'security/analytics-recipients.json'),
              'utf8',
            ),
          ),
        );
      const stored = file.records[0]?.sourceCredential;
      if (!stored) throw new Error('Missing receiving fixture credential');
      return {
        authorization: `Bearer ${stored.payload.credential}`,
        'x-station-analytics-proof': Buffer.from(
          JSON.stringify(stored.proof),
        ).toString('base64url'),
      };
    },
    networkRequests,
    wireMode(value: 'normal' | 'oversized' | 'content' | 'head-unsupported') {
      wireMode = value;
    },
    canceledBodies: () => canceledBodies,
    sourceIdentity(value: string) {
      sourceIdentity = value;
    },
    confirmSource: async () =>
      completeReview(
        await receiving.request(
          `${recipientBase}/${recipientId}/source-confirmation`,
          {
            method: 'POST',
            headers: { host: '127.0.0.1:4322' },
            body: '{}',
          },
        ),
        receivingConsent,
      ),
    readSource: (query: unknown) =>
      receiving.request(`${recipientBase}/${recipientId}/read`, {
        method: 'POST',
        body: JSON.stringify(query),
      }),
    onExportOwnerCheck(check: () => Promise<void>) {
      exportOwnerCheck = check;
    },
    sourceTenant(value: string) {
      sourceTenant = value;
    },
    source,
    receiving,
    approve,
    delivery,
    materialize,
    sourceSignout() {
      approvalCurrent = false;
    },
    sourceSignin() {
      approvalCurrent = true;
    },
    receiverUser(value: string) {
      receivingUser = value;
    },
    receiverTenant(value: string) {
      receivingTenant = value;
    },
  };
}

test('approved source delivers ciphertext idempotently and only the receiving owner stores plaintext without releasing it', async () => {
  const h = await fixture();
  expect((await h.delivery()).status).toBe(404);
  await h.approve();
  h.sourceSignout();
  expect((await h.delivery()).status).toBe(403);
  h.sourceSignin();
  const first = await h.delivery();
  expect(first.status).toBe(200);
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await first.json()).data;
  expect(wire.exportAuthority).toBe(false);
  expect(wire.envelope.split('.')).toHaveLength(5);
  const again = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect(again.envelope).toBe(wire.envelope);
  h.receiverUser('human:tailscale:bob');
  expect((await h.materialize(wire)).status).toBe(404);
  h.receiverUser('human:tailscale:alice');
  h.receiverTenant('tenant-b');
  expect((await h.materialize(wire)).status).toBe(404);
  h.receiverTenant('tenant-a');
  expect(
    (
      await h.materialize({
        ...wire,
        sourceApprovalId: '31234567-89ab-4cde-8fab-0123456789ab',
      })
    ).status,
  ).toBe(400);
  const stored = await h.materialize(wire);
  expect(stored.status).toBe(200);
  const receipt: unknown = await stored.json();
  expect(receipt).toMatchObject({
    data: {
      sourceApprovalId: approvalId,
      credentialStored: true,
      sourceVerified: false,
      exportAuthority: false,
      revision: 1,
    },
  });
  expect(await (await h.materialize(wire)).json()).toEqual(receipt);
  const receiver = z
    .object({
      records: z.array(
        z.object({
          sourceCredential: z.object({
            payload: z.object({ credential: z.string() }),
          }),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(h.receivingHome, 'security/analytics-recipients.json'),
          'utf8',
        ),
      ),
    );
  const credential = receiver.records[0]?.sourceCredential.payload.credential;
  if (!credential) throw new Error('Credential was not privately stored');
  expect(credential).toMatch(/^stax_[A-Za-z0-9_-]{43}$/);
  const sourceBytes = await readFile(
    join(h.sourceHome, 'security/analytics-source-approvals.json'),
    'utf8',
  );
  expect(sourceBytes).toContain(sourceCredentialHash(credential));
  expect(sourceBytes).not.toContain(credential);
  expect(JSON.stringify(wire)).not.toContain(credential);
  expect(JSON.stringify(receipt)).not.toContain(credential);
  expect(
    await (await h.receiving.request(`${recipientBase}/${recipientId}`)).json(),
  ).toMatchObject({
    data: {
      phase: 'credential-stored',
      storedCredential: { credentialStored: true, exportAuthority: false },
    },
  });
  expect(
    (
      await h.source.request(`${sourceBase}/${approvalId}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  expect((await h.delivery()).status).toBe(409);
});

test('a cancelled receiving slot refuses delivery even after source approval', async () => {
  const h = await fixture();
  await h.approve();
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect(
    (
      await h.receiving.request(`${recipientBase}/${recipientId}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  expect((await h.materialize(wire)).status).toBe(409);
});

test('narrow export selects canonical owner/tenant facts and fences proof, scope and queued revocation', async () => {
  const h = await fixture();
  const day = new Date().toISOString().slice(0, 10);
  for (const [thread, owner, tenant] of [
    ['own', 'human:tailscale:alice', 'tenant-a'],
    ['other', 'human:tailscale:bob', 'tenant-a'],
    ['foreign', 'human:tailscale:alice', 'tenant-b'],
  ]) {
    const time = new Date().toISOString();
    h.facts.upsertSession({
      threadId: thread,
      provider: 'claude',
      status: 'ready',
      createdAt: time,
      updatedAt: time,
      tenantExecutionContext: { tenantId: tenantId(tenant), source: 'session' },
    });
    h.facts.appendEvent({
      eventId: `${thread}:start`,
      threadId: thread,
      provider: 'claude',
      method: 'session.started',
      sessionId: thread,
      createdAt: time,
      metadata: { userId: owner },
    });
    h.facts.appendEvent({
      eventId: `${thread}:usage`,
      threadId: thread,
      provider: 'claude',
      method: 'token-usage.updated',
      createdAt: time,
      promptTokens: 7,
    });
  }
  await h.approve();
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  const stored = z
    .object({ data: z.object({ deliveryProof: sourceDeliveryProofSchema }) })
    .parse(await (await h.materialize(wire)).json()).data;
  const privateFile = z
    .object({
      records: z.array(
        z.object({
          sourceCredential: z.object({
            payload: z.object({ credential: z.string() }),
          }),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(h.receivingHome, 'security/analytics-recipients.json'),
          'utf8',
        ),
      ),
    );
  const credential =
    privateFile.records[0]?.sourceCredential.payload.credential;
  if (!credential) throw new Error('Missing private credential');
  const path = `/api/analytics/source-grant-export/${approvalId}?from=${day}&to=${day}`;
  let headers = {
    authorization: `Bearer ${credential}`,
    'x-station-analytics-proof': Buffer.from(
      JSON.stringify(stored.deliveryProof),
    ).toString('base64url'),
  };
  expect((await h.source.request(path)).status).toBe(403);
  const response = await h.source.request(path, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      stationId: 'source-station',
      scope: 'individual',
      observations: [
        {
          receipts: [
            expect.objectContaining({ threadId: 'own', inputTokens: 7 }),
          ],
        },
      ],
    },
  });
  for (let index = 0; index < 505; index++) {
    h.facts.appendEvent({
      eventId: `own:page:${index}`,
      threadId: 'own',
      provider: 'claude',
      method: 'token-usage.updated',
      createdAt: new Date().toISOString(),
      promptTokens: index + 8,
    });
  }
  const pageSchema = z.object({
    data: z.object({
      streamEpoch: z.string(),
      highWater: z.number(),
      observations: z.array(z.object({ globalSequence: z.number() })),
      nextCursor: z.string().optional(),
    }),
  });
  const sequences: number[] = [];
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  let snapshot: { streamEpoch: string; highWater: number } | undefined;
  do {
    const pageResponse = await h.source.request(
      `${path}&pageSize=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers },
    );
    expect(pageResponse.status).toBe(200);
    const { data } = pageSchema.parse(await pageResponse.json());
    snapshot ??= { streamEpoch: data.streamEpoch, highWater: data.highWater };
    expect(data).toMatchObject(snapshot);
    sequences.push(...data.observations.map((item) => item.globalSequence));
    cursor = data.nextCursor;
    if (cursor && sequences.length === 100) {
      firstCursor = cursor;
      const authority = sessionReadAuthorityFromRequest(
        'human:tailscale:alice',
        { tenantId: tenantId('tenant-a') },
        parseHostedTenantRegistry({
          schemaVersion: 1,
          tenants: [{ id: 'tenant-a', authority: 'source-a.example.test' }],
        }),
      );
      expect(() =>
        readAuthorizedUsageExport({
          store: h.facts,
          authority,
          stationId: 'source-station',
          request: { from: day, to: day, scope: 'individual', cursor },
          personalOwnerIds: () => undefined,
        }),
      ).toThrow('usage_export_authority_changed');
    }
    if (sequences.length > 506)
      throw new Error('Export paging repeated observations');
  } while (cursor);
  expect(sequences).toHaveLength(506);
  expect(new Set(sequences).size).toBe(506);
  const bad = {
    ...stored.deliveryProof,
    claims: { ...stored.deliveryProof.claims, revision: 2 },
  };
  expect(
    (
      await h.source.request(path, {
        headers: {
          ...headers,
          'x-station-analytics-proof': Buffer.from(
            JSON.stringify(bad),
          ).toString('base64url'),
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (await h.source.request(`${path}&userId=human:tailscale:bob`, { headers }))
      .status,
  ).toBe(400);
  h.sourceTenant('tenant-b');
  expect((await h.source.request(path, { headers })).status).toBe(403);
  h.sourceTenant('tenant-a');
  const oldQueued = await h.source.request(path, { headers });
  const rotation = {
    rotationId: '31234567-89ab-4cde-8fab-0123456789ab',
    expectedRevision: 1,
  };
  const rotate = (input: typeof rotation) =>
    h.source.request(`${sourceBase}/${approvalId}/rotate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  h.sourceSignout();
  expect((await rotate(rotation)).status).toBe(403);
  h.sourceSignin();
  const rotatedResponse = await rotate(rotation);
  expect(rotatedResponse.status).toBe(200);
  const rotated = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await rotatedResponse.json()).data;
  expect(rotated.revision).toBe(2);
  expect(rotated.envelope === wire.envelope).toBe(false);
  const replay = await rotate(rotation);
  expect(replay.status).toBe(200);
  expect(
    z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await replay.json()).data,
  ).toEqual(rotated);
  expect(
    (
      await rotate({
        ...rotation,
        rotationId: '41234567-89ab-4cde-8fab-0123456789ab',
      })
    ).status,
  ).toBe(409);
  await expect(oldQueued.text()).rejects.toThrow('Authority observation ended');
  expect((await h.source.request(path, { headers })).status).toBe(403);
  const rotatedStoredResponse = await h.materialize(rotated);
  expect(rotatedStoredResponse.status).toBe(200);
  const rotatedStored = z
    .object({ data: z.object({ deliveryProof: sourceDeliveryProofSchema }) })
    .parse(await rotatedStoredResponse.json()).data;
  expect((await h.materialize(wire)).status).toBe(409);
  const currentPrivate = z
    .object({
      records: z.array(
        z.object({
          sourceCredential: z.object({
            payload: z.object({ credential: z.string() }),
          }),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(h.receivingHome, 'security/analytics-recipients.json'),
          'utf8',
        ),
      ),
    );
  const currentCredential =
    currentPrivate.records[0]?.sourceCredential.payload.credential;
  if (!currentCredential) throw new Error('Missing rotated credential');
  const oldProof = headers['x-station-analytics-proof'];
  headers = {
    authorization: `Bearer ${currentCredential}`,
    'x-station-analytics-proof': Buffer.from(
      JSON.stringify(rotatedStored.deliveryProof),
    ).toString('base64url'),
  };
  expect(
    (
      await h.source.request(path, {
        headers: { ...headers, 'x-station-analytics-proof': oldProof },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.source.request(
        `${path}&cursor=${encodeURIComponent(firstCursor ?? '')}`,
        { headers },
      )
    ).status,
  ).toBe(403);
  await h.confirmSource();
  const receivedSequences = new Set<number>();
  let receivingCursor: string | undefined;
  let receivingSnapshot:
    | { streamEpoch: string; highWater: number; afterGlobalSequence: number }
    | undefined;
  do {
    const received = await h.readSource({
      from: day,
      to: day,
      pageSize: 100,
      ...(receivingCursor
        ? { cursor: receivingCursor, snapshot: receivingSnapshot }
        : {}),
    });
    expect(received.status).toBe(200);
    const page = pageSchema.parse(await received.json()).data;
    for (const item of page.observations) {
      expect(receivedSequences.has(item.globalSequence)).toBe(false);
      receivedSequences.add(item.globalSequence);
    }
    receivingCursor = page.nextCursor;
    const last = page.observations.at(-1);
    if (last)
      receivingSnapshot = {
        streamEpoch: page.streamEpoch,
        highWater: page.highWater,
        afterGlobalSequence: last.globalSequence,
      };
    if (receivedSequences.size > 506)
      throw new Error(
        'Receiving pagination repeated or widened source observations',
      );
  } while (receivingCursor);
  expect([...receivedSequences]).toEqual(sequences);
  const held = await h.source.request(path, { headers });
  expect(held.status).toBe(200);
  let signalEntered = () => {};
  let finishCheck = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const continueCheck = new Promise<void>((resolve) => {
    finishCheck = resolve;
  });
  h.onExportOwnerCheck(async () => {
    signalEntered();
    await continueCheck;
  });
  const pendingBody = held.text();
  const refusedBody = expect(pendingBody).rejects.toThrow(
    'Authority observation ended',
  );
  await entered;
  expect(
    (
      await h.source.request(`${sourceBase}/${approvalId}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  finishCheck();
  await refusedBody;
  h.onExportOwnerCheck(async () => {});
  expect((await h.source.request(path, { headers })).status).toBe(403);
});

test('receiving person confirms the HTTPS source before scoped fetch and queued reads recheck remote revocation', async () => {
  const h = await fixture();
  const time = new Date().toISOString();
  const day = time.slice(0, 10);
  h.facts.upsertSession({
    threadId: 'receiving-read',
    provider: 'claude',
    status: 'ready',
    createdAt: time,
    updatedAt: time,
    tenantExecutionContext: {
      tenantId: tenantId('tenant-a'),
      source: 'session',
    },
  });
  h.facts.appendEvent({
    eventId: 'receiving-read:start',
    threadId: 'receiving-read',
    sessionId: 'receiving-read',
    provider: 'claude',
    method: 'session.started',
    createdAt: time,
    metadata: { userId: 'human:tailscale:alice' },
  });
  h.facts.appendEvent({
    eventId: 'receiving-read:usage',
    threadId: 'receiving-read',
    provider: 'claude',
    method: 'token-usage.updated',
    createdAt: time,
    promptTokens: 19,
  });
  await h.approve();
  const delivery = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect((await h.materialize(delivery)).status).toBe(200);
  const query = { from: day, to: day };
  expect((await h.readSource(query)).status).toBe(403);
  expect(h.networkRequests).toHaveLength(0);
  await h.confirmSource();
  h.sourceIdentity('foreign-station');
  expect((await h.readSource(query)).status).toBe(503);
  expect(h.networkRequests.some((request) => request.authenticated)).toBe(
    false,
  );
  h.sourceIdentity('source-station');
  h.receiverUser('human:tailscale:bob');
  const beforeForeign = h.networkRequests.length;
  expect((await h.readSource(query)).status).toBe(404);
  expect(h.networkRequests).toHaveLength(beforeForeign);
  h.receiverUser('human:tailscale:alice');
  const beforeSpoof = h.networkRequests.length;
  expect(
    (await h.readSource({ ...query, userId: 'human:tailscale:bob' })).status,
  ).toBe(400);
  expect(h.networkRequests).toHaveLength(beforeSpoof);
  h.wireMode('oversized');
  expect((await h.readSource(query)).status).toBe(503);
  expect(h.canceledBodies()).toBe(1);
  h.wireMode('content');
  expect((await h.readSource(query)).status).toBe(503);
  h.wireMode('head-unsupported');
  expect((await h.readSource(query)).status).toBe(503);
  h.wireMode('normal');
  const selected = await h.readSource(query);
  expect(selected.status).toBe(200);
  const text = await selected.text();
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toContain('"credential"');
  expect(JSON.parse(text)).toMatchObject({
    data: {
      stationId: 'source-station',
      observations: [
        {
          receipts: [
            expect.objectContaining({
              threadId: 'receiving-read',
              inputTokens: 19,
            }),
          ],
        },
      ],
    },
  });
  expect(
    h.networkRequests
      .filter((request) => request.authenticated)
      .every(
        (request) =>
          request.path === `/api/analytics/source-grant-export/${approvalId}`,
      ),
  ).toBe(true);
  const beforeDeletion = await h.readSource(query);
  expect(beforeDeletion.status).toBe(200);
  h.facts.deleteThread('receiving-read');
  await expect(beforeDeletion.text()).rejects.toThrow(
    'Authority observation ended',
  );
  const afterDeletion = await h.readSource(query);
  expect(afterDeletion.status).toBe(200);
  expect(await afterDeletion.json()).toMatchObject({
    data: { observations: [] },
  });
  const beforeRotation = await h.readSource(query);
  expect(beforeRotation.status).toBe(200);
  const rotation = await h.source.request(
    `${sourceBase}/${approvalId}/rotate`,
    {
      method: 'POST',
      body: JSON.stringify({
        rotationId: '51234567-89ab-4cde-8fab-0123456789ab',
        expectedRevision: 1,
      }),
    },
  );
  expect(rotation.status).toBe(200);
  const rotated = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await rotation.json()).data;
  await expect(beforeRotation.text()).rejects.toThrow(
    'Authority observation ended',
  );
  expect((await h.materialize(rotated)).status).toBe(200);
  const beforeUnconfirmed = h.networkRequests.length;
  expect((await h.readSource(query)).status).toBe(403);
  expect(h.networkRequests).toHaveLength(beforeUnconfirmed);
  await h.confirmSource();
  const held = await h.readSource(query);
  expect(held.status).toBe(200);
  expect(
    (
      await h.source.request(`${sourceBase}/${approvalId}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  await expect(held.text()).rejects.toThrow('Authority observation ended');
  expect((await h.readSource(query)).status).toBe(403);
});

test('grant-scoped invalidation replay keeps a fixed head, reports retained gaps and fences rotation and queued revocation', async () => {
  const h = await fixture();
  const seed = (threadId: string, owner: string, tenant: string) => {
    const time = new Date().toISOString();
    h.facts.upsertSession({
      threadId,
      provider: 'claude',
      status: 'ready',
      createdAt: time,
      updatedAt: time,
      tenantExecutionContext: { tenantId: tenantId(tenant), source: 'session' },
    });
    h.facts.appendEvent({
      eventId: `${threadId}:start`,
      threadId,
      sessionId: threadId,
      provider: 'claude',
      method: 'session.started',
      createdAt: time,
      metadata: { userId: owner },
    });
    h.facts.appendEvent({
      eventId: `${threadId}:usage`,
      threadId,
      provider: 'claude',
      method: 'token-usage.updated',
      createdAt: time,
      promptTokens: 1,
    });
  };
  for (const [thread, owner, tenant] of [
    ['first-own', 'human:tailscale:alice', 'tenant-a'],
    ['other-person', 'human:tailscale:bob', 'tenant-a'],
    ['foreign-tenant', 'human:tailscale:alice', 'tenant-b'],
    ['second-own', 'human:tailscale:alice', 'tenant-a'],
  ])
    seed(thread, owner, tenant);
  await h.approve();
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect((await h.materialize(wire)).status).toBe(200);
  let headers = await h.privateExportHeaders();
  for (const id of [
    'first-own',
    'other-person',
    'foreign-tenant',
    'second-own',
  ])
    h.facts.deleteThread(id);
  const base = `/api/analytics/source-grant-export/${approvalId}?mode=invalidations`;
  expect((await h.source.request(base)).status).toBe(403);
  const page = z.object({
    data: z.object({
      protocol: z.literal('station-usage-invalidations/v1'),
      streamEpoch: z.string(),
      highWater: z.number(),
      nextAfter: z.number(),
      invalidations: z.array(
        z.object({
          revision: z.number(),
          threadId: z.string(),
          reason: z.string(),
        }),
      ),
      nextCursor: z.string().optional(),
    }),
  });
  const firstResponse = await h.source.request(`${base}&after=0&pageSize=1`, {
    headers,
  });
  expect(firstResponse.status).toBe(200);
  const first = page.parse(await firstResponse.json()).data;
  expect(first).toMatchObject({
    highWater: 4,
    nextAfter: 1,
    invalidations: [
      { revision: 1, threadId: 'first-own', reason: 'thread-deleted' },
    ],
  });
  expect(first.nextCursor).toBeDefined();
  seed('later-own', 'human:tailscale:alice', 'tenant-a');
  h.facts.deleteThread('later-own');
  const secondResponse = await h.source.request(
    `${base}&cursor=${first.nextCursor}`,
    { headers },
  );
  expect(secondResponse.status).toBe(200);
  const second = page.parse(await secondResponse.json()).data;
  expect(second).toMatchObject({
    highWater: 4,
    nextAfter: 4,
    invalidations: [{ revision: 4, threadId: 'second-own' }],
  });
  expect(second.nextCursor).toBeUndefined();
  const next = await h.source.request(
    `${base}&after=4&streamEpoch=${first.streamEpoch}`,
    { headers },
  );
  expect(next.status).toBe(200);
  expect(page.parse(await next.json()).data).toMatchObject({
    highWater: 5,
    nextAfter: 5,
    invalidations: [{ threadId: 'later-own' }],
  });
  expect((await h.source.request(`${base}&after=4`, { headers })).status).toBe(
    400,
  );
  expect(
    (await h.source.request(`${base}&after=4&streamEpoch=foreign`, { headers }))
      .status,
  ).toBe(403);
  expect(
    (await h.source.request(`${base}&userId=human:tailscale:bob`, { headers }))
      .status,
  ).toBe(400);
  const rotation = await h.source.request(
    `${sourceBase}/${approvalId}/rotate`,
    {
      method: 'POST',
      body: JSON.stringify({
        rotationId: '61234567-89ab-4cde-8fab-0123456789ab',
        expectedRevision: 1,
      }),
    },
  );
  expect(rotation.status).toBe(200);
  const rotated = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await rotation.json()).data;
  expect((await h.materialize(rotated)).status).toBe(200);
  headers = await h.privateExportHeaders();
  expect(
    (await h.source.request(`${base}&cursor=${first.nextCursor}`, { headers }))
      .status,
  ).toBe(403);
  const beforePruning = page.parse(
    await (await h.source.request(`${base}&pageSize=1`, { headers })).json(),
  ).data;
  const db = new DatabaseSync(join(h.sourceHome, 'facts.sqlite'));
  try {
    db.exec(`BEGIN;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10005)
      INSERT INTO orchestration_conversation_history(thread_id,owner_user_id,tenant_id,created_at,updated_at)
      SELECT 'feed-gap-'||i,'human:tailscale:alice','tenant-a','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z' FROM n;
      DELETE FROM orchestration_conversation_history WHERE thread_id LIKE 'feed-gap-%'; COMMIT;`);
  } finally {
    db.close();
  }
  expect((await h.source.request(`${base}&after=0`, { headers })).status).toBe(
    410,
  );
  expect(
    (
      await h.source.request(`${base}&cursor=${beforePruning.nextCursor}`, {
        headers,
      })
    ).status,
  ).toBe(410);
  const current = h.facts.usageExportRevision();
  const held = await h.source.request(
    `${base}&after=${current}&streamEpoch=${first.streamEpoch}`,
    { headers },
  );
  expect(held.status).toBe(200);
  expect(
    (
      await h.source.request(`${sourceBase}/${approvalId}`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(200);
  await expect(held.text()).rejects.toThrow('Authority observation ended');
  expect((await h.source.request(base, { headers })).status).toBe(403);
});

test('Core sync materializes more than 500 real canonical observations from each of two explicit sources', async () => {
  const storage = await privateUsageFixture();
  try {
    const sourceApps = new Map<string, Hono>();
    const h = await fixture({
      sourceStationId: 'source-a',
      sourceOrigin: 'https://source-a.example.test',
      sources: sourceApps,
      now: Date.now(),
      target: storage.target,
    });
    const sources = [
      h,
      await fixture({
        sourceStationId: 'source-b',
        sourceOrigin: 'https://source-b.example.test',
        sources: sourceApps,
        now: Date.now(),
        sourceId: '31234567-89ab-4cde-8fab-0123456789ab',
        recipientId: '41234567-89ab-4cde-8fab-0123456789ab',
        approvalId: '51234567-89ab-4cde-8fab-0123456789ab',
        receivingHome: h.receivingHome,
        target: storage.target,
      }),
    ];
    let inserted = 0;
    for (const [sourceIndex, source] of sources.entries()) {
      const slot =
        sourceIndex === 0
          ? recipientId
          : '41234567-89ab-4cde-8fab-0123456789ab';
      storage.operatorAllowed(true);
      const time = new Date().toISOString(),
        day = time.slice(0, 10),
        threadId = 'colliding-thread';
      source.facts.upsertSession({
        threadId,
        provider: 'claude',
        status: 'ready',
        createdAt: time,
        updatedAt: time,
        tenantExecutionContext: {
          tenantId: tenantId('tenant-a'),
          source: 'session',
        },
      });
      source.facts.appendEvent({
        eventId: 'same-start',
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: time,
        metadata: { userId: 'human:tailscale:alice' },
      });
      for (let i = 0; i < 503; i++)
        source.facts.appendEvent({
          eventId: `same-usage-${i}`,
          threadId,
          provider: 'claude',
          method: 'token-usage.updated',
          createdAt: time,
          promptTokens: i + 1,
        });
      await source.approve();
      const wire = z
        .object({ data: sourceCredentialDeliverySchema })
        .parse(await (await source.delivery()).json()).data;
      expect((await source.materialize(wire)).status).toBe(200);
      await source.confirmSource();
      for (let page = 0; page < 6; page++) {
        const operationId = crypto.randomUUID();
        const response = await h.syncRecipient(slot, {
          operationId,
          from: day,
          to: day,
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const text = await response.text();
        expect(text).not.toContain('stai_');
        expect(text).not.toContain('stax_');
        expect(text).not.toContain('PRIVATE KEY');
        const result = z
          .object({
            data: z.object({
              phase: z.string(),
              inserted: z.number(),
              sourceAuthority: z.literal('not-established-by-status'),
            }),
          })
          .parse(JSON.parse(text)).data;
        inserted += result.inserted;
        expect(result.phase).toBe(
          page === 5 ? 'facts-captured' : 'page-stored',
        );
        storage.operatorAllowed(false);
        if (page === 0) {
          const replay = await h.syncRecipient(slot, {
            operationId,
            from: day,
            to: day,
          });
          expect(replay.status).toBe(200);
          expect(await replay.json()).toMatchObject({
            data: { operationId, inserted: 100 },
          });
        }
      }
      const status = await source.syncStatus();
      expect(status.status).toBe(200);
      const text = await status.text();
      expect(text).not.toContain('stai_');
      expect(text).not.toContain('stax_');
      expect(text).not.toContain('pending');
    }
    expect(inserted).toBe(1006);
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
        )
      ).rows[0].count,
    ).toBe('1006');
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.vaults',
        )
      ).rows[0].count,
    ).toBe('2');
  } finally {
    await storage.close();
  }
});

test('Core retains an uncertain write intent and recovers its original receipt without another source read or store commit', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    await h.approve();
    const wire = z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await (await h.delivery()).json()).data;
    expect((await h.materialize(wire)).status).toBe(200);
    await h.confirmSource();
    const day = new Date().toISOString().slice(0, 10),
      operationId = crypto.randomUUID();
    storage.dropNextReply();
    expect((await h.sync({ operationId, from: day, to: day })).status).toBe(
      503,
    );
    expect(storage.commits()).toBe(1);
    const pending = await h.syncStatus();
    expect(await pending.json()).toMatchObject({
      data: { sync: { phase: 'pending', operationId } },
    });
    const reads = h.networkRequests.length;
    storage.operatorAllowed(false);
    const recovered = await h.sync({ operationId, from: day, to: day });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      data: { phase: 'facts-captured', operationId },
    });
    expect(storage.commits()).toBe(1);
    expect(h.networkRequests).toHaveLength(reads);
    const other = crypto.randomUUID();
    expect(
      (await h.sync({ operationId: other, from: day, to: day })).status,
    ).toBe(200);
    expect((await h.sync({ operationId, from: day, to: day })).status).toBe(
      409,
    );
  } finally {
    await storage.close();
  }
});

test('Core sync refuses foreign person/tenant, body identity spoofing and unapproved resource provisioning', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    await h.approve();
    const wire = z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await (await h.delivery()).json()).data;
    await h.materialize(wire);
    await h.confirmSource();
    const day = new Date().toISOString().slice(0, 10),
      input = { operationId: crypto.randomUUID(), from: day, to: day };
    h.receiverUser('human:tailscale:bob');
    expect((await h.sync(input)).status).toBe(404);
    h.receiverUser('human:tailscale:alice');
    h.receiverTenant('tenant-b');
    expect((await h.sync(input)).status).toBe(404);
    h.receiverTenant('tenant-a');
    expect(
      (await h.sync({ ...input, userId: 'human:tailscale:bob' })).status,
    ).toBe(400);
    storage.operatorAllowed(false);
    expect((await h.sync(input)).status).toBe(403);
    expect(h.networkRequests).toHaveLength(0);
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.vaults',
        )
      ).rows[0].count,
    ).toBe('0');
  } finally {
    await storage.close();
  }
});

test.each([
  'cancel',
  'source-revoke',
  'person-change',
  'resource-change',
] as const)(
  'Core final write gate refuses %s after staging, before private materialization',
  async (change) => {
    const storage = await privateUsageFixture();
    try {
      const h = await fixture({ now: Date.now(), target: storage.target });
      await h.approve();
      const wire = z
        .object({ data: sourceCredentialDeliverySchema })
        .parse(await (await h.delivery()).json()).data;
      await h.materialize(wire);
      await h.confirmSource();
      storage.beforeWrite(async () => {
        if (change === 'cancel')
          expect(
            (
              await h.receiving.request(`${recipientBase}/${recipientId}`, {
                method: 'DELETE',
              })
            ).status,
          ).toBe(200);
        if (change === 'source-revoke')
          expect(
            (
              await h.source.request(`${sourceBase}/${approvalId}`, {
                method: 'DELETE',
              })
            ).status,
          ).toBe(200);
        if (change === 'person-change') h.receiverUser('human:tailscale:bob');
        if (change === 'resource-change') storage.available(false);
      });
      const day = new Date().toISOString().slice(0, 10);
      const response = await h.sync({
        operationId: crypto.randomUUID(),
        from: day,
        to: day,
      });
      expect(storage.commits()).toBe(0);
      expect(response.status).toBe(change === 'resource-change' ? 503 : 403);
      expect(
        (
          await storage.db.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
          )
        ).rows[0].count,
      ).toBe('0');
      if (change === 'cancel') {
        const record = z
          .object({
            records: z.array(
              z.object({
                sync: z.object({
                  phase: z.string(),
                  pending: z.unknown().optional(),
                }),
              }),
            ),
          })
          .parse(
            JSON.parse(
              await readFile(
                join(h.receivingHome, 'security/analytics-recipients.json'),
                'utf8',
              ),
            ),
          ).records[0];
        expect(record?.sync.phase).toBe('cancelled');
        expect(record?.sync.pending).toBeUndefined();
      }
    } finally {
      await storage.close();
    }
  },
);

test('Core withdraws deleted source observations and automatically restarts the stale fact snapshot', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    const time = new Date().toISOString(),
      day = time.slice(0, 10);
    h.facts.upsertSession({
      threadId: 'restart-own',
      provider: 'claude',
      status: 'ready',
      createdAt: time,
      updatedAt: time,
      tenantExecutionContext: {
        tenantId: tenantId('tenant-a'),
        source: 'session',
      },
    });
    h.facts.appendEvent({
      eventId: 'restart-start',
      threadId: 'restart-own',
      sessionId: 'restart-own',
      provider: 'claude',
      method: 'session.started',
      createdAt: time,
      metadata: { userId: 'human:tailscale:alice' },
    });
    for (let i = 0; i < 101; i++)
      h.facts.appendEvent({
        eventId: `restart-${i}`,
        threadId: 'restart-own',
        provider: 'claude',
        method: 'token-usage.updated',
        createdAt: time,
        promptTokens: i,
      });
    await h.approve();
    const wire = z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await (await h.delivery()).json()).data;
    await h.materialize(wire);
    await h.confirmSource();
    expect(
      (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
        .status,
    ).toBe(200);
    h.facts.deleteThread('restart-own');
    expect(
      (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
        .status,
    ).toBe(200);
    const restarted = await h.sync({
      operationId: crypto.randomUUID(),
      from: day,
      to: day,
      restart: true,
    });
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toMatchObject({
      data: {
        phase: 'facts-captured',
        sourceAuthority: 'not-established-by-status',
        checkpoint: { sourceRevision: 1 },
      },
    });
    // Replay withdraws the old private copies before the replacement snapshot commits.
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
        )
      ).rows[0].count,
    ).toBe('0');
  } finally {
    await storage.close();
  }
});

test('expired uncertain outbox bodies are erased while content-free intent still recovers the historical commit', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target }),
      time = new Date().toISOString(),
      day = time.slice(0, 10),
      threadId = 'outbox-private-thread';
    h.facts.upsertSession({
      threadId,
      provider: 'claude',
      status: 'ready',
      createdAt: time,
      updatedAt: time,
      tenantExecutionContext: {
        tenantId: tenantId('tenant-a'),
        source: 'session',
      },
    });
    h.facts.appendEvent({
      eventId: 'outbox-start',
      threadId,
      sessionId: threadId,
      provider: 'claude',
      method: 'session.started',
      createdAt: time,
      metadata: { userId: 'human:tailscale:alice' },
    });
    h.facts.appendEvent({
      eventId: 'outbox-usage',
      threadId,
      provider: 'claude',
      method: 'token-usage.updated',
      createdAt: time,
      promptTokens: 9,
    });
    await h.approve();
    const wire = z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await (await h.delivery()).json()).data;
    await h.materialize(wire);
    await h.confirmSource();
    const operationId = crypto.randomUUID();
    storage.dropNextReply();
    expect((await h.sync({ operationId, from: day, to: day })).status).toBe(
      503,
    );
    const file = join(h.receivingHome, 'security/analytics-recipients.json');
    expect(await readFile(file, 'utf8')).toContain(threadId);
    h.advanceClock(25 * 60 * 60 * 1000);
    expect(await h.expireOutboxes()).toBe(1);
    expect(await readFile(file, 'utf8')).not.toContain(threadId);
    expect(await (await h.syncStatus()).json()).toMatchObject({
      data: { sync: { phase: 'unconfirmed', operationId } },
    });
    const reads = h.networkRequests.length;
    const recovered = await h.sync({ operationId, from: day, to: day });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      data: {
        phase: 'facts-captured',
        inserted: 1,
        sourceAuthority: 'not-established-by-status',
      },
    });
    expect(h.networkRequests).toHaveLength(reads);
    expect(storage.commits()).toBe(1);
  } finally {
    await storage.close();
  }
});

function seedPrivateSyncThread(
  h: Awaited<ReturnType<typeof fixture>>,
  threadId: string,
) {
  const time = new Date().toISOString();
  h.facts.upsertSession({
    threadId,
    provider: 'claude',
    status: 'ready',
    createdAt: time,
    updatedAt: time,
    tenantExecutionContext: {
      tenantId: tenantId('tenant-a'),
      source: 'session',
    },
  });
  h.facts.appendEvent({
    eventId: `${threadId}:start`,
    threadId,
    sessionId: threadId,
    provider: 'claude',
    method: 'session.started',
    createdAt: time,
    metadata: { userId: 'human:tailscale:alice' },
  });
  h.facts.appendEvent({
    eventId: `${threadId}:usage`,
    threadId,
    provider: 'claude',
    method: 'token-usage.updated',
    createdAt: time,
    promptTokens: 1,
  });
}
async function confirmPrivateSyncSource(
  h: Awaited<ReturnType<typeof fixture>>,
) {
  await h.approve();
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect((await h.materialize(wire)).status).toBe(200);
  await h.confirmSource();
}

test('Core resumes a lost invalidation reply, drains bounded pages and withdraws all deleted private copies', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    for (let i = 0; i < 102; i++) seedPrivateSyncThread(h, `withdraw-${i}`);
    await confirmPrivateSyncSource(h);
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 2; i++)
      expect(
        (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
          .status,
      ).toBe(200);
    for (let i = 0; i < 102; i++) h.facts.deleteThread(`withdraw-${i}`);
    storage.operatorAllowed(false);
    storage.dropNextReply();
    const input = { operationId: crypto.randomUUID(), from: day, to: day };
    expect((await h.sync(input)).status).toBe(503);
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
        )
      ).rows[0].count,
    ).toBe('2');
    const reads = h.networkRequests.length;
    const recovered = await h.sync(input);
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await recovered.json()).toMatchObject({
      data: {
        operationId: input.operationId,
        phase: 'invalidations-pending',
        invalidationCheckpoint: { after: 100, highWater: 102 },
      },
    });
    expect(h.networkRequests).toHaveLength(reads);
    expect(await (await h.syncStatus()).json()).toMatchObject({
      data: { sync: { phase: 'invalidations-pending' } },
    });
    expect((await h.sync({ ...input, restart: true })).status).toBe(409);
    expect((await h.sync(input)).status).toBe(200);
    const finished = await h.sync({
      ...input,
      operationId: crypto.randomUUID(),
    });
    expect(finished.status, await finished.clone().text()).toBe(200);
    expect(await finished.json()).toMatchObject({
      data: { phase: 'facts-captured', checkpoint: { sourceRevision: 102 } },
    });
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
        )
      ).rows[0].count,
    ).toBe('0');
    expect(
      (
        await storage.db.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM station_private_usage.invalidation_commits',
        )
      ).rows[0].count,
    ).toBe('2');
    expect((await h.sync(input)).status).toBe(409);
    const sourceDb = new DatabaseSync(join(h.sourceHome, 'facts.sqlite'));
    try {
      sourceDb.exec(`BEGIN;
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10005)
        INSERT INTO orchestration_conversation_history(thread_id,owner_user_id,tenant_id,created_at,updated_at)
        SELECT 'core-gap-'||i,'human:tailscale:alice','tenant-a','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z' FROM n;
        DELETE FROM orchestration_conversation_history WHERE thread_id LIKE 'core-gap-%'; COMMIT;`);
    } finally {
      sourceDb.close();
    }
    const gap = await h.sync({
      ...input,
      operationId: crypto.randomUUID(),
      restart: true,
    });
    expect(gap.status).toBe(410);
    expect(await gap.json()).toEqual({
      error: { code: 'usage_export_history_gap' },
    });
    expect(
      (
        await storage.db.query<{ journal: { after: number } }>(
          'SELECT journal FROM station_private_usage.vaults',
        )
      ).rows[0].journal.after,
    ).toBe(102);
  } finally {
    await storage.close();
  }
});

test.each([
  'cancel',
  'source-revoke',
  'person-change',
  'resource-change',
] as const)(
  'Core invalidation final write gate refuses %s after durable staging',
  async (change) => {
    const storage = await privateUsageFixture();
    try {
      const h = await fixture({ now: Date.now(), target: storage.target });
      seedPrivateSyncThread(h, 'withdraw-gate');
      await confirmPrivateSyncSource(h);
      const day = new Date().toISOString().slice(0, 10);
      expect(
        (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
          .status,
      ).toBe(200);
      h.facts.deleteThread('withdraw-gate');
      let reached = false;
      storage.beforeWrite(async () => {
        reached = true;
        if (change === 'cancel')
          expect(
            (
              await h.receiving.request(`${recipientBase}/${recipientId}`, {
                method: 'DELETE',
              })
            ).status,
          ).toBe(200);
        if (change === 'source-revoke')
          expect(
            (
              await h.source.request(`${sourceBase}/${approvalId}`, {
                method: 'DELETE',
              })
            ).status,
          ).toBe(200);
        if (change === 'person-change') h.receiverUser('human:tailscale:bob');
        if (change === 'resource-change') storage.available(false);
      });
      const response = await h.sync({
        operationId: crypto.randomUUID(),
        from: day,
        to: day,
      });
      expect(reached).toBe(true);
      expect(response.status).toBe(change === 'resource-change' ? 503 : 403);
      expect(
        (
          await storage.db.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM station_private_usage.invalidation_commits',
          )
        ).rows[0].count,
      ).toBe('0');
      expect(
        (
          await storage.db.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM station_private_usage.observations',
          )
        ).rows[0].count,
      ).toBe('1');
    } finally {
      await storage.close();
    }
  },
);

test('Core builds and pages more than 500 current canonical receipts and refuses stale or foreign queries', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    for (let i = 0; i < 503; i++) seedPrivateSyncThread(h, `indexed-${i}`);
    await confirmPrivateSyncSource(h);
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 6; i++)
      expect(
        (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
          .status,
      ).toBe(200);
    storage.operatorAllowed(false);
    const schema = z.object({
      data: z.object({
        indexId: z.string().uuid(),
        phase: z.enum(['indexing', 'ready']),
        receipts: z.array(
          z.object({
            id: z.string(),
            threadId: z.string(),
            inputTokens: z.number(),
          }),
        ),
        nextAfter: z.string().optional(),
        asOf: z.object({ stationId: z.string(), highWater: z.number() }),
        coverage: z.literal('retained-observations-only'),
      }),
    });
    let indexId: string | undefined, after: string | undefined;
    const rows: Array<{ id: string; threadId: string; inputTokens: number }> =
      [];
    for (let step = 0; step < 12; step++) {
      const response = await h.query({
        from: day,
        to: day,
        ...(indexId ? { indexId } : {}),
        ...(after ? { after } : {}),
      });
      expect(
        response.status,
        JSON.stringify({
          step,
          failures: storage.failures,
          response: await response.clone().text(),
        }),
      ).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('stai_');
      expect(text).not.toContain('stax_');
      const page = schema.parse(JSON.parse(text)).data;
      indexId = page.indexId;
      if (step === 0)
        expect(page).toMatchObject({ phase: 'indexing', receipts: [] });
      if (page.phase === 'indexing') {
        expect(page.receipts).toEqual([]);
        continue;
      }
      rows.push(...page.receipts);
      after = page.nextAfter;
      if (!after) break;
    }
    expect(rows).toHaveLength(503);
    expect(new Set(rows.map((r) => r.id)).size).toBe(503);
    expect(rows.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(503);
    const summary = await h.query({
      from: day,
      to: day,
      indexId,
      mode: 'summary',
      groupBy: 'provider',
    });
    expect(summary.status, await summary.clone().text()).toBe(200);
    expect(await summary.json()).toMatchObject({
      data: {
        receipts: [],
        summary: {
          phase: 'ready',
          scanned: 503,
          rows: [
            { key: 'provider:claude', inputTokens: 503, receiptCount: 503 },
          ],
        },
      },
    });
    h.receiverUser('human:tailscale:bob');
    expect((await h.query({ from: day, to: day })).status).toBe(404);
    h.receiverUser('human:tailscale:alice');
    expect(
      (await h.query({ from: day, to: day, userId: 'human:tailscale:bob' }))
        .status,
    ).toBe(400);
    seedPrivateSyncThread(h, 'index-after-snapshot');
    const stale = await h.query({ from: day, to: day });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: { code: 'private_usage_sync_required' },
    });
    const continuation = await h.query({ from: day, to: day, indexId });
    expect(continuation.status).toBe(200);
    expect(await continuation.json()).toMatchObject({
      data: {
        asOf: {
          highWater: 1006,
          observedSourceHighWater: 1008,
          freshness: 'behind-current-source-head',
        },
      },
    });
  } finally {
    await storage.close();
  }
});

test('Core current query fences source revocation before queued receipt bytes are released', async () => {
  const storage = await privateUsageFixture();
  try {
    const h = await fixture({ now: Date.now(), target: storage.target });
    seedPrivateSyncThread(h, 'query-revoke');
    await confirmPrivateSyncSource(h);
    const day = new Date().toISOString().slice(0, 10);
    expect(
      (await h.sync({ operationId: crypto.randomUUID(), from: day, to: day }))
        .status,
    ).toBe(200);
    const held = await h.query({ from: day, to: day });
    expect(held.status).toBe(200);
    expect(
      (
        await h.source.request(`${sourceBase}/${approvalId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    await expect(held.text()).rejects.toThrow('Authority observation ended');
    expect((await h.query({ from: day, to: day })).status).toBe(403);
  } finally {
    await storage.close();
  }
});

test('onboarding SDK transports the real public proof and encrypted delivery through requester-only source and address reviews', async () => {
  const h = await fixture({ now: Date.now() });
  let scope = {
    apiBase: 'http://127.0.0.1:4320',
    authorityKey: 'source-owner',
  };
  let sourceReview: Response | undefined, addressReview: Response | undefined;
  setClientCredentialResolver(() => {
    const captured = scope;
    return {
      origin: captured.apiBase,
      requestAuthority: { ...captured, isCurrent: () => captured === scope },
    };
  });
  vi.stubGlobal(
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = new URL(String(url));
      const headers = new Headers(init?.headers);
      headers.set('host', target.host);
      const app = target.port === '4320' ? h.source : h.receiving;
      const response = await app.request(target.href, { ...init, headers });
      if (
        target.pathname === '/api/analytics/source-grant-approvals' &&
        init?.method === 'POST'
      )
        sourceReview = response.clone();
      if (target.pathname.endsWith('/source-confirmation'))
        addressReview = response.clone();
      return response;
    },
  );
  try {
    scope = {
      apiBase: 'http://127.0.0.1:4322',
      authorityKey: 'receiving-owner',
    };
    const original = await fetchAnalyticsRecipientSetup(scope, recipientId);
    const received = await performAnalyticsSetup(scope, {
      kind: 'receive',
      operationId: recipientId,
      offer: original.sourceIntent,
      sourceOrigin: 'https://source.example.test',
    });
    expect(received.recipient?.confirmationCode).toBe(
      original.confirmationCode,
    );
    scope = { apiBase: 'http://127.0.0.1:4320', authorityKey: 'source-owner' };
    const started = await performAnalyticsSetup(scope, {
      kind: 'source-review',
      proof: received.recipient!.candidate,
    });
    expect(started.review?.status).toBe('pending');
    expect(analyticsReviewUrl(scope, started.review!)).toMatch(
      /^http:\/\/127.0.0.1:4321\/consent\//,
    );
    if (!sourceReview) throw new Error('No actual source requester review');
    await h.completeSourceReview(sourceReview);
    expect((await fetchAnalyticsReview(scope, started.review!)).status).toBe(
      'approved',
    );
    const sealed = await performAnalyticsSetup(scope, {
      kind: 'delivery',
      approvalId: started.review!.subject,
    });
    expect(sealed.delivery?.envelope.split('.')).toHaveLength(5);
    expect(JSON.stringify(sealed)).not.toContain('stax_');
    scope = {
      apiBase: 'http://127.0.0.1:4322',
      authorityKey: 'receiving-owner',
    };
    const stored = await performAnalyticsSetup(scope, {
      kind: 'store-delivery',
      delivery: sealed.delivery,
    });
    expect(stored.recipient?.phase).toBe('credential-stored');
    const address = await performAnalyticsSetup(scope, {
      kind: 'address-review',
      recipientId,
    });
    if (!addressReview) throw new Error('No actual receiving requester review');
    await h.completeAddressReview(addressReview);
    expect((await fetchAnalyticsReview(scope, address.review!)).status).toBe(
      'approved',
    );
    expect(
      (
        await h.readSource({
          from: new Date().toISOString().slice(0, 10),
          to: new Date().toISOString().slice(0, 10),
        })
      ).status,
    ).toBe(200);
  } finally {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  }
});

test.each(['normal', 'update'] as const)(
  '%s restore cannot revive a subsequently revoked source credential',
  async (mode) => {
    const h = await fixture();
    await h.approve();
    const delivery = z
      .object({ data: sourceCredentialDeliverySchema })
      .parse(await (await h.delivery()).json()).data;
    expect((await h.materialize(delivery)).status).toBe(200);
    const headers = await h.privateExportHeaders();
    const credential = headers.authorization.slice('Bearer '.length);
    const proof: unknown = JSON.parse(
      Buffer.from(headers['x-station-analytics-proof'], 'base64url').toString(
        'utf8',
      ),
    );
    const validateOwner = vi.fn(async () => true);
    let approvals = new SourceGrantApprovalStore(h.sourceHome, () => now);
    expect(
      (
        await approvals.authorizeExport(
          'source-station',
          approvalId,
          credential,
          proof,
          validateOwner,
        )
      ).revision,
    ).toBe(1);
    h.facts.close();
    stores.splice(stores.indexOf(h.facts), 1);
    const restore = snapshotHome(h.sourceHome, mode);
    expect(
      (
        await h.source.request(`${sourceBase}/${approvalId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    await expect(
      approvals.authorizeExport(
        'source-station',
        approvalId,
        credential,
        proof,
        validateOwner,
      ),
    ).rejects.toMatchObject({ status: 403 });
    restore();
    expect(
      JSON.parse(
        await readFile(
          join(h.sourceHome, 'security/analytics-source-approvals.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ approvals: [{ view: { phase: 'approved' } }] });
    approvals = new SourceGrantApprovalStore(h.sourceHome, () => now);
    validateOwner.mockClear();
    await expect(
      approvals.authorizeExport(
        'source-station',
        approvalId,
        credential,
        proof,
        validateOwner,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(validateOwner).not.toHaveBeenCalled();
  },
);

test('a legacy approval without activation evidence is not silently adopted or redelivered', async () => {
  const h = await fixture();
  await h.approve();
  const wire = z
    .object({ data: sourceCredentialDeliverySchema })
    .parse(await (await h.delivery()).json()).data;
  expect((await h.materialize(wire)).status).toBe(200);
  const file = join(h.sourceHome, 'security/analytics-source-approvals.json');
  const stored = z
    .object({
      version: z.literal(1),
      sourceStationId: z.string(),
      approvals: z.array(
        z.object({ activationSha256: z.string().optional() }).passthrough(),
      ),
    })
    .strict()
    .parse(JSON.parse(await readFile(file, 'utf8')));
  for (const row of stored.approvals) delete row.activationSha256;
  const legacy = JSON.stringify(stored);
  await writeFile(file, legacy);
  const view = await h.source.request(`${sourceBase}/${approvalId}`);
  expect(view.status).toBe(409);
  expect(await view.json()).toMatchObject({
    error: {
      code: 'source_activation_required',
      message: expect.stringContaining('Create a new source connection'),
    },
  });
  expect((await h.delivery()).status).toBe(409);
  expect(await readFile(file, 'utf8')).toBe(legacy);
});

test.each(['normal', 'update'] as const)(
  '%s restore of receiving keys and a completed checkpoint cannot reactivate a cancelled slot',
  async (mode) => {
    const storage = await privateUsageFixture();
    try {
      const h = await fixture({ now: Date.now(), target: storage.target });
      const at = new Date().toISOString(),
        threadId = 'receiver-activation-private';
      h.facts.upsertSession({
        threadId,
        provider: 'claude',
        status: 'ready',
        createdAt: at,
        updatedAt: at,
        tenantExecutionContext: {
          tenantId: tenantId('tenant-a'),
          source: 'session',
        },
      });
      h.facts.appendEvent({
        eventId: `${threadId}:start`,
        threadId,
        sessionId: threadId,
        provider: 'claude',
        method: 'session.started',
        createdAt: at,
        metadata: { userId: 'human:tailscale:alice' },
      });
      h.facts.appendEvent({
        eventId: `${threadId}:usage`,
        threadId,
        provider: 'claude',
        method: 'token-usage.updated',
        createdAt: at,
        promptTokens: 19,
      });
      await h.approve();
      const wire = z
        .object({ data: sourceCredentialDeliverySchema })
        .parse(await (await h.delivery()).json()).data;
      expect((await h.materialize(wire)).status).toBe(200);
      await h.confirmSource();
      const day = at.slice(0, 10),
        operationId = crypto.randomUUID(),
        input = { operationId, from: day, to: day };
      expect(await (await h.sync(input)).json()).toMatchObject({
        data: { phase: 'facts-captured', operationId },
      });
      expect(
        await (await h.readSource({ from: day, to: day })).json(),
      ).toMatchObject({
        data: {
          observations: expect.arrayContaining([
            expect.objectContaining({
              receipts: expect.arrayContaining([
                expect.objectContaining({ threadId, inputTokens: 19 }),
              ]),
            }),
          ]),
        },
      });
      const committed = storage.commits();
      expect(committed).toBeGreaterThan(0);
      const restore = snapshotHome(h.receivingHome, mode);
      expect(
        (
          await h.receiving.request(`${recipientBase}/${recipientId}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
      expect(await (await h.syncStatus()).json()).toMatchObject({
        data: { phase: 'cancelled' },
      });
      restore();
      const network = vi.fn<typeof fetch>(async () => {
        throw new Error('restored key reached source network');
      });
      const restored = new RecipientStore(
          h.receivingHome,
          () => Date.now(),
          network,
        ),
        actor = h.receivingActor();
      await expect(
        restored.syncPage(
          actor,
          recipientId,
          input,
          storage.target(actor.assertCurrent),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'recipient_activation_required',
        status: 409,
      });
      await expect(
        restored.readSourcePage(
          actor,
          recipientId,
          { from: day, to: day },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'recipient_activation_required',
        status: 409,
      });
      await expect(
        restored.queryReceipts(
          actor,
          recipientId,
          { from: day, to: day },
          storage.target(actor.assertCurrent),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'recipient_activation_required',
        status: 409,
      });
      expect(storage.commits()).toBe(committed);
      expect(network).not.toHaveBeenCalled();
      const view = await restored.get(actor, recipientId);
      expect(view.phase).toBe('restore-required');
      expect(view).not.toHaveProperty('storedCredential');
      expect(view).not.toHaveProperty('sourceConfirmation');
      expect(view).not.toHaveProperty('sync');
      await expect(
        restored.materialize(actor, recipientId, wire),
      ).rejects.toMatchObject({
        code: 'recipient_activation_required',
        status: 409,
      });
      expect((await restored.cancel(actor, recipientId)).phase).toBe(
        'cancelled',
      );
      const freshId = crypto.randomUUID();
      const fresh = await restored.prepare(actor, {
        operationId: freshId,
        sourceIntent: view.sourceIntent,
        proposedSourceOrigin: 'https://source.example.test',
      });
      expect(fresh).toMatchObject({
        phase: 'candidate',
        exportAuthority: false,
        candidate: { claims: { recipientId: freshId } },
      });
      expect(fresh.candidate.claims.proofKey.x).not.toBe(
        view.candidate.claims.proofKey.x,
      );
      expect(fresh).not.toHaveProperty('storedCredential');
    } finally {
      await storage.close();
    }
  },
);
