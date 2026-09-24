import type {
  LiveSurfaceAction,
  LiveSurfaceController,
  LiveSurfaceInput,
  LiveSurfaceInputResult,
  LiveSurfacePointerButton,
  LiveSurfacePointerType,
} from '@kontourai/station-contracts/live-surface';
import {
  type AgentController,
  type FencedLeaseResult,
  type HumanController,
  type LiveSurfaceControlLeaseOptions,
  LiveSurfaceControlLeaseState,
  type LiveSurfaceLeaseReader,
} from './control-lease.js';
import type { LiveSurfaceHeldInput, LiveSurfaceProducer } from './producer.js';
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
}

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
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;

/**
 * What a controller currently holds down on the surface, recorded from what
 * was SENT to the producer (before awaiting it), so an event that is still
 * in flight — or that timed out and lands later — is accounted for. When
 * control changes hands, or is released, whatever is held is cancelled
 * (never completed; see `cancelHeld`).
 */
/** One controller, as a comparable string (who dispatched a press). */
function controllerKey(controller: LiveSurfaceController): string {
  return controller.kind === 'human'
    ? `human\u0000${controller.principal}\u0000${controller.device ?? ''}`
    : `agent\u0000${controller.principal}\u0000${controller.sessionId}`;
}

class PressedInput {
  /**
   * Each held button: the pointer type its down was dispatched as, and the
   * controller that dispatched it (so one controller's stuck press never
   * keeps a different holder live).
   */
  private readonly buttons = new Map<
    LiveSurfacePointerButton,
    { pointerType: LiveSurfacePointerType; owner: string }
  >();
  private readonly keys = new Map<
    string,
    { key: string; code: string; owner: string }
  >();
  private pointer = { x: 0, y: 0 };
  private pointerType: LiveSurfacePointerType = 'mouse';

  record(event: LiveSurfaceInput, controller: LiveSurfaceController): void {
    const owner = controllerKey(controller);
    if (event.kind === 'pointer') {
      this.pointer = { x: event.x, y: event.y };
      if (event.type === 'down')
        this.pointerType = event.pointerType ?? 'mouse';
      // A down/up with no `button` is the primary one (a raw client's touch
      // names none). Recording it as nothing would leave that press
      // uncancelled at a handoff (Device pane lane, #1970).
      const button =
        event.button ??
        (event.type === 'down' || event.type === 'up' ? 'left' : undefined);
      if (event.type === 'down' && button)
        this.buttons.set(button, {
          pointerType: event.pointerType ?? 'mouse',
          owner,
        });
      if (event.type === 'up' && button) this.buttons.delete(button);
    } else if (event.kind === 'key') {
      const id = event.code || event.key;
      if (event.type === 'down')
        this.keys.set(id, { key: event.key, code: event.code, owner });
      else this.keys.delete(id);
    }
  }

  /** Whether `controller` itself has anything pressed. */
  hasAnyFrom(controller: LiveSurfaceController): boolean {
    const owner = controllerKey(controller);
    for (const button of this.buttons.values())
      if (button.owner === owner) return true;
    for (const key of this.keys.values()) if (key.owner === owner) return true;
    return false;
  }

  /** Everything held, then forget it; null when nothing is held. */
  take(): LiveSurfaceHeldInput | null {
    if (this.buttons.size === 0 && this.keys.size === 0) return null;
    const held: LiveSurfaceHeldInput = {
      buttons: [...this.buttons.keys()],
      keys: [...this.keys.values()].map(({ key, code }) => ({ key, code })),
      pointer: { ...this.pointer },
      pointerType: this.pointerType,
      buttonPointerTypes: Object.fromEntries(
        [...this.buttons].map(([button, held]) => [button, held.pointerType]),
      ),
    };
    this.buttons.clear();
    this.keys.clear();
    return held;
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
}

const internals = new WeakMap<LiveSurfaceEntry, EntryInternals>();

function internalsOf(entry: LiveSurfaceEntry): EntryInternals {
  const found = internals.get(entry);
  if (!found) throw new Error('live surface entry is not registered');
  return found;
}

export class LiveSurfaceRegistry {
  private readonly entries = new Map<string, LiveSurfaceEntry>();

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
    const entry: LiveSurfaceEntry = {
      producer,
      hub,
      lease,
      decide,
      authorize: async (principal, action, context) =>
        (await decide(principal, action, context)) === 'allow',
    };
    const own: EntryInternals = {
      lease,
      pressed: new PressedInput(),
      chain: Promise.resolve(),
      orphan: null,
      wedgedSince: null,
      dispatchTimeoutMs:
        this.options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      onError: this.options.hub?.onError ?? (() => {}),
      onExplicitControl: registration.onExplicitControl ?? (() => {}),
    };
    internals.set(entry, own);
    // A handoff cancels whatever the previous controller held. It is queued
    // synchronously at the claim: AHEAD of the new controller's first batch
    // and behind the old controller's current one.
    lease.onHandoff(() => cancelHeld(entry));
    // A human still pressing something THEY dispatched stays live (up to the
    // lease's ceiling) — never on another controller's stuck press, and
    // never while the surface is wedged (a press that cannot be released).
    lease.setHoldProbe(
      (holder) => own.orphan === null && own.pressed.hasAnyFrom(holder),
    );
    // Control lapsing to NOBODY — release or expiry — cancels held input too.
    lease.onChange((next) => {
      if (next.holder === null) cancelHeld(entry);
    });
    // Viewers see the wedge in their state record, so a surface that stops
    // taking input (a page showing a dialog) says so instead of going quiet.
    hub.setInputHealth(() => ({
      wedged: own.orphan !== null,
      wedgedSince: own.wedgedSince,
    }));
    this.entries.set(producer.surfaceId, entry);
    return async () => {
      if (this.entries.get(producer.surfaceId) !== entry) return;
      this.entries.delete(producer.surfaceId);
      lease.dispose();
      await hub.dispose();
    };
  }

