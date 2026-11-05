import { randomBytes } from 'node:crypto';
import type {
  LiveSurfaceAction,
  LiveSurfaceControlLease,
  LiveSurfaceController,
  LiveSurfaceEpochCause,
  LiveSurfaceInput,
  LiveSurfaceInputOrder,
  LiveSurfaceInputResult,
  LiveSurfacePointerButton,
  LiveSurfacePointerType,
  LiveSurfaceViewerId,
} from '@kontourai/station-contracts/live-surface';
import {
  type AgentController,
  type FencedLeaseResult,
  type HumanController,
  type LiveSurfaceControlLeaseOptions,
  LiveSurfaceControlLeaseState,
  type LiveSurfaceLeaseReader,
} from './control-lease.js';
import {
  type LiveSurfaceHeldInput,
  LiveSurfaceInputRefusal,
  type LiveSurfaceProducer,
} from './producer.js';
import { LiveSurfaceHub, type LiveSurfaceHubOptions } from './surface-hub.js';

/**
 * Decides whether an authenticated principal may `view`, send `input` to, or
 * `control` one surface (D5). The live-surface layer is host-neutral and knows
 * nothing about Projects: whoever registers a producer supplies this (the
 * Browser lane answers "operator or Project admin of the session's Project").
 * It must itself fail closed on any error; a throw here is treated as deny —
 * except `LiveSurfaceAuthorizerBusyError`, which says "cannot answer right
 * now" (#2433) and is never an admission either.
 */
export type LiveSurfaceAuthorizer = (
  principal: string,
  surfaceId: string,
  action: LiveSurfaceAction,
  context?: LiveSurfaceAuthorizationContext,
) => boolean | Promise<boolean>;

/**
 * Thrown by an authorizer that cannot answer RIGHT NOW (#2433): the thing it
 * must consult is briefly saturated (an SSH device host's AVD lookup queue).
 * It is neither an allow nor a deny. `decide` reports it as `busy`, so the
 * HTTP routes can answer a retryable 503 and a running stream can keep the
 * decision it already had; `authorize` (the boolean form) still reads it as
 * deny. Busy never grants anything that was not already granted.
 */
export class LiveSurfaceAuthorizerBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      'The live surface cannot be authorized right now; try again.',
      options,
    );
    this.name = 'LiveSurfaceAuthorizerBusyError';
  }
}

/** One authorization answer: `busy` is transient, never an admission. */
export type LiveSurfaceDecision = 'allow' | 'deny' | 'busy';

/**
 * What the caller can offer an authorizer beyond the principal (added by the
 * Browser pane lane): the HTTP routes pass the authenticated request, so an
 * authorizer whose standing depends on the credential itself (the Station
 * operator) can judge it. Absent on a server-side path with no request; an
 * authorizer that needs it must then deny.
 */
export interface LiveSurfaceAuthorizationContext {
  request?: Request;
  /**
   * A server-side agent path's verified authority (added by the browser
   * agent tools, #90 #122/#123). Opaque to this layer: only the producer's
   * own authorizer can recognise it, and it must refuse anything it did not
   * mint itself. Never built from tool input.
   */
  agentGrant?: object;
}

/**
 * Producers register here by surfaceId; the routes and server-side
 * automation look surfaces up here. With nothing registered every route is
 * inert (a typed `unknown-surface` 404).
 *
 * The lease is exposed READ-ONLY (`snapshot`, `isCurrent`, `onChange`):
 * automation captures the FENCE from `claimAgentControl` (`lease.fence`),
 * then checks `lease.isCurrent(fence, agent)` before and after every
 * operation, aborting
 * as "interrupted" when it fails. Every mutation of control goes through the
 * functions below, which authorize first.
 *
 * Notes for callers in other lanes:
 * - The agent identity (`principal`, `sessionId`) and `actingFor` MUST come
 *   from the VERIFIED calling session and its owner — never from tool
 *   arguments, request bodies, or anything the model wrote. An
 *   argument-supplied session id is not authority.
 * - A human's `device` id is minted per boot for non-device credentials (an
 *   HMAC under a per-boot key). It distinguishes clients NOW; history,
 *   audit records and persisted state must not treat it as stable.
 */
export interface LiveSurfaceEntry {
  readonly producer: LiveSurfaceProducer;
  readonly hub: LiveSurfaceHub;
  readonly lease: LiveSurfaceLeaseReader;
  /** Ends when this particular surface generation is unregistered. */
  readonly signal: AbortSignal;
  /** Join work that must stop when this surface is unregistered. */
  readonly onDispose: (dispose: () => Promise<void>) => () => void;
  /** Always answers; `authorize` from registration, or deny-all without one. */
  readonly authorize: (
    principal: string,
    action: LiveSurfaceAction,
    context?: LiveSurfaceAuthorizationContext,
  ) => Promise<boolean>;
  /**
   * The same decision, telling a transient `busy` apart from a deny (#2433).
   * Every other throw, and anything but `true`, is `deny`.
   */
  readonly decide: (
    principal: string,
    action: LiveSurfaceAction,
    context?: LiveSurfaceAuthorizationContext,
  ) => Promise<LiveSurfaceDecision>;
}

export interface LiveSurfaceRegistryOptions {
  hub?: LiveSurfaceHubOptions;
  lease?: LiveSurfaceControlLeaseOptions;
  /**
   * How long one `producer.dispatch` may take before the batch is refused as
   * `dispatch-failed`. A hung producer must never block the input chain.
   */
  dispatchTimeoutMs?: number;
  /**
   * How long after a controller's last viewer stream closes the server waits
   * before releasing what it pressed (and forgetting its viewer ids). A
   * replacement stream (new stream params, a reconnect) inside the window
   * keeps both.
   */
  viewerGraceMs?: number;
}

