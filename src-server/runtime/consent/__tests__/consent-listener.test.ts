/**
 * The consent listener's contract tests model the ATTACKS the distinct-origin
 * surface exists to stop (archive#3677). Each refusal is proven separately —
 * nonce, Origin, and Fetch Metadata are three independent proofs, and a test
 * that only removed all three at once could not tell which one held.
 */
import { request as httpRequest } from 'node:http';
import { serve } from '@hono/node-server';
import { describe, expect, test, vi } from 'vitest';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import type { ConsentTargetSnapshot } from '../../../services/consent/consent-transactions.js';
import { createConsentApp, startConsentListener } from '../consent-listener.js';

const CONSENT_PORT = 4321;
const CONSENT_HOST = `127.0.0.1:${CONSENT_PORT}`;
const CONSENT_ORIGIN = `http://${CONSENT_HOST}`;
const APP_ORIGIN = 'http://127.0.0.1:3141';

const OPERATOR_CREDENTIAL = 'O'.repeat(43);
const PROMOTED_DEVICE_CREDENTIAL = 'P'.repeat(43);
const STANDARD_DEVICE_CREDENTIAL = 'S'.repeat(43);

function makeCredentials() {
  return {
    verifyOperatorCredential: (candidate: string) =>
      candidate === OPERATOR_CREDENTIAL,
    identifyDevice: (candidate: string) => {
      if (candidate === PROMOTED_DEVICE_CREDENTIAL) {
        return { scope: 'orchestration:read consent:decide' };
      }
      if (candidate === STANDARD_DEVICE_CREDENTIAL) {
        return {
          scope: 'orchestration:read orchestration:operate terminal:operate',
        };
      }
      return null;
    },
  };
}

function target(fingerprint = 'fp-1'): ConsentTargetSnapshot {
  return { kind: 'plugin-trusted-permissions', subject: 'demo', fingerprint };
}

function setup(
  overrides: Partial<{
    revalidateTarget: () => Promise<ConsentTargetSnapshot | null>;
    commitApproval: () => Promise<void>;
  }> = {},
) {
  const channel = new ConsentChannelService();
  channel.markListening(CONSENT_PORT);
  const commitApproval = overrides.commitApproval ?? vi.fn(async () => {});
  const created = channel.store.create({
    tenantId: channel.tenantId,
    target: target(),
    description: {
      title: 'Trust Demo Plugin?',
      summary: 'Review the exact capabilities.',
      items: [{ label: 'plugin.server', detail: 'Runs server-side code' }],
      warning: 'Only approve trusted publishers.',
      approveLabel: 'Approve trusted access',
      denyLabel: 'Deny',
    },
    requester: { kind: 'plugin-ui', id: 'demo' },
    rateKey: 'plugin-ui',
    revalidateTarget: overrides.revalidateTarget ?? (async () => target()),
    commitApproval,
  });
  if (!created.ok) throw new Error('setup failed');
  const app = createConsentApp({ channel, credentials: makeCredentials() });
  return { channel, app, id: created.transaction.id, commitApproval };
}

