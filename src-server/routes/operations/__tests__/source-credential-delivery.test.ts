import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createRecipientCandidateRoutes } from '../recipient-candidates.js';
import { createSourceGrantApprovalRoutes } from '../source-grant-approvals.js';
import { createSourceGrantExportRoutes } from '../source-grant-export.js';

const temporary = trackTempDirs();
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
async function fixture() {
  const sourceHome = temporary('credential-source-'),
    receivingHome = temporary('credential-receiver-');
  let sourceTenant = 'tenant-a';
  let exportOwnerCheck = async () => {};
  let receivingUser = 'human:tailscale:alice',
    receivingTenant = 'tenant-a',
    approvalCurrent = true;
  const actor = (stationId: string): SourceApprovalActor => {
    const userId =
      stationId === 'source-station' ? 'human:tailscale:alice' : receivingUser;
    const tenantId =
      stationId === 'source-station' ? 'tenant-a' : receivingTenant;
    return {
      sourceStationId: stationId,
      userId,
      mode: 'hosted',
      tenantId,
      ownerIds: [userId],
      approvalCredentialId: 'approved-device',
      approvalBindingSha256: 'a'.repeat(64),
      async assertCurrent() {
        if (
          stationId !== 'source-station' &&
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
  const sourceActor = actor('source-station');
  const enrollments = new SourceEnrollmentStore(sourceHome, () => now);
  const intent = await enrollments.prepare(sourceActor, {
    operationId: sourceId,
    proposedDestination: {
      stationId: 'receiving-station',
      origin: 'https://receiving.example.test',
    },
    scope: 'individual',
    expiresAt: '2026-10-25T00:00:00.000Z',
    retention: { mode: 'live-mirror' },
  });
  const recipients = new RecipientStore(receivingHome, () => now);
  const recipient = await recipients.prepare(actor('receiving-station'), {
    operationId: recipientId,
    proposedSourceOrigin: 'https://source.example.test',
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
      capture: async () => actor('source-station'),
      now: () => now,
    }),
  );
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
      authorize: (_request, id, credential, proof) =>
        approvals.authorizeExport(
          'source-station',
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
          stationId: 'source-station',
          request: query,
          personalOwnerIds: () => undefined,
          authorizationContext,
        }),
    }),
  );
  const receiving = new Hono().route(
    recipientBase,
    createRecipientCandidateRoutes({
      store: recipients,
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
    expect(request.status).toBe(200);
    const result = z
      .object({ approval: z.object({ reviewUrl: z.string() }) })
      .parse(await request.json());
    const cookie = request.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Missing requester session');
    const reviewUrl = new URL(result.approval.reviewUrl);
    const headers = {
      host: '127.0.0.1:4321',
      cookie,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    const review = await consent.request(reviewUrl.href, { headers });
    expect(review.status).toBe(200);
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];
    if (!nonce) throw new Error('Missing review nonce');
    reviewUrl.pathname += '/decide';
    const decision = await consent.request(reviewUrl.href, {
      method: 'POST',
      headers: {
        ...headers,
        origin: 'http://127.0.0.1:4321',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ decision: 'approve', nonce }),
    });
    expect(decision.status).toBe(200);
  };
  const delivery = () =>
    source.request(`${sourceBase}/${approvalId}/delivery`, { method: 'POST' });
  const materialize = (value: unknown) =>
    receiving.request(`${recipientBase}/${recipientId}/credentials`, {
      method: 'POST',
      body: JSON.stringify(value),
    });
  return {
    sourceHome,
    facts,
    onExportOwnerCheck(check: () => Promise<void>) {
      exportOwnerCheck = check;
    },
    sourceTenant(value: string) {
      sourceTenant = value;
    },
    receivingHome,
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
  const headers = {
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