/**
 * Default replacement window for a closed viewer stream. A replacement
 * stream for new stream params attaches about 1 ms after the old one closes
 * (measured in process); a dropped connection's first reconnect comes after
 * the viewer's 500 ms backoff plus the Station probe and the frames request,
 * about 0.5 s plus two round trips. 2 s covers that with room for slow links.
 * The trade-off: while a viewer is gone for good, what it held (a key, a
 * button) stays down on the surface for up to this long before the server
 * releases it; a longer window would let a key auto-repeat for longer.
 */
const DEFAULT_VIEWER_GRACE_MS = 2_000;

export interface LiveSurfaceRegistration {
  /** Absent means every principal is denied every action. */
  authorize?: LiveSurfaceAuthorizer;
  /**
   * A person's EXPLICIT control action succeeded: the Take control button
   * (`claim`) or an explicit hand-back (`release`). Never called for a claim
   * by input or for a hold lapsing; those are not explicit. `fence` is the
   * lease's fence after the action.
   */
  onExplicitControl?: (event: {
    action: 'claim' | 'release';
    human: HumanController;
    fence: number;
  }) => void;
  /**
   * What a reset of this surface keeps: presses still held when the surface
   * is unregistered are carried to the next surface registered with the
   * same scope (a reopened session, a reconnected device), which releases
   * them through its producer before it takes any input. Defaults to the
   * surface id.
   */
  heldScope?: string;
  /**
   * The release cleanup has failed `CLEANUP_STUCK_AFTER` times in a row: a
   * key or button may be stuck. Called once each time the surface becomes
   * stuck; the host resets the surface (its existing reopen/reconnect).
   */
  onReleaseStuck?: () => void;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;

/** One controller, as a comparable string (who dispatched a press). */
function controllerKey(controller: LiveSurfaceController): string {
  return controller.kind === 'human'
    ? `human\u0000${controller.principal}\u0000${controller.device ?? ''}`
    : `agent\u0000${controller.principal}\u0000${controller.sessionId}`;
}

/** Which held button or key a down/up is about; null for anything else. */
function pressOf(
  event: LiveSurfaceInput,
):
  | { kind: 'button'; id: LiveSurfacePointerButton }
  | { kind: 'key'; id: string }
  | null {
  if (event.kind === 'pointer') {
    if (event.type !== 'down' && event.type !== 'up') return null;
    // A down/up with no `button` is the primary one (a raw client's touch
    // names none). Recording it as nothing would leave that press
    // uncancelled at a handoff (Device pane lane, #1970).
    return { kind: 'button', id: event.button ?? 'left' };
  }
  if (event.kind === 'key') return { kind: 'key', id: event.code || event.key };
  return null;
}

/**
 * What each controller holds down on the surface: the server's single
 * account of it. A press is recorded when it is SENT (before awaiting it),
 * so one still in flight, or one that timed out and lands later, is
 * accounted for. A release is forgotten only once the producer confirmed
 * it: one that failed or timed out may not have landed, so it stays held
 * and is marked for release. Whatever is marked (at a handoff, a lapse, an
 * abandoned viewer, a viewer's `release-pressed`, or such a failed release)
 * is cancelled by the surface's cleanup (`runCleanup`), never completed,
 * and input waits until it is.
 */
/** Held presses carried across an unregister (see `heldScope`). */
interface HeldCarry {
  buttons: [LiveSurfacePointerButton, HeldButton][];
  keys: [string, HeldKey][];
  pointer: { x: number; y: number };
  pointerType: LiveSurfacePointerType;
}
type HeldButton = {
  pointerType: LiveSurfacePointerType;
  owner: string;
  order?: LiveSurfaceInputOrder;
  releasing: boolean;
};
type HeldKey = {
  key: string;
  code: string;
  owner: string;
  order?: LiveSurfaceInputOrder;
  releasing: boolean;
};

class PressedInput {
  /**
   * Each held button: the pointer type its down was dispatched as, the
   * controller that dispatched it (so one controller's stuck press never
   * keeps a different holder live), the place in its sender's input order
   * of the batch that pressed it, and whether it is to be released.
   */
  private readonly buttons = new Map<LiveSurfacePointerButton, HeldButton>();
  private readonly keys = new Map<string, HeldKey>();
  private pointer = { x: 0, y: 0 };
  private pointerType: LiveSurfacePointerType = 'mouse';

  /** An event about to be sent: a press is held from now on. */
  sent(
    event: LiveSurfaceInput,
    controller: LiveSurfaceController,
    order?: LiveSurfaceInputOrder,
  ): void {
    const owner = controllerKey(controller);
    if (event.kind === 'pointer') {
      this.pointer = { x: event.x, y: event.y };
      if (event.type === 'down')
        this.pointerType = event.pointerType ?? 'mouse';
    }
    const press = pressOf(event);
    if (!press || !('type' in event) || event.type !== 'down') return;
    if (press.kind === 'button')
      this.buttons.set(press.id, {
        pointerType:
          (event.kind === 'pointer' ? event.pointerType : undefined) ?? 'mouse',
        owner,
        ...(order ? { order } : {}),
        releasing: false,
      });
    else if (event.kind === 'key')
      this.keys.set(press.id, {
        key: event.key,
        code: event.code,
        owner,
        ...(order ? { order } : {}),
        releasing: false,
      });
  }