  get(surfaceId: string): LiveSurfaceEntry | undefined {
    return this.entries.get(surfaceId);
  }

  get size(): number {
    return this.entries.size;
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) internals.get(entry)?.lease.dispose();
    await Promise.all(entries.map((entry) => entry.hub.dispose()));
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
): Promise<'ok' | 'failed' | 'timeout'> {
  const own = internalsOf(entry);
  const pending = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending.then(
      () => 'ok' as const,
      () => 'failed' as const,
    ),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), own.dispatchTimeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const orphan: Promise<unknown> = pending
      .catch(() => {})
      .then(() => {
        if (own.orphan !== orphan) return;
        own.orphan = null;
        own.wedgedSince = null;
        entry.hub.announce();
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
 * Cancel whatever is held, without completing it (see
 * `LiveSurfaceProducer.cancelHeldInput`). Queued on the input chain; waits
 * out a wedge first so the cancel cannot overlap an orphaned dispatch, and
 * reads the held state only when it runs, after everything sent before it.
 */
function cancelHeld(entry: LiveSurfaceEntry): void {
  const own = internalsOf(entry);
  void enqueue(entry, async () => {
    while (own.orphan) await own.orphan;
    const held = own.pressed.take();
    if (!held) return null;
    const producer = entry.producer;
    const outcomes = producer.cancelHeldInput
      ? [
          await dispatchWithTimeout(entry, () =>
            producer.cancelHeldInput!(held),
          ),
        ]
      : [];
    if (!producer.cancelHeldInput)
      for (const event of neutralCancelEvents(held))
        outcomes.push(
          await dispatchWithTimeout(entry, () => producer.dispatch(event)),
        );
    if (outcomes.some((outcome) => outcome !== 'ok'))
      own.onError('live surface held-input cancel failed', outcomes);
    return null;
  });
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
): Promise<LiveSurfaceInputResult> {
  const own = internalsOf(entry);
  let accepted = 0;
  for (const event of events) {
    const refused = wedged(entry);
    if (refused) return { ...refused, accepted };
    const check = entry.lease.isCurrent(fence, controller);
    if (!check.ok) return { ...check, accepted };
    // Recorded as SENT: an event in flight at a takeover, or one that times
    // out and lands later, is still accounted for by the cancel.
    own.pressed.record(event, controller);
    const outcome = await dispatchWithTimeout(entry, () =>
      entry.producer.dispatch(event, {
        isCurrent: () => entry.lease.isCurrent(fence, controller).ok,
      }),
    );
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
export function dispatchHumanInput(
  entry: LiveSurfaceEntry,
  human: HumanController,
  observedEpoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  const unsupported = refuseUnsupported(entry, events) ?? wedged(entry);
  if (unsupported) return Promise.resolve(unsupported);
  const claim = internalsOf(entry).lease.claimForHumanInput(
    human,
    observedEpoch,
  );
  if (!claim.ok) return Promise.resolve({ ...claim, accepted: 0 });
  const fence = claim.lease.fence ?? 0;
  return enqueue(entry, () =>
    dispatchFenced(entry, { ...human }, fence, events),
  );
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
): FencedLeaseResult {
  const own = internalsOf(entry);
  const result = own.lease.claimHuman(human);
  if (result.ok) notifyExplicit(own, 'claim', human, result.lease.fence);
  return result;
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
  return enqueue(entry, () => dispatchFenced(entry, agent, fence, events));
}
