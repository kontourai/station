import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import {
  bindRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import type { ConsentTargetSnapshot } from '../../../services/consent/consent-transactions.js';
import { registerConsentNativeRoutes } from '../consent-native-routes.js';

/**
 * station#3677 PR 3 — the native broker's server half. The threat model is
 * the same as the listener's (same-origin plugin code must not self-approve;
 * the reviewed target must be the granted target); what changes is the
 * authority proof: the request principal's mint-time `home-possession`
 * locality stamp PLUS the `local-grant` mint kind — the secret-FILE proof no
 * JS context can produce — bound once at the auth boundary. These tests
 * drive the REAL store through the routes with real bound/unbound Requests.
 */

/**
 * `bindRuntimeLocalOperator` takes a whole principal, so these fixtures are
 * annotated as one. Only `locality` and `mintKind` decide anything on this
 * path (`localRuntimeCaller.evaluate` reads `locality`; the approve-capable
 * flag adds `mintKind`) — the remaining fields are the shape the auth
 * boundary always fills in, present so the fixture is the type it is passed
 * as rather than a partial the compiler had to be talked out of.
 */
const LOCAL_GRANT_MINTED: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'local-grant-test-credential',
  authority: undefined,
  source: 'bearer',
  locality: 'home-possession',
  mintKind: 'local-grant',
};

/**
 * The discriminating principal (station#3677 PR 3): SAME possession proof,
 * different custody — a UI-bootstrap mint's credential lives in host-browser
 * JS, where same-origin plugin code runs. It reads unredacted logs; it must
 * never approve.
 */
const UI_BOOTSTRAP_MINTED: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'ui-bootstrap-test-credential',
  authority: undefined,
  source: 'session',
  locality: 'home-possession',
  mintKind: 'ui-bootstrap',
};

function setup(options: { withChannel?: boolean } = {}) {
  const channel =
    (options.withChannel ?? true) ? new ConsentChannelService() : undefined;
  const app = new Hono();
  registerConsentNativeRoutes(app, { consentChannel: channel });
  return { app, channel };
}

function createTransaction(
  channel: ConsentChannelService,
  overrides: {
    commitApproval?: () => Promise<void>;
    revalidateTarget?: () => Promise<ConsentTargetSnapshot | null>;
  } = {},
) {
  const target: ConsentTargetSnapshot = {
    kind: 'native-broker-test',
    subject: 'demo-plugin',
    fingerprint: JSON.stringify({ digest: 'sha256:abc' }),
  };
  const commitApproval = overrides.commitApproval ?? vi.fn(async () => {});
  const created = channel.store.create({
    tenantId: channel.tenantId,
    target,
    requester: { kind: 'plugin-ui', id: 'demo-plugin' },
    rateKey: 'plugin-ui',
    description: {
      title: 'Trust demo-plugin?',
      summary: 'Native broker test transaction.',
      items: [{ label: 'plugin.server', detail: 'Trusted host behavior' }],
      warning: 'Only approve trusted publishers.',
      approveLabel: 'Approve',
      denyLabel: 'Deny',
    },
    revalidateTarget:
      overrides.revalidateTarget ?? (async () => ({ ...target })),
    commitApproval,
  });
  if (!created.ok) throw new Error('fixture transaction refused');
  return { id: created.transaction.id, commitApproval };
}

type CallerKind = 'local-grant' | 'ui-bootstrap' | 'unbound';

/** A request bound at the auth boundary as the given caller kind. */
function callerRequest(
  kind: CallerKind,
  path: string,
  init?: RequestInit,
): Request {
  const request = new Request(`http://station.test${path}`, init);
  if (kind !== 'unbound') {
    bindRuntimeLocalOperator(
      request,
      kind === 'local-grant' ? LOCAL_GRANT_MINTED : UI_BOOTSTRAP_MINTED,
    );
  }
  return request;
}

