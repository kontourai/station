import type {
  LiveSurfaceAction,
  LiveSurfaceController,
  LiveSurfaceInput,
  LiveSurfaceInputResult,
  LiveSurfaceLeaseResult,
  LiveSurfacePointerButton,
} from '@kontourai/station-contracts/live-surface';
import {
  type AgentController,
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
 * It must itself fail closed on any error; a throw here is treated as deny.
 */
export type LiveSurfaceAuthorizer = (
  principal: string,
  surfaceId: string,
  action: LiveSurfaceAction,
) => boolean | Promise<boolean>;

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
 */
export interface LiveSurfaceEntry {
  readonly producer: LiveSurfaceProducer;
  readonly hub: LiveSurfaceHub;
  readonly lease: LiveSurfaceLeaseReader;
  /** Always answers; `authorize` from registration, or deny-all without one. */
  readonly authorize: (
    principal: string,
    action: LiveSurfaceAction,
  ) => Promise<boolean>;
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
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;

/**
 * What a controller currently holds down on the surface, recorded from what
 * was SENT to the producer (before awaiting it), so an event that is still
 * in flight — or that timed out and lands later — is accounted for. When
 * control changes hands, or is released, whatever is held is cancelled
 * (never completed; see `cancelHeld`).
 */
class PressedInput {
  private readonly buttons = new Set<LiveSurfacePointerButton>();
  private readonly keys = new Map<string, { key: string; code: string }>();
  private pointer = { x: 0, y: 0 };

  record(event: LiveSurfaceInput): void {
    if (event.kind === 'pointer') {
      this.pointer = { x: event.x, y: event.y };
      if (event.type === 'down' && event.button) this.buttons.add(event.button);
      if (event.type === 'up' && event.button)
        this.buttons.delete(event.button);
    } else if (event.kind === 'key') {
      const id = event.code || event.key;
      if (event.type === 'down')
        this.keys.set(id, { key: event.key, code: event.code });
      else this.keys.delete(id);
    }
  }

  /** Everything held, then forget it; null when nothing is held. */
  take(): LiveSurfaceHeldInput | null {
    if (this.buttons.size === 0 && this.keys.size === 0) return null;
    const held: LiveSurfaceHeldInput = {
      buttons: [...this.buttons],
      keys: [...this.keys.values()],
      pointer: { ...this.pointer },
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
    events.push({ kind: 'pointer', type: 'move', ...NEUTRAL_POINT });
    for (const button of held.buttons)
      events.push({
        kind: 'pointer',
        type: 'up',
        ...NEUTRAL_POINT,
        button,
        clickCount: 1,
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
  dispatchTimeoutMs: number;
  onError: (message: string, error: unknown) => void;
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
    const entry: LiveSurfaceEntry = {
      producer,
      hub,
      lease,
      authorize: async (principal, action) => {
        if (!authorizer) return false;
        try {
          return (
            (await authorizer(principal, producer.surfaceId, action)) === true
          );
        } catch {
          return false;
        }
      },
    };
    const own: EntryInternals = {
      lease,
      pressed: new PressedInput(),
      chain: Promise.resolve(),
      orphan: null,
      dispatchTimeoutMs:
        this.options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      onError: this.options.hub?.onError ?? (() => {}),
    };
    internals.set(entry, own);
    // A handoff cancels whatever the previous controller held. It is queued
    // synchronously at the claim: AHEAD of the new controller's first batch
    // and behind the old controller's current one.
    lease.onHandoff(() => cancelHeld(entry));
    this.entries.set(producer.surfaceId, entry);
    return async () => {
      if (this.entries.get(producer.surfaceId) !== entry) return;
      this.entries.delete(producer.surfaceId);
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
        if (own.orphan === orphan) own.orphan = null;
      });
    own.orphan = orphan;
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
    own.pressed.record(event);
    const outcome = await dispatchWithTimeout(entry, () =>
      entry.producer.dispatch(event),
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

/** An explicit human claim ("Take control"). The route authorizes `control`. */
export function claimHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
): LiveSurfaceLeaseResult {
  return internalsOf(entry).lease.claimHuman(human);
}

/** Release, and cancel anything the human still held (never completing it). */
export function releaseHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
  epoch: number,
): LiveSurfaceLeaseResult {
  const result = internalsOf(entry).lease.release(human, { epoch });
  if (result.ok) cancelHeld(entry);
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
): Promise<LiveSurfaceLeaseResult> {
  if (!(await entry.authorize(actingFor, 'control')))
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
): LiveSurfaceLeaseResult {
  const result = internalsOf(entry).lease.release(agent, { fence });
  if (result.ok) cancelHeld(entry);
  return result;
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
): Promise<LiveSurfaceInputResult> {
  if (!(await entry.authorize(actingFor, 'input')))
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
