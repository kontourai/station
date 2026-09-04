/**
 * ConsentTransaction — the server-side record behind every authority-bearing
 * approval (archive#3677).
 *
 * One transaction per pending decision. The decision itself is only reachable
 * through the distinct-origin consent listener
 * (`src-server/runtime/consent/consent-listener.ts`); this module owns the
 * lifecycle facts that make that surface trustworthy:
 *
 *  - a target snapshot (what would be granted), re-derived immediately before
 *    granting — a target that changed between request and decision refuses
 *    with the revalidation reason instead of granting something the user
 *    never reviewed;
 *  - a canonical human-readable description — the review page renders text
 *    derived from the transaction and nothing else;
 *  - requester attribution, expiry, and a bounded audit trail;
 *  - an ATOMIC pending → approved/denied/expired transition: the in-flight
 *    marker and the nonce are consumed synchronously before the first await,
 *    so a concurrent second decision can never race past the first; expiry
 *    is evaluated once at decision entry and readers PROJECT it rather than
 *    write it, so a status poll can never flip a record mid-decision;
 *  - a ONE-USE render nonce minted when the review page renders. Sec-Fetch
 *    headers prove a navigation happened under user activation — the nonce is
 *    what proves the decision came FROM the rendered review page.
 *
 * The store is tenant-partitioned: hosted ingress is authority-significant,
 * so there is deliberately no process-global request map — every lookup is
 * scoped by the tenant that created the transaction. Non-hosted runtimes use
 * {@link LOCAL_CONSENT_TENANT}.
 *
 * Same-origin plugin code can still SPAM request creation, so creation is
 * bounded (pending capacity per tenant) and rate-limited per AUTHENTICATED
 * rate key (never per caller-supplied attribution — review MED 5) — the
 * review surface must stay legible under that pressure.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export const LOCAL_CONSENT_TENANT = 'local';

export const CONSENT_TRANSACTION_TTL_MS = 5 * 60_000;
const CONSENT_RETENTION_MS = CONSENT_TRANSACTION_TTL_MS * 2;
const MAX_PENDING_PER_TENANT = 100;
const CREATE_RATE_LIMIT = 10;
const CREATE_RATE_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 1024;
/**
 * Review MED 3: every review render re-mints the one-use nonce, which
 * invalidates the nonce on any already-open review page. A same-site page
 * that can force navigations could otherwise deny consent indefinitely by
 * re-rendering forever. The budget bounds that to a small, human-plausible
 * number per transaction; a transaction that exhausts it must be re-opened.
 */
export const MAX_REVIEW_RENDERS = 30;
/**
 * Review MED 3: the audit trail is bounded. When full, the oldest entry
 * AFTER the initial `created` event is dropped, so creation provenance and
 * the most recent history are both retained.
 */
export const MAX_AUDIT_EVENTS = 100;

export type ConsentTransactionStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired';
export type ConsentDecision = 'approved' | 'denied';

/** Exactly what would be granted, in a canonically comparable form. */
export interface ConsentTargetSnapshot {
  /** The grant family, e.g. `plugin-trusted-permissions`. */
  readonly kind: string;
  /** The subject inside that family, e.g. the plugin name. */
  readonly subject: string;
  /**
   * Canonical serialization of the reviewed grant. Re-derived by
   * `revalidateTarget` immediately before granting; any byte difference
   * refuses the decision.
   */
  readonly fingerprint: string;
}

export interface ConsentDescriptionItem {
  readonly label: string;
  readonly detail: string;
}

/** The canonical human-readable description the review page renders. */
export interface ConsentDescription {
  readonly title: string;
  readonly summary: string;
  readonly items: readonly ConsentDescriptionItem[];
  readonly warning?: string;
  readonly approveLabel: string;
  readonly denyLabel: string;
}

export interface ConsentRequesterAttribution {
  /** Who asked, e.g. `plugin-ui`. */
  readonly kind: string;
  readonly id: string;
}

/** Bounded, value-free projection of the domain effect committed by consent. */
export interface ConsentEffectProjection {
  readonly status: 'completed' | 'winding-down' | 'incomplete' | 'superseded';
  readonly operationId: string;
  readonly generation: number;
  readonly effects?: readonly string[];
  readonly failures?: readonly string[];
}

export interface ConsentAuditEvent {
  readonly at: number;
  readonly event:
    | 'created'
    | 'review-rendered'
    | 'decision-refused'
    | 'approved'
    | 'denied'
    | 'expired';
  readonly detail?: string;
}

