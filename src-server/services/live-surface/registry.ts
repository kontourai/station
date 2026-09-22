import type {
  LiveSurfaceAction,
  LiveSurfaceController,
  LiveSurfaceInput,
  LiveSurfaceInputResult,
} from '@kontourai/station-contracts/live-surface';
import {
  type LiveSurfaceControlLeaseOptions,
  LiveSurfaceControlLeaseState,
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
 * Producers register here by surfaceId; the routes and any server-side
 * automation look surfaces up here. With nothing registered every route is
 * inert (a typed `unknown-surface` 404).
 */
export interface LiveSurfaceEntry {
  readonly producer: LiveSurfaceProducer;
  readonly hub: LiveSurfaceHub;
  /**
   * Exported for automation (another lane's agent broker): capture the epoch
   * from `claimForAgent`, then `lease.isCurrent(epoch, controller)` before
   * and after every operation, aborting as "interrupted" when it fails.
   */
  readonly lease: LiveSurfaceControlLeaseState;
  /** Always answers; `authorize` from registration, or deny-all without one. */
  readonly authorize: (
    principal: string,
    action: LiveSurfaceAction,
  ) => Promise<boolean>;
}

export interface LiveSurfaceRegistryOptions {
  hub?: LiveSurfaceHubOptions;
  lease?: LiveSurfaceControlLeaseOptions;
}

export interface LiveSurfaceRegistration {
  /** Absent means every principal is denied every action. */
  authorize?: LiveSurfaceAuthorizer;
}

export class LiveSurfaceRegistry {
  private readonly entries = new Map<string, LiveSurfaceEntry>();

  constructor(private readonly options: LiveSurfaceRegistryOptions = {}) {}

  /**
   * Register a producer. Returns an unregister function that also stops its
   * frame stream. Without `authorize`, the surface exists but nobody may
   * reach it over HTTP — fail closed, never fail open.
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

const inputChains = new WeakMap<LiveSurfaceEntry, Promise<unknown>>();

/**
 * Input for one surface runs one batch at a time, in arrival order, whoever
 * sent it — two concurrent batches can never interleave their key strokes.
 */
function serialized(
  entry: LiveSurfaceEntry,
  run: () => Promise<LiveSurfaceInputResult>,
): Promise<LiveSurfaceInputResult> {
  const previous = inputChains.get(entry) ?? Promise.resolve();
  const next = previous.then(run);
  inputChains.set(
    entry,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Dispatch a human's input batch. The human auto-claims the lease when the
 * epoch they observed is current (`stale-epoch` otherwise) — preempting an
 * agent — and the epoch is re-checked before every event so a batch never
 * straddles a change of hands. Authorization is the caller's job (the route
 * checks `input` and `control` before calling this).
 */
export function dispatchHumanInput(
  entry: LiveSurfaceEntry,
  principal: string,
  observedEpoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  return serialized(entry, async () => {
    const unsupported = refuseUnsupported(entry, events);
    if (unsupported) return unsupported;
    const claim = entry.lease.claimForHumanInput(principal, observedEpoch);
    if (!claim.ok) return { ...claim, accepted: 0 };
    return dispatchFenced(
      entry,
      { kind: 'human', principal },
      claim.lease.epoch,
      events,
    );
  });
}

/**
 * Dispatch input as an agent that already holds the lease at `epoch` (from
 * `lease.claimForAgent` with its VERIFIED session). Works with zero viewers
 * (D6): dispatch never depends on the frame stream running. Fenced before
 * every event, so a human taking over mid-batch stops it at once.
 */
export function dispatchAgentInput(
  entry: LiveSurfaceEntry,
  agent: Extract<LiveSurfaceController, { kind: 'agent' }>,
  epoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  return serialized(entry, async () => {
    const unsupported = refuseUnsupported(entry, events);
    if (unsupported) return unsupported;
    return dispatchFenced(entry, agent, epoch, events);
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
  epoch: number,
  events: readonly LiveSurfaceInput[],
): Promise<LiveSurfaceInputResult> {
  let accepted = 0;
  for (const event of events) {
    const check = entry.lease.isCurrent(epoch, controller);
    if (!check.ok) return { ...check, accepted };
    try {
      await entry.producer.dispatch(event);
    } catch {
      return {
        ok: false,
        code: 'dispatch-failed',
        accepted,
        lease: entry.lease.snapshot(),
      };
    }
    accepted += 1;
  }
  return { ok: true, accepted, lease: entry.lease.snapshot() };
}