  /**
   * The producer answered for an event that was sent. A release it
   * confirmed is forgotten; one that failed or timed out may not have
   * landed, so it stays held, marked for release. True when it was marked.
   */
  settled(event: LiveSurfaceInput, confirmed: boolean): boolean {
    const press = pressOf(event);
    if (!press || !('type' in event) || event.type !== 'up') return false;
    const map: Map<string, { releasing: boolean }> =
      press.kind === 'button' ? this.buttons : this.keys;
    if (confirmed) {
      map.delete(press.id);
      return false;
    }
    const held = map.get(press.id);
    if (!held) return false;
    held.releasing = true;
    return true;
  }

  /** Mark what `controller` (or, without one, anyone) holds for release. */
  markForRelease(
    controller?: LiveSurfaceController,
    /** Only what this sender pressed in batches up to this `seq`. */
    through?: LiveSurfaceInputOrder,
  ): void {
    const owner = controller ? controllerKey(controller) : null;
    for (const held of [...this.buttons.values(), ...this.keys.values()]) {
      if (owner !== null && held.owner !== owner) continue;
      // A press sent with no order (before its viewer's stream confirmed
      // it) is released by any release from its controller.
      if (
        through &&
        held.order &&
        (held.order.sender !== through.sender || held.order.seq > through.seq)
      )
        continue;
      held.releasing = true;
    }
  }

  /** Whether a release is still owed: input waits until it is not. */
  unresolved(): boolean {
    for (const held of [...this.buttons.values(), ...this.keys.values()])
      if (held.releasing) return true;
    return false;
  }

  /** Whether `controller` itself has anything pressed. */
  hasAnyFrom(controller: LiveSurfaceController): boolean {
    const owner = controllerKey(controller);
    for (const button of this.buttons.values())
      if (button.owner === owner) return true;
    for (const key of this.keys.values()) if (key.owner === owner) return true;
    return false;
  }

  /** Everything held, forgotten here: carried to the surface's next life. */
  takeAll(): HeldCarry | null {
    if (this.buttons.size === 0 && this.keys.size === 0) return null;
    const carry: HeldCarry = {
      buttons: [...this.buttons],
      keys: [...this.keys],
      pointer: { ...this.pointer },
      pointerType: this.pointerType,
    };
    this.buttons.clear();
    this.keys.clear();
    return carry;
  }

  /** Presses carried from the surface's previous life, all to be released. */
  adopt(carry: HeldCarry): void {
    for (const [button, held] of carry.buttons)
      this.buttons.set(button, { ...held, releasing: true });
    for (const [id, held] of carry.keys)
      this.keys.set(id, { ...held, releasing: true });
    this.pointer = { ...carry.pointer };
    this.pointerType = carry.pointerType;
  }

  /**
   * Everything marked for release, then forget it (`restore` puts it back
   * when the cancel failed); null when nothing is marked.
   */
  takeReleasing(): { held: LiveSurfaceHeldInput; restore: () => void } | null {
    const buttons = [...this.buttons].filter(([, held]) => held.releasing);
    const keys = [...this.keys].filter(([, held]) => held.releasing);
    if (buttons.length === 0 && keys.length === 0) return null;
    const held: LiveSurfaceHeldInput = {
      buttons: buttons.map(([button]) => button),
      keys: keys.map(([, { key, code }]) => ({ key, code })),
      pointer: { ...this.pointer },
      pointerType: this.pointerType,
      buttonPointerTypes: Object.fromEntries(
        buttons.map(([button, held]) => [button, held.pointerType]),
      ),
    };
    for (const [button] of buttons) this.buttons.delete(button);
    for (const [id] of keys) this.keys.delete(id);
    return {
      held,
      // Nothing is dispatched between take and restore: both run on the
      // surface's serialized input chain.
      restore: () => {
        for (const [button, value] of buttons) this.buttons.set(button, value);
        for (const [id, value] of keys) this.keys.set(id, value);
      },
    };
  }
}

/** Off every viewport: releasing a button here completes no click. */
const NEUTRAL_POINT = { x: -1, y: -1 };

function neutralCancelEvents(held: LiveSurfaceHeldInput): LiveSurfaceInput[] {
  const events: LiveSurfaceInput[] = [];
  if (held.buttons.length > 0) {
    // Each release keeps the modality its down was dispatched in, so a
    // producer can map a touch to a touch cancel rather than a lift.
    const typeOf = (type: LiveSurfacePointerType | undefined) =>
      !type || type === 'mouse' ? {} : { pointerType: type };
    events.push({
      kind: 'pointer',
      type: 'move',
      ...NEUTRAL_POINT,
      ...typeOf(held.pointerType),
    });
    for (const button of held.buttons)
      events.push({
        kind: 'pointer',
        type: 'up',
        ...NEUTRAL_POINT,
        button,
        clickCount: 1,
        ...typeOf(held.buttonPointerTypes[button] ?? held.pointerType),
      });
  }
  for (const { key, code } of held.keys)
    events.push({ kind: 'key', type: 'up', key, code });
  return events;
}

interface EntryInternals {
  dispose: () => Promise<void>;
  lease: LiveSurfaceControlLeaseState;
  pressed: PressedInput;
  /** Tail of the per-surface input chain: one batch at a time, in order. */
  chain: Promise<unknown>;
  /**
   * A dispatch that timed out and has not settled. While set the surface is
   * WEDGED: new input is refused `surface-wedged` and queued work waits,
   * so nothing ever runs concurrently with the orphaned dispatch.
   */
  orphan: Promise<unknown> | null;
  /** When the current wedge began (ms), for the viewers' state record. */
  wedgedSince: number | null;
  dispatchTimeoutMs: number;
  onError: (message: string, error: unknown) => void;
  onExplicitControl: NonNullable<LiveSurfaceRegistration['onExplicitControl']>;
  /** Open viewer streams per human controller (for release on disconnect). */
  /**
   * Viewer ids this surface issued: the controller each belongs to, how many
   * open streams hold it, and the pending forget once none does.
   */
  viewers: Map<
    LiveSurfaceViewerId,
    {
      controller: string;
      streams: number;
      forget: ReturnType<typeof setTimeout> | null;
    }
  >;
  viewerGraceMs: number;
  /**
   * The surface's one release cleanup: the attempt in flight (at most one),
   * the timer for the next try, and how many tries in a row failed.
   */
  cleanup: {
    attempt: Promise<boolean> | null;
    retry: ReturnType<typeof setTimeout> | null;
    failures: number;
  };
  /** The cleanup kept failing: input is refused `release-stuck`. */
  stuck: boolean;
  onReleaseStuck: () => void;
}

/** Failed cleanup attempts in a row after which the surface is stuck. */
const CLEANUP_STUCK_AFTER = 6;
/** Bound on presses carried between a surface's lives (oldest dropped). */
const CARRIED_SCOPES_MAX = 64;

/** The first pause before a failed release is tried again, doubling. */
const CLEANUP_RETRY_MS = 200;
/** The longest pause between tries of a failed release. */
const CLEANUP_RETRY_MAX_MS = 5_000;

const internals = new WeakMap<LiveSurfaceEntry, EntryInternals>();

function internalsOf(entry: LiveSurfaceEntry): EntryInternals {
  const found = internals.get(entry);
  if (!found) throw new Error('live surface entry is not registered');
  return found;
}

export class LiveSurfaceRegistry {
  private readonly entries = new Map<string, LiveSurfaceEntry>();
  /** Presses still held when a surface went, by `heldScope`. */
  private readonly carried = new Map<string, HeldCarry>();
  private disposal?: Promise<void>;

