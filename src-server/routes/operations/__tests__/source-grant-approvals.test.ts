import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { RecipientStore } from '../../../analytics/recipient-store.js';
import { SourceEnrollmentStore } from '../../../analytics/source-enrollment-store.js';
import {
  type SourceApprovalActor,
  SourceGrantApprovalStore,
} from '../../../analytics/source-grant-store.js';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { createSourceGrantApprovalRoutes } from '../source-grant-approvals.js';

const temporary = trackTempDirs();
const base = '/api/analytics/source-grant-approvals';
const sourceId = '01234567-89ab-4cde-8fab-0123456789ab';
const recipientId = '11234567-89ab-4cde-8fab-0123456789ab';
const approvalId = '21234567-89ab-4cde-8fab-0123456789ab';
const operator = 'O'.repeat(43);
const now = Date.parse('2026-10-24T00:00:00.000Z');
async function fixture() {
  let permitted = true;
  let userId = 'human:tailscale:alice';
  const makeActor = (stationId: string): SourceApprovalActor => {
    const captured = userId;
    return {
      sourceStationId: stationId,
      userId: captured,
      mode: 'personal',
      tenantId: null,
      ownerIds: [captured],
      approvalCredentialId: 'source-device',
      approvalBindingSha256: 'a'.repeat(64),
      async assertApprovalCurrent() {
        await this.assertCurrent();
      },
      async assertCurrent() {
        if (!permitted || captured !== userId)
          throw new AuthorityObservationRejected(403, 'authority_changed');
      },
    };
  };
  const source = new SourceEnrollmentStore(
    temporary('source-consent-'),
    () => now,
  );
  const approvalHome = temporary('source-approval-');
  const approvals = new SourceGrantApprovalStore(approvalHome, () => now);
  const sourceActor = makeActor('source-station');
  const intent = await source.prepare(sourceActor, {
    operationId: sourceId,
    proposedDestination: {
      stationId: 'receiving-station',
      origin: 'https://receiving.example.test',
    },
    scope: 'individual',
    expiresAt: '2026-10-25T00:00:00.000Z',
    retention: { mode: 'live-mirror' },
  });
  const receiver = new RecipientStore(
    temporary('receiving-consent-'),
    () => now,
  );
  const recipient = await receiver.prepare(makeActor('receiving-station'), {
    operationId: recipientId,
    proposedSourceOrigin: 'https://source.example.test',
    sourceIntent: intent,
  });
  const channel = new ConsentChannelService({ now: () => now });
  channel.markListening(4321);
  const app = new Hono().route(
    base,
    createSourceGrantApprovalRoutes({
      channel,
      enrollments: source,
      approvals,
      capture: async () => makeActor('source-station'),
      now: () => now,
    }),
  );
  const consent = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: (value) => value === operator,
      identifyDevice: () => null,
      resolveGrantedScope: () => undefined,
    },
  });
  const body = {
    operationId: approvalId,
    sourceOperationId: sourceId,
    recipientCandidate: recipient.candidate,
  };
  return {
    app,
    approvalHome,
    consent,
    channel,
    source,
    sourceActor,
    body,
    post: () =>
      app.request(base, {
        method: 'POST',
        headers: { host: '127.0.0.1:4320', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    deny() {
      permitted = false;
    },
    setUser(value: string) {
      userId = value;
    },
  };
}
function reviewHeaders(cookie: string) {
  return {
    host: '127.0.0.1:4321',
    cookie,
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
}
function decideHeaders(cookie: string) {
  return {
    ...reviewHeaders(cookie),
    origin: 'http://127.0.0.1:4321',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'content-type': 'application/x-www-form-urlencoded',
  };
}
async function request(h: Awaited<ReturnType<typeof fixture>>) {
  const response = await h.post();
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('approval' in body) ||
    !body.approval ||
    typeof body.approval !== 'object' ||
    !('reviewUrl' in body.approval) ||
    typeof body.approval.reviewUrl !== 'string'
  )
    throw new Error('Missing review URL');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Missing requester session');
  return { url: new URL(body.approval.reviewUrl), cookie };
}
async function render(
  h: Awaited<ReturnType<typeof fixture>>,
  url: URL,
  cookie: string,
) {
  const response = await h.consent.request(url.href, {
    headers: reviewHeaders(cookie),
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  if (!nonce) throw new Error('Missing rendered nonce');
  return nonce;
}

test('only the requester session can render and approve a personal source; approval is durable and revocable but not an export credential', async () => {
  const h = await fixture();
  const { url, cookie } = await request(h);
  expect(url.searchParams.get('scope')).toMatch(/^analytics:[a-f0-9]{64}$/);
  expect(
    (
      await h.consent.request(url.href, {
        headers: reviewHeaders(`station-device=${operator}`),
      })
    ).status,
  ).toBe(403);
  const nonce = await render(h, url, cookie);
  const decision = new URL(url);
  decision.pathname += '/decide';
  expect(
    (
      await h.consent.request(decision.href, {
        method: 'POST',
        headers: decideHeaders(`station-device=${operator}`),
        body: new URLSearchParams({ decision: 'approve', nonce }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.consent.request(decision.href, {
        method: 'POST',
        headers: decideHeaders(cookie),
        body: new URLSearchParams({ decision: 'approve', nonce }),
      })
    ).status,
  ).toBe(200);
  const approved = await h.app.request(`${base}/${approvalId}`);
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({
    data: {
      phase: 'approved',
      sourceApproved: true,
      exportAuthority: false,
      recipientAssurance: 'source-user-approved-key',
    },
  });
  h.setUser('human:tailscale:bob');
  expect((await h.app.request(`${base}/${approvalId}`)).status).toBe(404);
  h.setUser('human:tailscale:alice');
  expect(
    await (
      await h.app.request(`${base}/${approvalId}`, { method: 'DELETE' })
    ).json(),
  ).toMatchObject({ data: { phase: 'revoked' } });
  const file = join(h.approvalHome, 'security/analytics-source-approvals.json');
  const content = z
    .object({
      approvals: z.array(
        z
          .object({ view: z.object({ scope: z.string() }).passthrough() })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(JSON.parse(await readFile(file, 'utf8')));
  const first = content.approvals[0];
  if (!first) throw new Error('Missing approval record');
  first.view.scope = 'personal-account';
  await writeFile(file, JSON.stringify(content), { mode: 0o600 });
  expect((await h.app.request(`${base}/${approvalId}`)).status).toBe(503);
});

test('a source cancelled after review cannot be approved by echoing its old nonce and key candidate', async () => {
  const h = await fixture();
  const { url, cookie } = await request(h);
  const nonce = await render(h, url, cookie);
  await h.source.cancel(h.sourceActor, sourceId);
  const decision = new URL(url);
  decision.pathname += '/decide';
  const response = await h.consent.request(decision.href, {
    method: 'POST',
    headers: decideHeaders(cookie),
    body: new URLSearchParams({ decision: 'approve', nonce }),
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('Nothing was granted');
  expect((await h.app.request(`${base}/${approvalId}`)).status).toBe(404);
});
