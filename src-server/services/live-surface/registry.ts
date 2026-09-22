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
import type { LiveSurfaceProducer } from './producer.js';
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
 * automation captures the epoch from `claimAgentControl`, then checks
 * `lease.isCurrent(epoch, agent)` before and after every operation, aborting
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
 * What a controller currently holds down on the surface, from the input
 * actually dispatched. When control passes to someone else the handoff
 * releases all of it, so a button or modifier held by the previous
 * controller is never left stuck under the new one.
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

  /** The events that release everything held, then forget it all. */
  drain(): LiveSurfaceInput[] {
    const events: LiveSurfaceInput[] = [];
    for (const button of this.buttons)
      events.push({
        kind: 'pointer',
        type: 'up',
        x: this.pointer.x,
        y: this.pointer.y,
        button,
        clickCount: 1,
      });
    for (const { key, code } of this.keys.values())
      events.push({ kind: 'key', type: 'up', key, code });
    this.buttons.clear();
    this.keys.clear();
    return events;
  }
}

interface EntryInternals {
  lease: LiveSurfaceControlLeaseState;
  pressed: PressedInput;
  /** Tail of the per-surface input chain: one batch at a time, in order. */
  chain: Promise<unknown>;
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
      dispatchTimeoutMs:
        this.options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      onError: this.options.hub?.onError ?? (() => {}),
    };
    internals.set(entry, own);
    // The handoff releases whatever the previous controller held. It runs
    // synchronously at the claim, so it is queued AHEAD of the new
    // controller's first batch and behind the old controller's current one.
    lease.onHandoff(() => {
      void enqueue(entry, async () => {
        for (const event of own.pressed.drain()) {
          const outcome = await dispatchWithTimeout(entry, event);
          if (outcome !== 'ok')
            own.onError('live surface handoff release failed', outcome);
        }
        return null;
      });
    });
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

async function dispatchWithTimeout(
  entry: LiveSurfaceEntry,
  event: LiveSurfaceInput,
): Promise<'ok' | 'failed' | 'timeout'> {
  const own = internalsOf(entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.producer.dispatch(event).then(
        () => 'ok' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), own.dispatchTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  epoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  const own = internalsOf(entry);
  let accepted = 0;
  for (const event of events) {
    const check = entry.lease.isCurrent(epoch, controller);
    if (!check.ok) return { ...check, accepted };
    const outcome = await dispatchWithTimeout(entry, event);
    if (outcome !== 'ok') {
      if (outcome === 'timeout')
        own.onError('live surface producer dispatch timed out', {
          surfaceId: entry.producer.surfaceId,
        });
      return {
        ok: false,
        code: 'dispatch-failed',
        accepted,
        lease: entry.lease.snapshot(),
      };
    }
    own.pressed.record(event);
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
  const unsupported = refuseUnsupported(entry, events);
  if (unsupported) return Promise.resolve(unsupported);
  const claim = internalsOf(entry).lease.claimForHumanInput(
    human,
    observedEpoch,
  );
  if (!claim.ok) return Promise.resolve({ ...claim, accepted: 0 });
  return enqueue(entry, () =>
    dispatchFenced(entry, { ...human }, claim.lease.epoch, events),
  );
}

/** An explicit human claim ("Take control"). The route authorizes `control`. */
export function claimHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
): LiveSurfaceLeaseResult {
  return internalsOf(entry).lease.claimHuman(human);
}

export function releaseHumanControl(
  entry: LiveSurfaceEntry,
  human: HumanController,
  epoch: number,
): LiveSurfaceLeaseResult {
  return internalsOf(entry).lease.release(human, epoch);
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

export function releaseAgentControl(
  entry: LiveSurfaceEntry,
  agent: AgentController,
  epoch: number,
): LiveSurfaceLeaseResult {
  return internalsOf(entry).lease.release(agent, epoch);
}

/**
 * Dispatch input as an agent that holds the lease at `epoch`. The acting-for
 * principal must be granted `input`. Works with zero viewers (D6): dispatch
 * never depends on the frame stream running. Fenced before every event, so
 * a human taking over mid-batch stops it at once.
 */
export async function dispatchAgentInput(
  entry: LiveSurfaceEntry,
  agent: AgentController,
  actingFor: string,
  epoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  if (!(await entry.authorize(actingFor, 'input')))
    return {
      ok: false,
      code: 'not-authorized',
      accepted: 0,
      lease: entry.lease.snapshot(),
    };
  const unsupported = refuseUnsupported(entry, events);
  if (unsupported) return unsupported;
  return enqueue(entry, () => dispatchFenced(entry, agent, epoch, events));
}