  constructor(private readonly options: LiveSurfaceRegistryOptions = {}) {}

  /**
   * Register a producer. Returns an unregister function that also stops its
   * frame stream. Without `authorize`, the surface exists but nobody may
   * reach it — fail closed, never fail open.
   */
  register(
    producer: LiveSurfaceProducer,
    registration: LiveSurfaceRegistration = {},
  ): () => Promise<void> {
    if (this.disposal) throw new Error('Live surface registry is disposed');
    if (this.entries.has(producer.surfaceId))
      throw new Error(
        `live surface ${producer.surfaceId} is already registered`,
      );
    const lease = new LiveSurfaceControlLeaseState(
      producer.surfaceId,
      this.options.lease,
    );
    const hub = new LiveSurfaceHub(producer, lease, this.options.hub);
    const authorizer = registration.authorize;
    const decide = async (
      principal: string,
      action: LiveSurfaceAction,
      context?: LiveSurfaceAuthorizationContext,
    ): Promise<LiveSurfaceDecision> => {
      if (!authorizer) return 'deny';
      try {
        return (await authorizer(
          principal,
          producer.surfaceId,
          action,
          context,
        )) === true
          ? 'allow'
          : 'deny';
      } catch (error) {
        return error instanceof LiveSurfaceAuthorizerBusyError
          ? 'busy'
          : 'deny';
      }
    };
    const lifetime = new AbortController();
    const disposers = new Set<() => Promise<void>>();
    const entry: LiveSurfaceEntry = {
      producer,
      hub,
      lease,
      signal: lifetime.signal,
      onDispose: (dispose) => {
        disposers.add(dispose);
        return () => disposers.delete(dispose);
      },
      decide,
      authorize: async (principal, action, context) =>
        (await decide(principal, action, context)) === 'allow',
    };
    const own: EntryInternals = {
      dispose: async () => {},
      lease,
      pressed: new PressedInput(),
      chain: Promise.resolve(),
      orphan: null,
      wedgedSince: null,
      dispatchTimeoutMs:
        this.options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      onError: this.options.hub?.onError ?? (() => {}),
      onExplicitControl: registration.onExplicitControl ?? (() => {}),
      viewers: new Map(),
      viewerGraceMs: this.options.viewerGraceMs ?? DEFAULT_VIEWER_GRACE_MS,
      cleanup: { attempt: null, retry: null, failures: 0 },
      stuck: false,
      onReleaseStuck: registration.onReleaseStuck ?? (() => {}),
    };
    internals.set(entry, own);
    const scope = registration.heldScope ?? producer.surfaceId;
    const carried = this.carried.get(scope);
    if (carried) {
      this.carried.delete(scope);
      own.pressed.adopt(carried);
    }
    own.dispose = async () => {
      // What is still held goes with the scope: the next surface releases
      // it before taking input (it is never simply forgotten).
      const held = own.pressed.takeAll();
      if (held) {
        this.carried.delete(scope);
        this.carried.set(scope, held);
        while (this.carried.size > CARRIED_SCOPES_MAX)
          this.carried.delete(this.carried.keys().next().value!);
      }
      lifetime.abort();
      if (own.cleanup.retry) clearTimeout(own.cleanup.retry);
      own.cleanup.retry = null;
      lease.dispose();
      await Promise.all([
        hub.dispose(),
        ...[...disposers].map((dispose) => dispose()),
      ]);
    };
    // A handoff cancels whatever the previous controller held. It is queued
    // synchronously at the claim: AHEAD of the new controller's first batch
    // and behind the old controller's current one.
    lease.onHandoff(() => releaseHeld(entry));
    // A human still pressing something THEY dispatched stays live (up to the
    // lease's ceiling) — never on another controller's stuck press, and
    // never while the surface is wedged (a press that cannot be released).
    lease.setHoldProbe(
      (holder) => own.orphan === null && own.pressed.hasAnyFrom(holder),
    );
    // Control lapsing to NOBODY — release or expiry — cancels held input too.
    lease.onChange((next) => {
      if (next.holder === null) releaseHeld(entry);
    });
    // Viewers see the wedge in their state record, so a surface that stops
    // taking input (a page showing a dialog) says so instead of going quiet.
    hub.setInputHealth(() => ({
      wedged: own.orphan !== null,
      wedgedSince: own.wedgedSince,
      releaseStuck: own.stuck,
    }));
    this.entries.set(producer.surfaceId, entry);
    // Carried presses are released before this surface takes any input.
    if (carried) void runCleanup(entry);
    return async () => {
      if (this.entries.get(producer.surfaceId) !== entry) return;
      this.entries.delete(producer.surfaceId);
      await own.dispose();
    };
  }