async function eligibility(app: Hono, caller: CallerKind) {
  const response = await app.request(
    callerRequest(caller, '/native-eligibility'),
  );
  return (await response.json()) as { eligible: boolean };
}

async function review(
  app: Hono,
  id: string,
  caller: CallerKind = 'local-grant',
) {
  const path = `/requests/${id}/native-review`;
  const init = { method: 'POST' };
  const response = await app.request(callerRequest(caller, path, init));
  const body = (await response.json()) as {
    review?: { nonce: string; description: { title: string } };
    error?: string;
  };
  return { response, body };
}

async function decide(
  app: Hono,
  id: string,
  decision: string,
  nonce: string | undefined,
  caller: CallerKind = 'local-grant',
) {
  const path = `/requests/${id}/native-decide`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, nonce }),
  };
  const response = await app.request(callerRequest(caller, path, init));
  const body = (await response.json()) as {
    request?: { status: string };
    error?: string;
  };
  return { response, body };
}

describe('consent native broker routes (station#3677 PR 3)', () => {
  test('fails closed with 503 when no consent channel is configured', async () => {
    const { app } = setup({ withChannel: false });
    const { response } = await review(app, 'anything');
    expect(response.status).toBe(503);
  });

  test('a request WITHOUT the home-possession stamp is refused, and mints nothing', async () => {
    const { app, channel } = setup();
    const { id } = createTransaction(channel!);

    const reviewed = await review(app, id, 'unbound');
    expect(reviewed.response.status).toBe(403);
    expect(reviewed.body.review).toBeUndefined();

    // The refusal happened BEFORE any render: the render budget and nonce
    // are untouched, so a later legitimate review is unaffected.
    const legit = await review(app, id);
    expect(legit.response.status).toBe(200);
    expect(legit.body.review?.nonce).toBeTruthy();
  });

  test('an unbound decide is refused and commits nothing', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);
    const { body } = await review(app, id);

    const decided = await decide(
      app,
      id,
      'approve',
      body.review?.nonce,
      'unbound',
    );
    expect(decided.response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('a UI-BOOTSTRAP-minted home-possession caller is refused — same possession, JS-resident custody', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);

    // Review refused before minting anything.
    const reviewed = await review(app, id, 'ui-bootstrap');
    expect(reviewed.response.status).toBe(403);
    expect(reviewed.body.review).toBeUndefined();

    // Even holding a legitimately minted nonce (say, leaked or replayed),
    // the ui-bootstrap principal cannot decide.
    const legit = await review(app, id);
    const decided = await decide(
      app,
      id,
      'approve',
      legit.body.review?.nonce,
      'ui-bootstrap',
    );
    expect(decided.response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('the local host reviews and approves: description returned, commit runs, status settles', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);

    const reviewed = await review(app, id);
    expect(reviewed.response.status).toBe(200);
    expect(reviewed.body.review?.description.title).toBe('Trust demo-plugin?');
    expect(reviewed.body.review?.nonce).toBeTruthy();

    const decided = await decide(
      app,
      id,
      'approve',
      reviewed.body.review?.nonce,
    );
    expect(decided.response.status).toBe(200);
    expect(decided.body.request?.status).toBe('approved');
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });

  test('denying commits nothing and settles denied', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);
    const { body } = await review(app, id);

    const decided = await decide(app, id, 'deny', body.review?.nonce);
    expect(decided.response.status).toBe(200);
    expect(decided.body.request?.status).toBe('denied');
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('a stale nonce is refused: re-review replaces the nonce, only the newest dialog can decide', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);

    const first = await review(app, id);
    const second = await review(app, id);
    expect(second.body.review?.nonce).not.toBe(first.body.review?.nonce);

    const stale = await decide(app, id, 'approve', first.body.review?.nonce);
    expect(stale.response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();

    // The store consumes the current nonce BEFORE comparing (anti-replay),
    // so ANY refused decide burns it — even the fresh dialog must re-review
    // after a stale attempt. This is the listener's contract too; the native
    // dialog's stale-refusal copy says exactly this.
    const burned = await decide(app, id, 'approve', second.body.review?.nonce);
    expect(burned.response.status).toBe(403);
    expect(commitApproval).not.toHaveBeenCalled();

    const third = await review(app, id);
    const fresh = await decide(app, id, 'approve', third.body.review?.nonce);
    expect(fresh.response.status).toBe(200);
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });

  test('target revalidation still runs on the native path: a changed target refuses the grant', async () => {
    const { app, channel } = setup();
    const commitApproval = vi.fn(async () => {});
    const { id } = createTransaction(channel!, {
      commitApproval,
      // The reviewed tree is no longer the decided tree.
      revalidateTarget: async () => ({
        kind: 'native-broker-test',
        subject: 'demo-plugin',
        fingerprint: JSON.stringify({ digest: 'sha256:CHANGED' }),
      }),
    });
    const { body } = await review(app, id);

    const decided = await decide(app, id, 'approve', body.review?.nonce);
    expect(decided.response.status).not.toBe(200);
    expect(commitApproval).not.toHaveBeenCalled();
  });

  // Scope note (review round 1): this proves the ROUTES do not consult
  // listener state for an already-created transaction — which is what the
  // header claims. It deliberately creates through the store rather than a
  // production creator, because both creators still refuse while the
  // listener is down (station#3731). A test that dressed this up as
  // end-to-end listener independence would be asserting a capability the
  // product does not have.
  test('the browser LISTENER being down does not refuse an already-created transaction on the native path', async () => {
    const { app, channel } = setup();
    channel!.markUnavailable('port in use');
    const { id } = createTransaction(channel!);

    const reviewed = await review(app, id);
    expect(reviewed.response.status).toBe(200);

    const decided = await decide(
      app,
      id,
      'approve',
      reviewed.body.review?.nonce,
    );
    expect(decided.response.status).toBe(200);
  });

  test('eligibility answers the authority question the host capability cannot (station#3677 PR 3)', async () => {
    const { app } = setup();
    // The one credential the two routes below admit.
    expect((await eligibility(app, 'local-grant')).eligible).toBe(true);
    // Same possession, JS-resident custody: not eligible, and the client
    // must therefore keep using the distinct-origin consent page.
    expect((await eligibility(app, 'ui-bootstrap')).eligible).toBe(false);
    // A paired phone or a desktop app on a REMOTE Station: neither mint
    // stamp, so the native path would 403 — say so BEFORE the click.
    expect((await eligibility(app, 'unbound')).eligible).toBe(false);

    // No consent channel on this runtime: the native path cannot work here
    // either, so eligibility is false rather than a promise the review
    // route would refuse with a 503.
    const { app: channelless } = setup({ withChannel: false });
    expect((await eligibility(channelless, 'local-grant')).eligible).toBe(
      false,
    );
  });

  test('eligibility agrees with what the routes actually enforce, for every caller kind', async () => {
    const { app, channel } = setup();
    for (const caller of ['local-grant', 'ui-bootstrap', 'unbound'] as const) {
      const { id } = createTransaction(channel!);
      const claimed = (await eligibility(app, caller)).eligible;
      const enforced = (await review(app, id, caller)).response.status === 200;
      // A claim that disagrees with enforcement is the label-vs-derivation
      // failure this endpoint exists to avoid.
      expect(claimed).toBe(enforced);
    }
  });

  test('a missing or malformed decision is refused before the store is touched', async () => {
    const { app, channel } = setup();
    const { id, commitApproval } = createTransaction(channel!);
    await review(app, id);

    const bad = await decide(app, id, 'yes-please', 'whatever');
    expect(bad.response.status).toBe(400);
    const missingNonce = await decide(app, id, 'approve', undefined);
    expect(missingNonce.response.status).toBe(400);
    expect(commitApproval).not.toHaveBeenCalled();
  });
});