/** The headers a genuine top-level review-page navigation carries. */
function reviewGetHeaders(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    host: CONSENT_HOST,
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function renderNonce(
  app: ReturnType<typeof createConsentApp>,
  id: string,
  cookie = `station-device=${OPERATOR_CREDENTIAL}`,
): Promise<string> {
  const response = await app.request(`/consent/${id}`, {
    headers: reviewGetHeaders({ cookie }),
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = html.match(/name="nonce" value="([^"]+)"/);
  if (!match) throw new Error('review page carried no nonce');
  return match[1];
}

/** The headers a genuine review-page form submission carries. */
function decideHeaders(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    host: CONSENT_HOST,
    origin: CONSENT_ORIGIN,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    // A real approve click sends this too (live trace, archive#3752); the
    // decide guard requires it so "top-level navigation" is derived.
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function decideBody(decision: string, nonce?: string): string {
  const body = new URLSearchParams({ decision });
  if (nonce !== undefined) body.set('nonce', nonce);
  return body.toString();
}

describe('consent listener review page', () => {
  test('an unauthenticated GET leaks nothing — not the description, not whether the id exists', async () => {
    const { app, id } = setup();
    const response = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders({ cookie: undefined }),
    });
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).not.toContain('Demo Plugin');
    expect(html).not.toContain('plugin.server');
    const unknown = await app.request('/consent/does-not-exist', {
      headers: reviewGetHeaders({ cookie: undefined }),
    });
    expect(unknown.status).toBe(403);
  });

  test('a standard-scoped paired device cannot open the review', async () => {
    const { app, id } = setup();
    const response = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders({
        cookie: `station-device=${STANDARD_DEVICE_CREDENTIAL}`,
      }),
    });
    expect(response.status).toBe(403);
  });

  test('the operator gets a script-free, hardened review page with the canonical description', async () => {
    const { app, id } = setup();
    const response = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get('cross-origin-opener-policy')).toBe(
      'same-origin',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    // archive#3752: `same-origin`, not `no-referrer`. Chromium computes a
    // form submission's Origin under the referrer policy, so `no-referrer`
    // made this page's own approve click arrive as `Origin: null` and the
    // decide guard refused it — the page defeating its own check. The
    // transaction id still never leaves this origin.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const html = await response.text();
    expect(html).toContain('Trust Demo Plugin?');
    expect(html).toContain('plugin.server');
    expect(html).not.toContain('<script');
  });

  test('a consent:decide-promoted device and the transaction-bound session can both open the review', async () => {
    const { app, channel, id } = setup();
    const promoted = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders({
        cookie: `station-device=${PROMOTED_DEVICE_CREDENTIAL}`,
      }),
    });
    expect(promoted.status).toBe(200);
    const secret = channel.store.decisionSessionSecretFor(channel.tenantId, id);
    const viaSession = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders({ cookie: `station-consent=${secret}` }),
    });
    expect(viaSession.status).toBe(200);
    // The session is bound to ITS transaction: it opens nothing else.
    const other = setup();
    const crossed = await other.app.request(`/consent/${other.id}`, {
      headers: reviewGetHeaders({ cookie: `station-consent=${secret}` }),
    });
    expect(crossed.status).toBe(403);
  });

  test('INJECTION 6 (review MED 3): a fetch-shaped credentialed GET neither re-mints the nonce nor grows the audit — the open review page stays decidable', async () => {
    // Models the same-site attack: the transaction cookie is SameSite=Strict
    // but a different PORT is the same schemeful site, so plugin code can
    // fire credentialed cross-origin GETs whose responses it cannot read.
    // Independently proves: (a) the request is refused before any store
    // access; (b) the user's already-minted nonce still decides (pre-fix it
    // was replaced on every GET — denial-of-consent); (c) the audit trail
    // did not grow.
    const { app, id, channel } = setup();
    const nonce = await renderNonce(app, id);
    const auditBefore = channel.store.auditTrail(channel.tenantId, id).length;
    for (const shape of [
      { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
      // An iframe-shaped navigation is not a top-level document either.
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      // No Sec-Fetch headers at all (a non-browser client).
      { 'sec-fetch-mode': undefined, 'sec-fetch-dest': undefined },
    ] as const) {
      const response = await app.request(`/consent/${id}`, {
        headers: reviewGetHeaders(shape),
      });
      expect(response.status).toBe(403);
    }
    expect(channel.store.auditTrail(channel.tenantId, id).length).toBe(
      auditBefore,
    );
    // The nonce minted for the user's real navigation still decides.
    const decided = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve', nonce),
    });
    expect(decided.status).toBe(200);
  });

  test('review MED 3: the render budget surfaces as a truthful 429 page', async () => {
    const { app, id } = setup();
    for (let i = 0; i < 30; i += 1) {
      const response = await app.request(`/consent/${id}`, {
        headers: reviewGetHeaders(),
      });
      expect(response.status).toBe(200);
    }
    const limited = await app.request(`/consent/${id}`, {
      headers: reviewGetHeaders(),
    });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('Too many review opens');
  });
});