  get(surfaceId: string): LiveSurfaceEntry | undefined {
    return this.entries.get(surfaceId);
  }

  get size(): number {
    return this.entries.size;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.disposal = Promise.all([
      ...entries.map((entry) => internalsOf(entry).dispose()),
    ]).then(() => {});
    return this.disposal;
  }
}

function enqueue<T>(
  entry: LiveSurfaceEntry,
  run: () => Promise<T>,
): Promise<T> {
  const own = internalsOf(entry);
  const next = own.chain.then(run);
  own.chain = next.catch(() => {});
  return next;
}

/**
 * Dispatch one event, bounded by the dispatch timeout. A timeout WEDGES the
 * surface until the orphaned dispatch settles (it cannot be cancelled, only
 * waited out), so no later event ever overlaps it.
 */
async function dispatchWithTimeout(
  entry: LiveSurfaceEntry,
  run: () => Promise<void>,
  /** What is dispatched, for the failure log: a kind and type, never content. */
  what: string,
  /** Told whether a dispatch that timed out landed once it settles. */
  onLate?: (landed: boolean) => void,
): Promise<'ok' | 'failed' | 'timeout' | LiveSurfaceInputRefusal> {
  const own = internalsOf(entry);
  const pending = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending.then(
      () => 'ok' as const,
      // A refusal the viewer can act on is carried through, not flattened.
      (error: unknown) => {
        if (error instanceof LiveSurfaceInputRefusal) return error;
        // The viewer is told only `dispatch-failed`; the cause is kept here.
        own.onError(
          'live surface input dispatch failed',
          dispatchFailureDetail(entry.producer.surfaceId, what, error),
        );
        return 'failed' as const;
      },
    ),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), own.dispatchTimeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const orphan: Promise<unknown> = pending
      .then(
        () => true,
        () => false,
      )
      .then((landed) => {
        onLate?.(landed);
        if (own.orphan !== orphan) return;
        own.orphan = null;
        own.wedgedSince = null;
        entry.hub.announce();
        // A release that waited out the wedge is tried now.
        if (own.pressed.unresolved()) void runCleanup(entry);
      });
    own.orphan = orphan;
    own.wedgedSince = Date.now();
    entry.hub.announce();
    own.onError('live surface producer dispatch timed out; surface wedged', {
      surfaceId: entry.producer.surfaceId,
    });
  }
  return outcome;
}

/** Bound on a producer error's text in the failure log. */
const DISPATCH_FAILURE_DETAIL_MAX = 300;

/**
 * One line naming the surface, the input's kind and type, and the producer's
 * error. A string because the host logger keeps only a string or an Error's
 * message. The input's key or text is never included.
 */
function dispatchFailureDetail(
  surfaceId: string,
  what: string,
  error: unknown,
): string {
  const cause =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `${surfaceId} ${what}: ${cause}`.slice(0, DISPATCH_FAILURE_DETAIL_MAX);
}

/** An input's kind and type: what the failure log may say about it. */
function describeInput(event: LiveSurfaceInput): string {
  return 'type' in event ? `${event.kind} ${event.type}` : event.kind;
}

function wedged(entry: LiveSurfaceEntry): LiveSurfaceInputResult | null {
  if (!internalsOf(entry).orphan) return null;
  return {
    ok: false,
    code: 'surface-wedged',
    accepted: 0,
    lease: entry.lease.snapshot(),
  };
}

/**
 * Mark what `controller` (or, without one, anyone) holds for release and
 * start the surface's cleanup. Called synchronously at a handoff, so the
 * first try is queued AHEAD of the new controller's first batch.
 */
function releaseHeld(
  entry: LiveSurfaceEntry,
  controller?: LiveSurfaceController,
): Promise<boolean> {
  internalsOf(entry).pressed.markForRelease(controller);
  return runCleanup(entry);
}

/**
 * The surface's release cleanup, owned by the server: one attempt at a time
 * (a caller while one is in flight shares it), queued on the input chain,
 * cancelling everything marked without completing it (see
 * `LiveSurfaceProducer.cancelHeldInput`). A failed attempt keeps what it
 * could not release and is tried again after a capped pause, whoever
 * controls the surface by then, until it succeeds or the surface goes; a
 * wedge is waited out without holding the chain. Resolves true once
 * nothing is owed.
 */
