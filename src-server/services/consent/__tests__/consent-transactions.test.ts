import { describe, expect, test, vi } from 'vitest';
import {
  ConsentCommitRefusedError,
  type ConsentEffectProjection,
  type ConsentTargetSnapshot,
  ConsentTransactionStore,
  LOCAL_CONSENT_TENANT,
} from '../consent-transactions.js';

const TENANT = LOCAL_CONSENT_TENANT;

function target(fingerprint = 'fp-1'): ConsentTargetSnapshot {
  return { kind: 'plugin-trusted-permissions', subject: 'demo', fingerprint };
}

function makeInit(
  overrides: Partial<{
    revalidateTarget: () => Promise<ConsentTargetSnapshot | null>;
    commitApproval: () => Promise<ConsentEffectProjection> | Promise<void>;
    guardDecision: <T>(fn: () => Promise<T>) => Promise<T>;
    requesterId: string;
    rateKey: string;
    fingerprint: string;
  }> = {},
) {
  const commitApproval = overrides.commitApproval ?? vi.fn(async () => {});
  const revalidateTarget =
    overrides.revalidateTarget ??
    (async () => target(overrides.fingerprint ?? 'fp-1'));
  return {
    init: {
      tenantId: TENANT,
      target: target(overrides.fingerprint ?? 'fp-1'),
      description: {
        title: 'Trust Demo?',
        summary: 'Summary.',
        items: [{ label: 'plugin.server', detail: 'Runs server code' }],
        approveLabel: 'Approve',
        denyLabel: 'Deny',
      },
      requester: { kind: 'plugin-ui', id: overrides.requesterId ?? 'demo' },
      rateKey: overrides.rateKey ?? 'authenticated-surface',
      revalidateTarget,
      commitApproval,
      ...(overrides.guardDecision
        ? { guardDecision: overrides.guardDecision }
        : {}),
    },
    commitApproval,
  };
}