describe('consent listener decision — the injections (each proven independently)', () => {
  test('INJECTION 1: a script-shaped POST (no navigation Fetch Metadata) is refused even with a valid nonce, cookie, and Origin', async () => {
    const { app, id, commitApproval, channel } = setup();
    const nonce = await renderNonce(app, id);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders({
        'sec-fetch-site': undefined,
        'sec-fetch-mode': undefined,
        'sec-fetch-user': undefined,
      }),
      body: decideBody('approve', nonce),
    });
    expect(response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
    // fetch()-shaped metadata (cors mode, no user activation) refuses too —
    // proving the check needs a NAVIGATION, not just any Sec-Fetch headers.
    const fetchShaped = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders({
        'sec-fetch-mode': 'cors',
        'sec-fetch-user': undefined,
      }),
      body: decideBody('approve', nonce),
    });
    expect(fetchShaped.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('INJECTION 2a: correct headers with a MISSING nonce are refused — Sec-Fetch alone no longer decides anything', async () => {
    const { app, id, commitApproval, channel } = setup();
    await renderNonce(app, id);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve'),
    });
    expect(response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  test('INJECTION 2b: a REPLAYED nonce is refused — consumption is atomic and one-use', async () => {
    const { app, id, commitApproval } = setup();
    const nonce = await renderNonce(app, id);
    const first = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve', nonce),
    });
    expect(first.status).toBe(200);
    expect(commitApproval).toHaveBeenCalledTimes(1);
    const replay = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve', nonce),
    });
    expect(replay.status).toBe(409);
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });

  test('INJECTION 2c: a stale nonce (superseded by a re-render) is refused while the transaction is still pending', async () => {
    const { app, id, commitApproval, channel } = setup();
    const stale = await renderNonce(app, id);
    await renderNonce(app, id); // re-render replaces the nonce
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve', stale),
    });
    expect(response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  /**
   * archive#3752: `'null'` STAYS refused here, and the defect that made
   * every real approve click arrive as `Origin: null` was fixed at its
   * source — the page's own `Referrer-Policy` (pinned by the test below).
   * Chromium computes a form submission's Origin under the document's
   * referrer policy, so `no-referrer` stripped it and this guard refused the
   * exact submission it exists to admit; four product E2E specs were red at
   * that seam. Captured from a live browser trace BEFORE the fix:
   *
   *   POST /consent/<id>/decide
   *   host: localhost:3635   origin: null
   *   sec-fetch-site: same-origin   sec-fetch-mode: navigate
   *   sec-fetch-dest: document      -> 403 Forbidden
   *
   * Admitting `null` here was this fix's first shape; independent review was
   * right that it deletes a proof instead of restoring one, leaving Fetch
   * Metadata alone load-bearing.
   */
  test('INJECTION 3: a wrong Origin (the app origin — the cross-origin attack) is refused even with valid metadata, nonce, and cookie', async () => {
    const { app, id, commitApproval, channel } = setup();
    const nonce = await renderNonce(app, id);
    for (const origin of [APP_ORIGIN, undefined, 'null']) {
      const response = await app.request(`/consent/${id}/decide`, {
        method: 'POST',
        headers: decideHeaders({ origin }),
        body: decideBody('approve', nonce),
      });
      expect(response.status).toBe(403);
    }
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  test('station#3752: the page does not defeat its own guard — its Referrer-Policy keeps a real Origin coming, and a nested navigation is refused', async () => {
    const { app, id, commitApproval, channel } = setup();

    // The header that caused the outage. `no-referrer` makes Chromium send
    // `Origin: null` on this page's own form POST, which the guard above
    // refuses; `same-origin` still withholds the transaction id from every
    // other origin, and the page loads no subresources at all.
    const rendered = await app.request(`/consent/${id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    expect(rendered.headers.get('referrer-policy')).toBe('same-origin');

    // "Top-level" is now derived rather than assumed: a nested navigation
    // carries the same site/mode/user-activation but a frame destination.
    const nonce = await renderNonce(app, id);
    for (const dest of ['iframe', 'frame', 'empty', undefined]) {
      const refused = await app.request(`/consent/${id}/decide`, {
        method: 'POST',
        headers: decideHeaders({ 'sec-fetch-dest': dest }),
        body: decideBody('approve', nonce),
      });
      expect(refused.status).toBe(403);
    }
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  test('INJECTION 3b (review LOW 6): an Origin that only matches after canonicalization is refused — the header is compared exactly', async () => {
    const { app, id, commitApproval, channel } = setup();
    const nonce = await renderNonce(app, id);
    // (A trailing-space variant is deliberately absent: HTTP field-value OWS
    // is trimmed by the header layer itself before any comparison runs, so
    // it cannot reach the handler untrimmed.)
    for (const origin of [
      `${CONSENT_ORIGIN}/`, // trailing slash
      CONSENT_ORIGIN.toUpperCase(), // uppercase scheme+host
    ]) {
      // Each variant is one a real browser Origin header never carries, yet
      // canonicalization would have accepted: this is the independent proof
      // that the OLD comparison (new URL(origin).origin) passed it.
      expect(new URL(origin).origin).toBe(CONSENT_ORIGIN);
      const response = await app.request(`/consent/${id}/decide`, {
        method: 'POST',
        headers: decideHeaders({ origin }),
        body: decideBody('approve', nonce),
      });
      expect(response.status).toBe(403);
    }
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  test('INJECTION 4: a target that changed between request and decision refuses with the revalidation reason and grants nothing', async () => {
    const { app, id, commitApproval, channel } = setup({
      revalidateTarget: async () => target('fp-CHANGED'),
    });
    const nonce = await renderNonce(app, id);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('approve', nonce),
    });
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain('Nothing was granted');
    expect(html).toContain('changed');
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('pending');
  });

  test('an unauthenticated decision is refused even with valid Origin, metadata, and nonce', async () => {
    const { app, id, commitApproval } = setup();
    const nonce = await renderNonce(app, id);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders({ cookie: undefined }),
      body: decideBody('approve', nonce),
    });
    expect(response.status).toBe(403);
    // A standard-scoped device session is also not consent authority.
    const standard = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders({
        cookie: `station-device=${STANDARD_DEVICE_CREDENTIAL}`,
      }),
      body: decideBody('approve', nonce),
    });
    expect(standard.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('the transaction-bound consent session can decide its own transaction (the bearer-only-UI path)', async () => {
    const { app, id, channel, commitApproval } = setup();
    const secret = channel.store.decisionSessionSecretFor(channel.tenantId, id);
    const cookie = `station-consent=${secret}`;
    const nonce = await renderNonce(app, id, cookie);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders({ cookie }),
      body: decideBody('approve', nonce),
    });
    expect(response.status).toBe(200);
    expect(commitApproval).toHaveBeenCalledTimes(1);
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('approved');
  });

  test('denial through the full surface grants nothing and closes the transaction', async () => {
    const { app, id, channel, commitApproval } = setup();
    const nonce = await renderNonce(app, id);
    const response = await app.request(`/consent/${id}/decide`, {
      method: 'POST',
      headers: decideHeaders(),
      body: decideBody('deny', nonce),
    });
    expect(response.status).toBe(200);
    expect(commitApproval).not.toHaveBeenCalled();
    expect(channel.store.get(channel.tenantId, id)?.status).toBe('denied');
  });

  test('undeclared paths 404 and the app registers no route outside the declared consent surface', async () => {
    const { app } = setup();
    const response = await app.request('/api/anything', {
      headers: { host: CONSENT_HOST },
    });
    expect(response.status).toBe(404);
  });
});

describe('consent listener lifecycle (owner decision 3: fail closed, never fail Station)', () => {
  test('INJECTION 5: a bind conflict reports a truthful unavailable state instead of degrading open or throwing', async () => {
    const { app } = setup();
    // Occupy a port, then ask the listener to bind the same one.
    const blocker = serve({ fetch: () => new Response('x'), port: 0 });
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      const started = await startConsentListener({ app, port: blockedPort });
      expect(started.status).toBe('unavailable');
      if (started.status !== 'unavailable') return;
      expect(started.reason).toContain(String(blockedPort));
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  test('a healthy bind serves the real HTTP surface and closes cleanly', async () => {
    const { channel, app, id } = setup();
    const started = await startConsentListener({ app, port: 0 });
    expect(started.status).toBe('listening');
    if (started.status !== 'listening') return;
    channel.markListening(started.listener.port);
    try {
      // node:http, not fetch — undici forbids client code setting `Sec-*`
      // headers (the same rule that makes them trustworthy from browsers),
      // and this test must send the navigation shape a real browser would.
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port: started.listener.port,
              path: `/consent/${id}`,
              headers: {
                cookie: `station-device=${OPERATOR_CREDENTIAL}`,
                'sec-fetch-mode': 'navigate',
                'sec-fetch-dest': 'document',
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, body }),
              );
            },
          );
          request.on('error', reject);
          request.end();
        },
      );
      expect(response.status).toBe(200);
      expect(response.body).toContain('Trust Demo Plugin?');
    } finally {
      await started.listener.close();
    }
  });
});