function runCleanup(entry: LiveSurfaceEntry): Promise<boolean> {
  const own = internalsOf(entry);
  const cleanup = own.cleanup;
  if (cleanup.attempt) return cleanup.attempt;
  if (cleanup.retry) clearTimeout(cleanup.retry);
  cleanup.retry = null;
  if (entry.signal.aborted || !own.pressed.unresolved()) {
    cleanup.failures = 0;
    return Promise.resolve(true);
  }
  const run = enqueue(entry, () => cancelMarked(entry));
  const attempt = run.then((outcome) => outcome === 'released');
  cleanup.attempt = attempt;
  return run.then((outcome) => {
    const released = outcome === 'released';
    cleanup.attempt = null;
    if (entry.signal.aborted) return false;
    if (released) cleanup.failures = 0;
    if (!own.pressed.unresolved()) {
      setStuck(entry, false);
      return true;
    }
    // Marked while this attempt ran: tried at once. Failed: after a pause.
    if (released) return runCleanup(entry);
    const pause = Math.min(
      CLEANUP_RETRY_MS * 2 ** cleanup.failures,
      CLEANUP_RETRY_MAX_MS,
    );
    // Waiting out a wedge is not a failed release (the orphan settling
    // resumes it); a cancel that ran and failed, or timed out, is.
    if (outcome === 'failed') cleanup.failures += 1;
    if (cleanup.failures >= CLEANUP_STUCK_AFTER) setStuck(entry, true);
    cleanup.retry = setTimeout(() => {
      cleanup.retry = null;
      void runCleanup(entry);
    }, pause);
    cleanup.retry.unref?.();
    return false;
  });
}

/**
 * The surface became stuck (the cleanup kept failing) or recovered. Viewers
 * are told in their state record; the host is told once per time it sticks.
 */
function setStuck(entry: LiveSurfaceEntry, stuck: boolean): void {
  const own = internalsOf(entry);
  if (own.stuck === stuck) return;
  own.stuck = stuck;
  entry.hub.announce();
  if (!stuck) return;
  own.onError('live surface release stuck', {
    surfaceId: entry.producer.surfaceId,
  });
  try {
    own.onReleaseStuck();
  } catch (error) {
    own.onError('live surface release-stuck listener failed', error);
  }
}

/** One cleanup attempt, on the input chain. */
async function cancelMarked(
  entry: LiveSurfaceEntry,
): Promise<'released' | 'failed' | 'waiting'> {
  const own = internalsOf(entry);
  // Never overlaps an orphaned dispatch; the orphan settling resumes it.
  if (own.orphan) return 'waiting';
  const taken = own.pressed.takeReleasing();
  if (!taken) return 'released';
  const { held } = taken;
  const producer = entry.producer;
  const outcomes = producer.cancelHeldInput
    ? [
        await dispatchWithTimeout(
          entry,
          () => producer.cancelHeldInput!(held),
          'held-input cancel',
        ),
      ]
    : [];
  if (!producer.cancelHeldInput)
    for (const event of neutralCancelEvents(held))
      outcomes.push(
        await dispatchWithTimeout(
          entry,
          () => producer.dispatch(event),
          `held-input cancel ${describeInput(event)}`,
        ),
      );
  if (outcomes.every((outcome) => outcome === 'ok')) return 'released';
  own.onError('live surface held-input cancel failed', outcomes);
  taken.restore();
  return 'failed';
}

/** Input waits while a release is owed, so nobody types through it. */
function releasePending(
  entry: LiveSurfaceEntry,
): LiveSurfaceInputResult | null {
  const own = internalsOf(entry);
  if (!own.pressed.unresolved()) return null;
  return {
    ok: false,
    code: own.stuck ? 'release-stuck' : 'release-pending',
    accepted: 0,
    lease: entry.lease.snapshot(),
  };
}

function refuseUnsupported(
  entry: LiveSurfaceEntry,
  events: readonly LiveSurfaceInput[],
): LiveSurfaceInputResult | null {
  const supported = entry.producer.capabilities.input;
  if (events.every((event) => supported.includes(event.kind))) return null;
  return {
    ok: false,
    code: 'unsupported-input',
    accepted: 0,
    lease: entry.lease.snapshot(),
  };
}

async function dispatchFenced(
  entry: LiveSurfaceEntry,
  controller: LiveSurfaceController,
  fence: number,
  events: readonly LiveSurfaceInput[],
  order?: LiveSurfaceInputOrder,
): Promise<LiveSurfaceInputResult> {
  const own = internalsOf(entry);
  let accepted = 0;
  for (const event of events) {
    const refused = wedged(entry);
    if (refused) return { ...refused, accepted };
    const check = entry.lease.isCurrent(fence, controller);
    if (!check.ok) return { ...check, accepted };
    // A controller that lost control is told so first; one that holds it
    // waits for any release still owed.
    const owed = releasePending(entry);
    if (owed) return { ...owed, accepted };
    // Recorded as SENT: an event in flight at a takeover, or one that times
    // out and lands later, is still accounted for by the cancel.
    own.pressed.sent(event, controller, order);
    const outcome = await dispatchWithTimeout(
      entry,
      () =>
        entry.producer.dispatch(event, {
          isCurrent: () => entry.lease.isCurrent(fence, controller).ok,
        }),
      describeInput(event),
      // A release that timed out and then lands is confirmed after all.
      (landed) => {
        if (landed) own.pressed.settled(event, true);
      },
    );
    // A release the producer did not confirm stays held and is released by
    // the cleanup (a refusal acted on nothing: it stays held, unmarked).
    if (
      !(outcome instanceof LiveSurfaceInputRefusal) &&
      own.pressed.settled(event, outcome === 'ok')
    )
      void runCleanup(entry);
    if (outcome instanceof LiveSurfaceInputRefusal)
      return {
        ok: false,
        code: outcome.code,
        accepted,
        lease: entry.lease.snapshot(),
      };
    if (outcome !== 'ok')
      return {
        ok: false,
        code: 'dispatch-failed',
        accepted,
        lease: entry.lease.snapshot(),
      };
    accepted += 1;
  }
  return { ok: true, accepted, lease: entry.lease.snapshot() };
}