/**
 * Thrown by a `commitApproval` callback to surface a safe, human-readable
 * refusal (e.g. "grants store unavailable") without granting anything. Any
 * other throw is reported generically.
 */
export class ConsentCommitRefusedError extends Error {
  constructor(
    public readonly safeDetail: string,
    public readonly retryable: boolean = true,
  ) {
    super(safeDetail);
    this.name = 'ConsentCommitRefusedError';
  }
}

export interface ConsentTransactionInit {
  readonly tenantId: string;
  readonly target: ConsentTargetSnapshot;
  readonly description: ConsentDescription;
  readonly requester: ConsentRequesterAttribution;
  /**
   * The AUTHENTICATED principal the creation rate limit is charged to,
   * scoped per tenant by the store. Review MED 5: {@link requester} is
   * display/audit attribution and may repeat caller-supplied strings (a
   * plugin names itself in its own request body), so it must never key the
   * rate limit — a caller who can vary the attribution would mint itself a
   * fresh budget per name. Creating routes must derive this from the
   * authenticated surface the request actually passed (their route scope /
   * verified principal), never from a request body field.
   */
  readonly rateKey: string;
  readonly ttlMs?: number;
  /**
   * Re-derives the target immediately before granting. `null` means the
   * target no longer exists. A snapshot whose fingerprint differs from the
   * reviewed one refuses the decision.
   */
  readonly revalidateTarget: () => Promise<ConsentTargetSnapshot | null>;
  /** Commits the approval's domain effect. Runs only after every check passed. */
  readonly commitApproval: () =>
    | Promise<ConsentEffectProjection>
    | Promise<void>;
  /**
   * Review HIGH 1: mutual exclusion between target revalidation → grant
   * commit and whatever can mutate the target's content (for plugins, the
   * update/uninstall routes). `decide` runs the whole
   * revalidate → commit → terminal-write span inside this guard, so a
   * mutation cannot interleave between the fingerprint check and the grant.
   * Absent, the span runs unguarded (targets with no concurrent mutator).
   */
  readonly guardDecision?: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface ConsentTransactionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly target: ConsentTargetSnapshot;
  readonly description: ConsentDescription;
  readonly requester: ConsentRequesterAttribution;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: ConsentTransactionStatus;
  /** One-use render nonce; replaced on each review render, cleared on use. */
  renderNonce?: string;
  /** Review MED 3: renders consumed against {@link MAX_REVIEW_RENDERS}. */
  renderCount: number;
  /** Set synchronously at decision entry; blocks concurrent decisions. */
  decisionInFlight: boolean;
  decidedAt?: number;
  decidedVia?: ConsentDecisionAuthority;
  effect?: ConsentEffectProjection;
  /** Transaction-bound decision-session secret (the `station-consent` cookie). */
  readonly decisionSessionSecret: string;
  readonly revalidateTarget: () => Promise<ConsentTargetSnapshot | null>;
  readonly commitApproval: () =>
    | Promise<ConsentEffectProjection>
    | Promise<void>;
  readonly guardDecision?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly audit: ConsentAuditEvent[];
}

/** How the decision authority was proven at the consent listener. */
export type ConsentDecisionAuthority =
  | 'operator-credential'
  | 'device-consent-scope'
  | 'consent-session'
  /**
   * archive#3677 PR 3: the native broker's arm — proven by the request
   * principal's mint-time `home-possession` locality stamp (the per-boot
   * owner-only local-grant secret was presented at mint), read through the
   * one bound predicate (`isBoundRuntimeLocalOperator`). Distinct from
   * `operator-credential` because the proof is possession-at-mint, not the
   * operator credential file itself.
   */
  | 'native-host';

export interface ConsentTransactionView {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ConsentTransactionStatus;
  readonly target: ConsentTargetSnapshot;
  readonly description: ConsentDescription;
  readonly requester: ConsentRequesterAttribution;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly effect?: ConsentEffectProjection;
}

export type ConsentCreateResult =
  | { readonly ok: true; readonly transaction: ConsentTransactionView }
  | { readonly ok: false; readonly reason: 'capacity' | 'rate_limited' };

export type ConsentRenderResult =
  | {
      readonly ok: true;
      readonly nonce: string;
      readonly transaction: ConsentTransactionView;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_pending' | 'render_limited';
      readonly status?: ConsentTransactionStatus;
    };