describe('ConsentTransactionStore', () => {
  test('creates a pending transaction and never exposes the session secret through get()', () => {
    const store = new ConsentTransactionStore();
    const { init } = makeInit();
    const created = store.create(init);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = store.get(TENANT, created.transaction.id);
    expect(view?.status).toBe('pending');
    expect(JSON.stringify(view)).not.toContain(
      store.decisionSessionSecretFor(TENANT, created.transaction.id),
    );
  });

  test('decision session secrets verify timing-safely and only for their own transaction', () => {
    const store = new ConsentTransactionStore();
    const { init } = makeInit();
    const a = store.create(init);
    const b = store.create(makeInit({ fingerprint: 'fp-2' }).init);
    if (!a.ok || !b.ok) throw new Error('setup failed');
    const secretA = store.decisionSessionSecretFor(TENANT, a.transaction.id)!;
    expect(store.verifyDecisionSession(TENANT, a.transaction.id, secretA)).toBe(
      true,
    );
    expect(store.verifyDecisionSession(TENANT, b.transaction.id, secretA)).toBe(
      false,
    );
    expect(
      store.verifyDecisionSession(TENANT, a.transaction.id, 'X'.repeat(43)),
    ).toBe(false);
  });

  test('rate-limits creation per AUTHENTICATED rate key while other rate keys continue', () => {
    const store = new ConsentTransactionStore();
    for (let i = 0; i < 10; i += 1) {
      expect(store.create(makeInit({ fingerprint: `fp-${i}` }).init).ok).toBe(
        true,
      );
    }
    const spammed = store.create(makeInit({ fingerprint: 'fp-11' }).init);
    expect(spammed).toEqual({ ok: false, reason: 'rate_limited' });
    const other = store.create(
      makeInit({ rateKey: 'other-principal', fingerprint: 'fp-o' }).init,
    );
    expect(other.ok).toBe(true);
  });

  test('INJECTION (review MED 5): varying the caller-supplied requester attribution does NOT mint a fresh budget', () => {
    // Independently proves: the limit keys on the authenticated rateKey, not
    // the display attribution — a caller who can vary `requester.id` (a
    // plugin naming other plugins in its request body) exhausts ONE budget.
    const store = new ConsentTransactionStore();
    for (let i = 0; i < 10; i += 1) {
      expect(
        store.create(
          makeInit({ requesterId: `victim-${i}`, fingerprint: `fp-${i}` }).init,
        ).ok,
      ).toBe(true);
    }
    const churned = store.create(
      makeInit({ requesterId: 'victim-fresh', fingerprint: 'fp-fresh' }).init,
    );
    expect(churned).toEqual({ ok: false, reason: 'rate_limited' });
  });

  test('the rate key is tenant-scoped: the same key in another tenant has its own budget', () => {
    const store = new ConsentTransactionStore();
    for (let i = 0; i < 10; i += 1) {
      expect(store.create(makeInit({ fingerprint: `fp-${i}` }).init).ok).toBe(
        true,
      );
    }
    expect(store.create(makeInit({ fingerprint: 'fp-11' }).init)).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    const otherTenant = store.create({
      ...makeInit({ fingerprint: 'fp-t2' }).init,
      tenantId: 'tenant-2',
    });
    expect(otherTenant.ok).toBe(true);
  });

  test('bounds pending capacity per tenant', () => {
    const store = new ConsentTransactionStore();
    for (let i = 0; i < 100; i += 1) {
      const result = store.create(
        makeInit({ rateKey: `principal-${i}`, fingerprint: `fp-${i}` }).init,
      );
      expect(result.ok).toBe(true);
    }
    expect(
      store.create(
        makeInit({ rateKey: 'principal-over', fingerprint: 'fp-x' }).init,
      ),
    ).toEqual({ ok: false, reason: 'capacity' });
  });

  test('tenant partitioning: a transaction is invisible to another tenant', () => {
    const store = new ConsentTransactionStore();
    const created = store.create(makeInit().init);
    if (!created.ok) throw new Error('setup failed');
    expect(store.get('other-tenant', created.transaction.id)).toBeUndefined();
    expect(
      store.verifyDecisionSession(
        'other-tenant',
        created.transaction.id,
        store.decisionSessionSecretFor(TENANT, created.transaction.id) ?? '',
      ),
    ).toBe(false);
  });

  test('dedupe finds an identical pending target, not a different fingerprint', () => {
    const store = new ConsentTransactionStore();
    const created = store.create(makeInit().init);
    if (!created.ok) throw new Error('setup failed');
    expect(store.findPendingByTarget(TENANT, target('fp-1'))?.id).toBe(
      created.transaction.id,
    );
    expect(store.findPendingByTarget(TENANT, target('fp-2'))).toBeUndefined();
  });

  test('the happy path: render mints a nonce, decide approves once and commits once', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const decided = await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided).toEqual({ ok: true, status: 'approved' });
    expect(commitApproval).toHaveBeenCalledTimes(1);
    expect(store.get(TENANT, id)?.status).toBe('approved');
    expect(store.auditTrail(TENANT, id).map((event) => event.event)).toEqual([
      'created',
      'review-rendered',
      'approved',
    ]);
  });

  test.each(['completed', 'winding-down', 'incomplete'] as const)(
    'retains the approved domain effect projection for %s status reads',
    async (status) => {
      const store = new ConsentTransactionStore();
      const effect: ConsentEffectProjection = {
        status,
        operationId: `operation-${status}`,
        generation: 7,
        ...(status === 'completed'
          ? { effects: ['provider-activation'] }
          : status === 'incomplete'
            ? { failures: ['provider-retirement'] }
            : {}),
      };
      const { init } = makeInit({
        commitApproval: vi.fn(async () => effect),
      });
      const created = store.create(init);
      if (!created.ok) throw new Error('setup failed');
      const rendered = store.renderReview(TENANT, created.transaction.id);
      if (!rendered.ok) throw new Error('render failed');

      await expect(
        store.decide(
          TENANT,
          created.transaction.id,
          'approved',
          rendered.nonce,
          'operator-credential',
        ),
      ).resolves.toEqual({ ok: true, status: 'approved' });
      expect(store.get(TENANT, created.transaction.id)).toMatchObject({
        status: 'approved',
        effect,
      });
    },
  );

  test('denial never calls the commit callback', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const rendered = store.renderReview(TENANT, created.transaction.id);
    if (!rendered.ok) throw new Error('setup failed');
    const decided = await store.decide(
      TENANT,
      created.transaction.id,
      'denied',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided).toEqual({ ok: true, status: 'denied' });
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('a decision without a rendered nonce is refused', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const decided = await store.decide(
      TENANT,
      created.transaction.id,
      'approved',
      undefined,
      'operator-credential',
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.reason).toBe('nonce_missing');
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('nonce consumption is atomic: a consumed nonce never works again, even when the failed attempt granted nothing', async () => {
    const store = new ConsentTransactionStore();
    const commitApproval = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ConsentCommitRefusedError('store down'))
      .mockResolvedValue(undefined);
    const { init } = makeInit({ commitApproval });
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    if (!rendered.ok) throw new Error('setup failed');

    // First decision: every check passes but the commit refuses. The
    // transaction stays PENDING (retryable) — and the nonce is already gone.
    const first = await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(first).toMatchObject({ ok: false, reason: 'commit_refused' });
    expect(store.get(TENANT, id)?.status).toBe('pending');

    // Replaying the SAME nonce is refused: consumption happened atomically
    // before the commit ran, so a refused attempt cannot be replayed.
    const replay = await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(replay).toMatchObject({ ok: false, reason: 'nonce_invalid' });
    expect(commitApproval).toHaveBeenCalledTimes(1);

    // Re-rendering mints a fresh nonce; the retry then succeeds.
    const rerendered = store.renderReview(TENANT, id);
    if (!rerendered.ok) throw new Error('re-render failed');
    const retried = await store.decide(
      TENANT,
      id,
      'approved',
      rerendered.nonce,
      'operator-credential',
    );
    expect(retried).toEqual({ ok: true, status: 'approved' });
  });

  test('re-rendering the review invalidates the earlier nonce', async () => {
    const store = new ConsentTransactionStore();
    const { init } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const first = store.renderReview(TENANT, id);
    const second = store.renderReview(TENANT, id);
    if (!first.ok || !second.ok) throw new Error('setup failed');
    const stale = await store.decide(
      TENANT,
      id,
      'approved',
      first.nonce,
      'operator-credential',
    );
    expect(stale).toMatchObject({ ok: false, reason: 'nonce_invalid' });
  });

  test('concurrent decisions cannot race: the in-flight marker refuses the second synchronously', async () => {
    const store = new ConsentTransactionStore();
    let releaseRevalidate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRevalidate = resolve;
    });
    const { init, commitApproval } = makeInit({
      revalidateTarget: async () => {
        await gate;
        return target('fp-1');
      },
    });
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    if (!rendered.ok) throw new Error('setup failed');

    const firstDecision = store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    // While the first decision awaits revalidation, a concurrent attempt is
    // refused — the in-flight marker (and nonce consumption) were set
    // synchronously before the first await.
    const concurrent = await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(concurrent.ok).toBe(false);
    releaseRevalidate();
    expect(await firstDecision).toEqual({ ok: true, status: 'approved' });
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });

  test('the TOCTOU refusal: a target that changed between request and decision grants nothing', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit({
      revalidateTarget: async () => target('fp-CHANGED'),
    });
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const rendered = store.renderReview(TENANT, created.transaction.id);
    if (!rendered.ok) throw new Error('setup failed');
    const decided = await store.decide(
      TENANT,
      created.transaction.id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.reason).toBe('target_changed');
    expect(decided.detail).toContain('changed');
    expect(commitApproval).not.toHaveBeenCalled();
    expect(store.get(TENANT, created.transaction.id)?.status).toBe('pending');
  });

  test('a vanished target refuses with the revalidation reason', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit({
      revalidateTarget: async () => null,
    });
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const rendered = store.renderReview(TENANT, created.transaction.id);
    if (!rendered.ok) throw new Error('setup failed');
    const decided = await store.decide(
      TENANT,
      created.transaction.id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided).toMatchObject({ ok: false, reason: 'target_changed' });
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('expiry: a transaction past its TTL refuses render and decide', async () => {
    let now = 1_000_000;
    const store = new ConsentTransactionStore({ now: () => now });
    const { init, commitApproval } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    if (!rendered.ok) throw new Error('setup failed');
    now += 5 * 60_000 + 1;
    expect(store.get(TENANT, id)?.status).toBe('expired');
    expect(store.renderReview(TENANT, id)).toMatchObject({
      ok: false,
      reason: 'not_pending',
      status: 'expired',
    });
    const decided = await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(commitApproval).not.toHaveBeenCalled();
  });

  test('INJECTION (review HIGH 2): TTL elapsing mid-decision with a concurrent status poll cannot flip the record, and the decision cannot commit over a terminal state', async () => {
    // Independently proves: (a) `get()` is a pure reader — polling during an
    // in-flight decision mutates nothing; (b) the sweep skips in-flight
    // records, so another tenant write cannot expire them; (c) the decision,
    // whose expiry was evaluated once at entry, completes as `approved` and
    // is never overwritten to `expired` (nor vice versa). Pre-fix, the poll
    // ran the mutating sweep, flipped the record to `expired`, and the
    // resuming decision overwrote the terminal state to `approved`.
    let now = 1_000_000;
    const store = new ConsentTransactionStore({ now: () => now });
    let releaseRevalidate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRevalidate = resolve;
    });
    const { init, commitApproval } = makeInit({
      revalidateTarget: async () => {
        await gate;
        return target('fp-1');
      },
    });
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    if (!rendered.ok) throw new Error('setup failed');

    const decision = store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    // The TTL elapses while the decision awaits revalidation.
    now += 5 * 60_000 + 1;
    // The main-origin status poll runs concurrently. An in-flight decision
    // owns the record: the poll reads `pending`, and writes nothing.
    expect(store.get(TENANT, id)?.status).toBe('pending');
    // A write-path sweep (another creation on the same tenant) runs too —
    // it must skip the in-flight record.
    expect(
      store.create(makeInit({ rateKey: 'other', fingerprint: 'fp-2' }).init).ok,
    ).toBe(true);
    expect(store.get(TENANT, id)?.status).toBe('pending');

    releaseRevalidate();
    expect(await decision).toEqual({ ok: true, status: 'approved' });
    expect(commitApproval).toHaveBeenCalledTimes(1);
    // The terminal state stands; nothing ever recorded `expired` for it.
    expect(store.get(TENANT, id)?.status).toBe('approved');
    expect(
      store.auditTrail(TENANT, id).map((event) => event.event),
    ).not.toContain('expired');
  });

  test('review MED 3: the render budget bounds nonce re-minting, and the last minted nonce still decides', async () => {
    const store = new ConsentTransactionStore();
    const { init } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    let lastNonce = '';
    for (let i = 0; i < 30; i += 1) {
      const rendered = store.renderReview(TENANT, id);
      expect(rendered.ok).toBe(true);
      if (rendered.ok) lastNonce = rendered.nonce;
    }
    // The 31st render refuses — an attacker forcing navigations can no
    // longer invalidate the user's open review page indefinitely.
    expect(store.renderReview(TENANT, id)).toMatchObject({
      ok: false,
      reason: 'render_limited',
    });
    // And the refusal did NOT invalidate the most recently minted nonce.
    const decided = await store.decide(
      TENANT,
      id,
      'approved',
      lastNonce,
      'operator-credential',
    );
    expect(decided).toEqual({ ok: true, status: 'approved' });
  });

  test('review MED 3: the audit trail is bounded and keeps creation provenance', async () => {
    const store = new ConsentTransactionStore();
    const { init } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    for (let i = 0; i < 250; i += 1) {
      await store.decide(TENANT, id, 'approved', 'bogus', 'consent-session');
    }
    const audit = store.auditTrail(TENANT, id);
    expect(audit.length).toBeLessThanOrEqual(100);
    expect(audit[0]?.event).toBe('created');
    expect(audit.at(-1)?.event).toBe('decision-refused');
  });

  test('review HIGH 1: the revalidate → commit span runs inside the creator-supplied decision guard', async () => {
    const events: string[] = [];
    let guardDepth = 0;
    const { init, commitApproval } = makeInit({
      guardDecision: async <T>(fn: () => Promise<T>): Promise<T> => {
        guardDepth += 1;
        events.push('guard-enter');
        try {
          return await fn();
        } finally {
          guardDepth -= 1;
          events.push('guard-exit');
        }
      },
      revalidateTarget: async () => {
        events.push(`revalidate@depth=${guardDepth}`);
        return target('fp-1');
      },
      commitApproval: vi.fn(async () => {
        events.push(`commit@depth=${guardDepth}`);
      }),
    });
    const store = new ConsentTransactionStore();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const rendered = store.renderReview(TENANT, created.transaction.id);
    if (!rendered.ok) throw new Error('setup failed');
    const decided = await store.decide(
      TENANT,
      created.transaction.id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    expect(decided).toEqual({ ok: true, status: 'approved' });
    expect(commitApproval).toHaveBeenCalledTimes(1);
    // Both the revalidation and the commit executed while the guard was held.
    expect(events).toEqual([
      'guard-enter',
      'revalidate@depth=1',
      'commit@depth=1',
      'guard-exit',
    ]);
  });

  test('an already-decided transaction refuses further decisions', async () => {
    const store = new ConsentTransactionStore();
    const { init, commitApproval } = makeInit();
    const created = store.create(init);
    if (!created.ok) throw new Error('setup failed');
    const id = created.transaction.id;
    const rendered = store.renderReview(TENANT, id);
    if (!rendered.ok) throw new Error('setup failed');
    await store.decide(
      TENANT,
      id,
      'approved',
      rendered.nonce,
      'operator-credential',
    );
    const rerendered = store.renderReview(TENANT, id);
    expect(rerendered).toMatchObject({ ok: false, reason: 'not_pending' });
    const again = await store.decide(
      TENANT,
      id,
      'denied',
      'anything',
      'operator-credential',
    );
    expect(again).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(commitApproval).toHaveBeenCalledTimes(1);
  });
});