/**
 * Dispatch a human's input batch. The claim happens NOW, synchronously, not
 * when the batch reaches the head of the input chain: a human taking over
 * must fence an agent batch that is already running, at its very next
 * event. The human auto-claims when the epoch they observed is current
 * (`stale-epoch` otherwise) and the batch is fenced before every event.
 * Authorization is the caller's job (the route checks `input` and
 * `control` for the resolved human before calling this).
 */
export async function dispatchHumanInput(
  entry: LiveSurfaceEntry,
  human: HumanController,
  observedEpoch: number,
  events: readonly LiveSurfaceInput[],
  /** The sending viewer, as it presented itself (validated here). */
  presentedViewerId?: LiveSurfaceViewerId,
  /** The batch's place in its sender's order, recorded on its presses. */
  order?: LiveSurfaceInputOrder,
): Promise<LiveSurfaceInputResult> {
  const own = internalsOf(entry);
  const viewerId = viewerOf(entry, human, presentedViewerId);
  const withCause = (result: LiveSurfaceInputResult): LiveSurfaceInputResult =>
    presentedViewerId === undefined ? result : attest(entry, viewerId, result);
  const unsupported = refuseUnsupported(entry, events) ?? wedged(entry);
  if (unsupported) return withCause(unsupported);
  // A release owed from before this request (not the one its own claim
  // starts at a handoff, which runs ahead of this batch on the chain).
  const owed = releasePending(entry);
  const claim = own.lease.claimForHumanInput(human, observedEpoch, viewerId);
  // A stale view is told so first; a current one waits for that release.
  if (!claim.ok) return withCause({ ...claim, accepted: 0 });
  if (owed) return withCause({ ...owed, lease: entry.lease.snapshot() });
  const fence = claim.lease.fence ?? 0;
  return withCause(
    await enqueue(entry, () =>
      dispatchFenced(entry, { ...human }, fence, events, order),
    ),
  );
}

/**
 * Release what this human controller has pressed on the surface, never
 * completing it (#90 B). Not fenced: it touches only the caller's own
 * presses, which are safe to release at any epoch; with `through`, only
 * those its sender pressed in batches up to that `seq`, so a retried or
 * late request never releases a newer press. Answered ok once nothing
 * is owed; `release-pending` when the release is not yet confirmed (an
 * attempt already in flight, a failed try, a wedge), which the server keeps
 * trying itself: the caller never needs to ask again.
 */
export async function releaseHumanPressed(
  entry: LiveSurfaceEntry,
  human: HumanController,
  /** The asking viewer: the answer then carries its attestation. */
  presentedViewerId?: LiveSurfaceViewerId,
  /** Only what this sender pressed in batches up to this `seq`. */
  through?: LiveSurfaceInputOrder,
): Promise<FencedLeaseResult & { epochCause?: LiveSurfaceEpochCause }> {
  const own = internalsOf(entry);
  const viewerId = viewerOf(entry, human, presentedViewerId);
  const answer = (
    result: FencedLeaseResult,
  ): FencedLeaseResult & { epochCause?: LiveSurfaceEpochCause } =>
    presentedViewerId === undefined
      ? result
      : (attest(entry, viewerId, result) as FencedLeaseResult & {
          epochCause: LiveSurfaceEpochCause;
        });
  // One attempt at a time: a caller arriving while one is in flight, or
  // while the server is already retrying, is answered at once.
  const inFlight = own.cleanup.attempt !== null;
  const busy = inFlight || own.cleanup.failures > 0;
  own.pressed.markForRelease({ ...human }, through);
  // An attempt in flight has taken what it releases but not confirmed it.
  const released = busy
    ? !inFlight && !own.pressed.unresolved()
    : await runCleanup(entry);
  const lease = own.lease.snapshot();
  return answer(
    released
      ? { ok: true, lease }
      : {
          ok: false,
          code: own.stuck ? 'release-stuck' : 'release-pending',
          lease,
        },
  );
}

/**
 * The viewer id `presented` by `human`, when this surface issued it to that
 * same controller; otherwise none. Someone else presenting a viewer's id is
 * treated exactly as presenting no id, so it can never borrow that viewer's
 * causality.
 */
function viewerOf(
  entry: LiveSurfaceEntry,
  human: HumanController,
  presented: LiveSurfaceViewerId | undefined,
): LiveSurfaceViewerId | undefined {
  if (presented === undefined) return undefined;
  const issued = internalsOf(entry).viewers.get(presented);
  return issued?.controller === controllerKey({ ...human })
    ? presented
    : undefined;
}

/** The answer's lease and its cause for `viewerId`, read at one point. */
function attest<T extends { lease: LiveSurfaceControlLease }>(
  entry: LiveSurfaceEntry,
  viewerId: LiveSurfaceViewerId | undefined,
  result: T,
): T & { epochCause: LiveSurfaceEpochCause } {
  const { lease, epochCause } = internalsOf(entry).lease.snapshotFor(viewerId);
  return { ...result, lease, epochCause };
}

/** The epoch's cause for one viewer, with the lease it describes. */
export function attestedLease(
  entry: LiveSurfaceEntry,
  viewerId: LiveSurfaceViewerId,
): { lease: LiveSurfaceControlLease; epochCause: LiveSurfaceEpochCause } {
  return internalsOf(entry).lease.snapshotFor(viewerId);
}

/** Whether `controller` has any viewer stream open on this surface. */
function hasOpenStream(own: EntryInternals, controller: string): boolean {
  for (const viewer of own.viewers.values())
    if (viewer.controller === controller && viewer.streams > 0) return true;
  return false;
}