export type ConsentDecideRefusalReason =
  | 'not_found'
  | 'not_pending'
  | 'decision_in_flight'
  | 'nonce_missing'
  | 'nonce_invalid'
  | 'target_changed'
  | 'commit_refused';

export type ConsentDecideResult =
  | { readonly ok: true; readonly status: ConsentDecision }
  | {
      readonly ok: false;
      readonly reason: ConsentDecideRefusalReason;
      readonly status?: ConsentTransactionStatus;
      readonly detail?: string;
    };

/** Length-independent, timing-safe secret comparison. */
function secretEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Review HIGH 2: expiry is PROJECTED for readers, never written by them. A
 * pending record past its TTL reads as `expired` without mutating anything,
 * so a status poll can never race a decision into overwriting a terminal
 * state. The stored status only changes on write paths (`create`,
 * `renderReview`, `decide` — via {@link ConsentTransactionStore.#sweep}) and
 * never while a decision is in flight: a decision's expiry was evaluated
 * once, at decision entry, and the record is the decision's alone until it
 * settles (an in-flight record therefore still reads `pending` here).
 */
function effectiveStatus(
  record: ConsentTransactionRecord,
  now: number,
): ConsentTransactionStatus {
  return record.status === 'pending' &&
    !record.decisionInFlight &&
    now >= record.expiresAt
    ? 'expired'
    : record.status;
}

function viewOf(
  record: ConsentTransactionRecord,
  now: number,
): ConsentTransactionView {
  return {
    id: record.id,
    tenantId: record.tenantId,
    status: effectiveStatus(record, now),
    target: record.target,
    description: record.description,
    requester: record.requester,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.effect ? { effect: structuredClone(record.effect) } : {}),
  };
}

export class ConsentTransactionStore {
  readonly #tenants = new Map<string, Map<string, ConsentTransactionRecord>>();
  /** Bounded creation timestamps per requester key (sliding window). */
  readonly #creations = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #tenant(tenantId: string): Map<string, ConsentTransactionRecord> {
    let records = this.#tenants.get(tenantId);
    if (!records) {
      records = new Map();
      this.#tenants.set(tenantId, records);
    }
    return records;
  }

  /**
   * Lazily expires and prunes, mirroring the retention the old route used.
   * Called from WRITE paths only (`create`, `renderReview`, `decide`) —
   * review HIGH 2: `get()` used to run this, which let a concurrent status
   * poll flip a record to `expired` while a decision was mid-flight, and the
   * resuming decision then overwrote the terminal state. Readers now project
   * expiry ({@link effectiveStatus}) instead of writing it — and a record
   * whose decision is in flight belongs to that decision alone: the sweep
   * neither expires nor prunes it.
   */
  #sweep(tenantId: string): void {
    const timestamp = this.#now();
    const records = this.#tenants.get(tenantId);
    if (!records) return;
    for (const [id, record] of records) {
      if (record.decisionInFlight) continue;
      if (record.status === 'pending' && timestamp >= record.expiresAt) {
        record.status = 'expired';
        record.renderNonce = undefined;
        this.#pushAudit(record, { at: timestamp, event: 'expired' });
      }
      if (timestamp - record.createdAt >= CONSENT_RETENTION_MS) {
        records.delete(id);
      }
    }
    if (records.size === 0) this.#tenants.delete(tenantId);
  }

  /** Bounded audit append: keeps `created` plus the most recent history. */
  #pushAudit(record: ConsentTransactionRecord, event: ConsentAuditEvent): void {
    if (record.audit.length >= MAX_AUDIT_EVENTS) {
      record.audit.splice(1, 1);
    }
    record.audit.push(event);
  }

  #consumeCreationBudget(tenantId: string, rateKey: string): boolean {
    // Review MED 5: keyed by tenant + the AUTHENTICATED rate key the creating
    // route supplied — never by the display attribution, which can repeat
    // caller-controlled strings.
    const key = `${tenantId}\u0000${rateKey}`;
    const timestamp = this.#now();
    const window = (this.#creations.get(key) ?? []).filter(
      (at) => timestamp - at < CREATE_RATE_WINDOW_MS,
    );
    if (window.length >= CREATE_RATE_LIMIT) {
      this.#creations.set(key, window);
      return false;
    }
    window.push(timestamp);
    this.#creations.set(key, window);
    // Bound the key map itself: drop the stalest key rather than growing
    // without limit under a requester-id-churning spam pattern.
    if (this.#creations.size > MAX_RATE_KEYS) {
      const oldest = this.#creations.keys().next().value;
      if (oldest !== undefined) this.#creations.delete(oldest);
    }
    return true;
  }

  create(init: ConsentTransactionInit): ConsentCreateResult {
    this.#sweep(init.tenantId);
    const records = this.#tenant(init.tenantId);
    let pending = 0;
    for (const record of records.values()) {
      if (record.status === 'pending') pending += 1;
    }
    if (pending >= MAX_PENDING_PER_TENANT) {
      return { ok: false, reason: 'capacity' };
    }
    if (!this.#consumeCreationBudget(init.tenantId, init.rateKey)) {
      return { ok: false, reason: 'rate_limited' };
    }
    const createdAt = this.#now();
    const record: ConsentTransactionRecord = {
      id: randomUUID(),
      tenantId: init.tenantId,
      target: init.target,
      description: init.description,
      requester: init.requester,
      createdAt,
      expiresAt: createdAt + (init.ttlMs ?? CONSENT_TRANSACTION_TTL_MS),
      status: 'pending',
      renderCount: 0,
      decisionInFlight: false,
      decisionSessionSecret: randomBytes(32).toString('base64url'),
      revalidateTarget: init.revalidateTarget,
      commitApproval: init.commitApproval,
      guardDecision: init.guardDecision,
      audit: [{ at: createdAt, event: 'created' }],
    };
    records.set(record.id, record);
    return { ok: true, transaction: viewOf(record, createdAt) };
  }

  /** A still-pending transaction with the identical target, for dedupe. */
  findPendingByTarget(
    tenantId: string,
    target: ConsentTargetSnapshot,
  ): ConsentTransactionView | undefined {
    this.#sweep(tenantId);
    const now = this.#now();
    for (const record of this.#tenant(tenantId).values()) {
      if (
        effectiveStatus(record, now) === 'pending' &&
        record.target.kind === target.kind &&
        record.target.subject === target.subject &&
        record.target.fingerprint === target.fingerprint
      ) {
        return viewOf(record, now);
      }
    }
    return undefined;
  }

  /**
   * Pure reader — review HIGH 2: no sweep, no mutation of any kind. The
   * main-origin status poll calls this concurrently with decisions; a reader
   * with a side effect is what made expiry raceable.
   */
  get(tenantId: string, id: string): ConsentTransactionView | undefined {
    const record = this.#tenants.get(tenantId)?.get(id);
    return record ? viewOf(record, this.#now()) : undefined;
  }

  /**
   * The transaction-bound decision-session secret (`station-consent` cookie
   * value), for the creating route to hand to the verified requester. Never
   * exposed through {@link get}.
   */
  decisionSessionSecretFor(tenantId: string, id: string): string | undefined {
    const record = this.#tenants.get(tenantId)?.get(id);
    return record && effectiveStatus(record, this.#now()) === 'pending'
      ? record.decisionSessionSecret
      : undefined;
  }

  /** Timing-safe check that `candidate` is THIS transaction's session secret. */
  verifyDecisionSession(
    tenantId: string,
    id: string,
    candidate: string,
  ): boolean {
    const record = this.#tenants.get(tenantId)?.get(id);
    if (!record) return false;
    return secretEquals(record.decisionSessionSecret, candidate);
  }

  /**
   * Renders the review: mints the ONE-USE nonce. Re-rendering replaces the
   * previous nonce, so only the most recently rendered page can decide.
   */
  renderReview(tenantId: string, id: string): ConsentRenderResult {
    this.#sweep(tenantId);
    const record = this.#tenant(tenantId).get(id);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status !== 'pending') {
      return { ok: false, reason: 'not_pending', status: record.status };
    }
    if (record.renderCount >= MAX_REVIEW_RENDERS) {
      // Review MED 3: each render invalidates the previously minted nonce,
      // so unbounded re-rendering is a denial-of-consent primitive. Beyond
      // the budget the transaction refuses to render (it can still expire or
      // be re-opened); the previously minted nonce stays valid.
      return { ok: false, reason: 'render_limited', status: record.status };
    }
    record.renderCount += 1;
    const nonce = randomBytes(32).toString('base64url');
    record.renderNonce = nonce;
    this.#pushAudit(record, { at: this.#now(), event: 'review-rendered' });
    return { ok: true, nonce, transaction: viewOf(record, this.#now()) };
  }

  /**
   * The atomic decision. Everything that guards against a concurrent or
   * replayed decision happens synchronously before the first `await`:
   * status check, in-flight marker, and one-use nonce consumption. The target
   * is then revalidated; only an unchanged target commits.
   *
   * Any failure is a refusal with no partial state: the transaction returns
   * to (or stays in) a non-granted state, and a consumed nonce is never
   * restored — a refused decision requires re-rendering the review page.
   */
  async decide(
    tenantId: string,
    id: string,
    decision: ConsentDecision,
    presentedNonce: string | undefined,
    via: ConsentDecisionAuthority,
  ): Promise<ConsentDecideResult> {
    // Review HIGH 2: expiry is evaluated exactly ONCE per decision, here at
    // decision entry (the sweep flips a past-TTL record to `expired`, which
    // the status check below then refuses). From this point the record
    // belongs to this decision: readers project expiry without writing it,
    // and the sweep skips in-flight records — so nothing can flip the status
    // out from under the awaits below. The TTL therefore bounds when a
    // decision may BEGIN, not how long its commit may take.
    this.#sweep(tenantId);
    const record = this.#tenant(tenantId).get(id);
    if (!record) return { ok: false, reason: 'not_found' };
    const refuse = (
      reason: ConsentDecideRefusalReason,
      detail?: string,
    ): ConsentDecideResult => {
      this.#pushAudit(record, {
        at: this.#now(),
        event: 'decision-refused',
        detail: detail ?? reason,
      });
      return { ok: false, reason, status: record.status, detail };
    };
    if (record.status !== 'pending') {
      return refuse('not_pending');
    }
    if (record.decisionInFlight) {
      return refuse('decision_in_flight');
    }
    if (presentedNonce === undefined || presentedNonce.length === 0) {
      return refuse('nonce_missing');
    }
    const expectedNonce = record.renderNonce;
    // Consume BEFORE comparing outcomes diverge: a replayed nonce and a
    // never-rendered decision both land here with no usable nonce.
    record.renderNonce = undefined;
    if (
      expectedNonce === undefined ||
      !secretEquals(expectedNonce, presentedNonce)
    ) {
      return refuse('nonce_invalid');
    }
    record.decisionInFlight = true;
    try {
      // Review HIGH 1: the revalidate → commit span runs inside the
      // creator-supplied guard, so nothing that takes the same guard (the
      // plugin update/uninstall routes, for plugin targets) can swap the
      // target's content between the fingerprint check and the grant.
      const runGuarded =
        record.guardDecision ?? (<T>(fn: () => Promise<T>) => fn());
      return await runGuarded(async () => {
        const revalidated = await record.revalidateTarget();
        if (
          revalidated === null ||
          revalidated.kind !== record.target.kind ||
          revalidated.subject !== record.target.subject ||
          revalidated.fingerprint !== record.target.fingerprint
        ) {
          return refuse(
            'target_changed',
            revalidated === null
              ? 'The requested target no longer exists.'
              : 'The requested target changed after this review was opened. Nothing was granted — re-open the request to review the current state.',
          );
        }
        if (record.status !== 'pending') {
          // Defense in depth for review HIGH 2: unreachable while the sweep
          // skips in-flight records and no other writer exists, but a future
          // mutation path must find a refusal here, never a terminal-state
          // overwrite.
          return refuse('not_pending');
        }
        if (decision === 'denied') {
          record.status = 'denied';
          record.decidedAt = this.#now();
          record.decidedVia = via;
          this.#pushAudit(record, { at: record.decidedAt, event: 'denied' });
          return { ok: true, status: 'denied' } as const;
        }
        try {
          const effect = await record.commitApproval();
          if (effect) record.effect = structuredClone(effect);
        } catch (error) {
          if (error instanceof ConsentCommitRefusedError) {
            return refuse('commit_refused', error.safeDetail);
          }
          return refuse(
            'commit_refused',
            'The approval could not be committed.',
          );
        }
        record.status = 'approved';
        record.decidedAt = this.#now();
        record.decidedVia = via;
        this.#pushAudit(record, { at: record.decidedAt, event: 'approved' });
        return { ok: true, status: 'approved' } as const;
      });
    } finally {
      record.decisionInFlight = false;
    }
  }

  /** The append-only (bounded, see {@link MAX_AUDIT_EVENTS}) audit trail. */
  auditTrail(tenantId: string, id: string): readonly ConsentAuditEvent[] {
    return this.#tenants.get(tenantId)?.get(id)?.audit ?? [];
  }
}