/**
 * A viewer stream for `human` opened. A replacement stream (new params, a
 * reconnect) presents the viewer id it already holds and stays that viewer;
 * anything else gets a fresh, unguessable id, told only to this stream.
 * `close` ends the stream: once the controller has no open stream for the
 * grace window, the server releases what it pressed (it can no longer see
 * its own releases) and forgets the id.
 */
export function attachHumanViewer(
  entry: LiveSurfaceEntry,
  human: HumanController,
  presented?: LiveSurfaceViewerId,
): { viewerId: LiveSurfaceViewerId; close: () => void } {
  const own = internalsOf(entry);
  const controller = controllerKey({ ...human });
  const adopted = viewerOf(entry, human, presented);
  const viewerId = adopted ?? randomBytes(24).toString('base64url');
  const viewer = own.viewers.get(viewerId) ?? {
    controller,
    streams: 0,
    forget: null,
  };
  if (viewer.forget) clearTimeout(viewer.forget);
  viewer.forget = null;
  viewer.streams += 1;
  own.viewers.set(viewerId, viewer);
  let closed = false;
  return {
    viewerId,
    close: () => {
      if (closed) return;
      closed = true;
      viewer.streams -= 1;
      if (viewer.streams > 0) return;
      viewer.forget = setTimeout(() => {
        viewer.forget = null;
        if (viewer.streams > 0) return;
        own.viewers.delete(viewerId);
        // A fresh check: a replacement stream for the same controller (even
        // under a new id) means it can still see what it pressed.
        if (!hasOpenStream(own, controller)) releaseHeld(entry, { ...human });
      }, own.viewerGraceMs);
      viewer.forget.unref?.();
    },
  };
}

/** A listener's fault never changes the outcome of a control action. */
function notifyExplicit(
  own: EntryInternals,
  action: 'claim' | 'release',
  human: HumanController,
  fence: number,
): void {
  try {
    own.onExplicitControl({ action, human, fence });
  } catch (error) {
    own.onError('explicit control listener failed', error);
  }
}

/** An explicit human claim ("Take control"). The route authorizes `control`. */
export function claimHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
  /** The claiming viewer, as it presented itself (validated here). */
  presentedViewerId?: LiveSurfaceViewerId,
): FencedLeaseResult & { epochCause?: LiveSurfaceEpochCause } {
  const own = internalsOf(entry);
  const viewerId = viewerOf(entry, human, presentedViewerId);
  const result = own.lease.claimHuman(human, viewerId);
  if (result.ok) notifyExplicit(own, 'claim', human, result.lease.fence);
  return presentedViewerId === undefined
    ? result
    : (attest(entry, viewerId, result) as FencedLeaseResult & {
        epochCause: LiveSurfaceEpochCause;
      });
}

/** Release, and cancel anything the human still held (never completing it). */
export function releaseHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
  epoch: number,
): FencedLeaseResult {
  // The lapse to no holder cancels held input (the lease's onChange).
  const own = internalsOf(entry);
  const result = own.lease.release(human, { epoch });
  if (result.ok) notifyExplicit(own, 'release', human, result.lease.fence);
  return result;
}

/**
 * A person's keep-alive of their own current hold (see
 * `LiveSurfaceControlLeaseState.keepHumanAlive`): capped, never a claim.
 */
export function keepHumanControlAlive(
  entry: LiveSurfaceEntry,
  human: HumanController,
  epoch: number,
): FencedLeaseResult {
  return internalsOf(entry).lease.keepHumanAlive(human, epoch);
}

/**
 * An agent's explicit claim. `agent` must come from the VERIFIED calling
 * session; `actingFor` is the human principal the agent acts for, and the
 * surface's authorizer must grant it `control`. Never preempts a live human.
 */
export async function claimAgentControl(
  entry: LiveSurfaceEntry,
  agent: AgentController,
  actingFor: string,
  context?: LiveSurfaceAuthorizationContext,
): Promise<FencedLeaseResult> {
  if (!(await entry.authorize(actingFor, 'control', context)))
    return { ok: false, code: 'not-authorized', lease: entry.lease.snapshot() };
  return internalsOf(entry).lease.claimForAgent(
    agent.principal,
    agent.sessionId,
  );
}

/** Release at the agent's fence, and cancel anything it still held. */
export function releaseAgentControl(
  entry: LiveSurfaceEntry,
  agent: AgentController,
  fence: number,
): FencedLeaseResult {
  return internalsOf(entry).lease.release(agent, { fence });
}

/**
 * Dispatch input as an agent that holds the lease at `fence` (the `fence`
 * of the lease `claimAgentControl` returned). The acting-for
 * principal must be granted `input`. Works with zero viewers (D6): dispatch
 * never depends on the frame stream running. Fenced before every event, so
 * a human taking over mid-batch stops it at once.
 */
export async function dispatchAgentInput(
  entry: LiveSurfaceEntry,
  agent: AgentController,
  actingFor: string,
  fence: number,
  events: readonly LiveSurfaceInput[],
  context?: LiveSurfaceAuthorizationContext,
): Promise<LiveSurfaceInputResult> {
  if (!(await entry.authorize(actingFor, 'input', context)))
    return {
      ok: false,
      code: 'not-authorized',
      accepted: 0,
      lease: entry.lease.snapshot(),
    };
  const unsupported = refuseUnsupported(entry, events) ?? wedged(entry);
  if (unsupported) return unsupported;
  // A fence that is no longer current is told so before any owed release.
  const check = entry.lease.isCurrent(fence, agent);
  if (!check.ok) return { ...check, accepted: 0 };
  const owed = releasePending(entry);
  if (owed) return owed;
  return enqueue(entry, () => dispatchFenced(entry, agent, fence, events));
}
