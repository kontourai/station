import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { ACPProbe, type ACPProbeInitiator } from './acp-probe.js';

type EventBus = {
  emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
};

interface ACPProbeLike {
  probe(initiator?: ACPProbeInitiator): Promise<boolean>;
  dispose?(): Promise<void>;
  /** Epoch ms of the last probe ATTEMPT (success or failure); `0`/absent when never probed. */
  lastProbeAt?: number;
}

/**
 * station#1908: the periodic sweep's default staleness gate. Before this,
 * `runACPManagerProbes` re-probed — i.e. re-SPAWNED the connected engine
 * binary — for every registered connection on every single tick of
 * `ACPManager`'s 60-second timer, forever, with no regard for how recently
 * that connection had already been observed. Measured on the brian-media
 * dogfood host: ~2 spawns/minute of OpenCode's Bun-embedded binary, each
 * leaking an unreclaimed extracted `.so` (station#1908).
 *
 * A connection's live modes/config-options/capabilities genuinely can only
 * be learned by a real handshake (there is no cheaper capability record to
 * consult — see acp-probe.ts's own architecture note), so probing cannot be
 * removed outright; it must instead be bounded. Five minutes keeps
 * "an engine became available/unavailable" detectable on a human timescale
 * (e.g. the Connections Hub) while cutting the previously-unbounded
 * 60s-forever cadence by over 80%.
 */
export const ACP_PROBE_STALE_AFTER_MS = 5 * 60_000;

export async function runACPManagerProbes({
  sessions,
  probes,
  eventBus,
  getAvailableConnectionCount,
  now = Date.now,
  staleAfterMs = ACP_PROBE_STALE_AFTER_MS,
}: {
  sessions: Map<string, unknown>;
  probes: Map<string, ACPProbeLike>;
  eventBus?: EventBus;
  getAvailableConnectionCount: () => number;
  /** Injectable clock for deterministic staleness-gate tests. */
  now?: () => number;
  /** A connection probed more recently than this is skipped this tick. */
  staleAfterMs?: number;
}): Promise<void> {
  if (sessions.size > 0) return;

  const nowMs = now();
  const dueProbes = Array.from(probes.values()).filter((probe) => {
    const lastProbeAt = probe.lastProbeAt ?? 0;
    return lastProbeAt === 0 || nowMs - lastProbeAt >= staleAfterMs;
  });
  if (dueProbes.length === 0) return;

  const before = getAvailableConnectionCount();
  // station#3404: the sweep is the canonical `'background'` path — no HTTP
  // request is awaiting it and it holds no configuration-mutation lock — so
  // it is where a connection that has never handshaked is allowed the cold
  // first-contact budget. It is also the path that ultimately establishes
  // availability, which is why the request paths can afford to stay tight.
  await Promise.all(dueProbes.map((probe) => probe.probe('background')));
  if (getAvailableConnectionCount() !== before) {
    eventBus?.emit(SERVER_EVENTS.AGENTS_CHANGED);
  }
}

export async function addACPManagerConnection({
  config,
  probes,
  configs,
  logger,
  managedWorkspaceHomeDir,
  eventBus,
  createProbe = (connectionConfig, probeLogger, workspaceHomeDir) =>
    new ACPProbe(connectionConfig, probeLogger, workspaceHomeDir),
  removeConnection,
  initiator = 'request',
}: {
  config: ACPConnectionConfig;
  probes: Map<string, ACPProbeLike>;
  configs: Map<string, ACPConnectionConfig>;
  logger: any;
  managedWorkspaceHomeDir: string;
  eventBus?: EventBus;
  createProbe?: (
    config: ACPConnectionConfig,
    logger: any,
    managedWorkspaceHomeDir: string,
  ) => ACPProbeLike;
  removeConnection: (id: string) => Promise<void>;
  /**
   * station#3404: which path is adding this connection. `'request'` (the
   * default) for the connection routes and a registry install's mode
   * refresh, which an HTTP client is awaiting; `'background'` only for
   * boot-time `startAll`, where nothing is. Note this function REPLACES any
   * existing probe with a fresh one, so the new probe has never handshaked
   * by construction — the initiator is the only thing keeping that from
   * handing a request path the cold budget on every registry reload.
   */
  initiator?: ACPProbeInitiator;
}): Promise<boolean> {
  if (probes.has(config.id)) {
    await removeConnection(config.id);
  }

  configs.set(config.id, config);
  const probe = createProbe(config, logger, managedWorkspaceHomeDir);
  probes.set(config.id, probe);
  const ok = await probe.probe(initiator);
  if (ok) {
    eventBus?.emit(SERVER_EVENTS.AGENTS_CHANGED);
  }
  return ok;
}

export async function removeACPManagerConnection({
  id,
  probes,
  configs,
}: {
  id: string;
  probes: Map<string, ACPProbeLike>;
  configs: Map<string, ACPConnectionConfig>;
}): Promise<void> {
  await probes.get(id)?.dispose?.();
  probes.delete(id);
  configs.delete(id);
}

export async function reconnectACPManagerConnection({
  id,
  probes,
  eventBus,
}: {
  id: string;
  probes: Map<string, ACPProbeLike>;
  eventBus?: EventBus;
}): Promise<boolean> {
  const probe = probes.get(id);
  if (!probe) return false;

  // Reconnect is a button behind an HTTP request, so it ASKS for the tight
  // budget — `'request'` is what it passes. That is not the same as being
  // bounded by it: when a background sweep is already mid-handshake,
  // `probe()` hands this caller that in-flight run instead of starting a new
  // one, so it inherits THAT run's budget, up to the 60,000ms cold one. See
  // `probe()`'s docblock in acp-probe.ts, which documents why abandoning the
  // join to honour the shorter budget would be worse (it would report failure
  // for a handshake still running and possibly about to succeed).
  //
  // It reuses the EXISTING probe (unlike `addACPManagerConnection`), which is
  // why the cold-budget discriminator has to survive a failed first attempt:
  // this is the path a user takes right after installing the engine that was
  // missing when Station first probed it.
  //
  // station#3404, said plainly rather than left to be discovered: on THAT
  // path — engine just installed, therefore stone cold — a Reconnect that
  // starts its OWN probe cannot succeed. The engine #3404 measured took
  // 40,001ms to answer `initialize` cold, and 10,000ms is all this path asks
  // to spend. No intermediate budget fixes it either: anything large enough
  // to cover a 40s cold start blows the 20s desktop-broker header bound and
  // the 30s SDK client deadline, and it would hold the serialized
  // agent-configuration queue while doing so. So Reconnect answers for a WARM
  // engine, and a cold one is picked up by the background sweep, which does
  // get the cold budget. The sweep's own bound is about six minutes, not the
  // five its staleness gate names: the timer ticks every 60s and the gate is
  // `now - lastProbeAt >= ACP_PROBE_STALE_AFTER_MS`, so a connection that
  // falls due just after a tick waits for the next one. The tradeoff is
  // forced by the client deadlines, not chosen for tidiness.
  const ok = await probe.probe('request');
  if (ok) {
    eventBus?.emit(SERVER_EVENTS.AGENTS_CHANGED);
  }
  return ok;
}

export async function shutdownACPManager({
  probeTimer,
  cullTimer,
  probes,
  configs,
}: {
  probeTimer: ReturnType<typeof setInterval> | null;
  cullTimer: ReturnType<typeof setInterval> | null;
  probes: Map<string, ACPProbeLike>;
  configs: Map<string, ACPConnectionConfig>;
}): Promise<{
  probeTimer: ReturnType<typeof setInterval> | null;
  cullTimer: ReturnType<typeof setInterval> | null;
}> {
  if (probeTimer) {
    clearInterval(probeTimer);
  }
  if (cullTimer) {
    clearInterval(cullTimer);
  }

  // VESTIGIAL FOR THE REAL PROBE, and named as such rather than left to read
  // as live defence. `ACPProbe.dispose()` has no rejecting path left after
  // station#3404: its first `retryPendingCleanup` is inside `try/catch {}`,
  // the `probeFlight` join is `.catch(() => undefined)`, and
  // `retryPendingCleanup` itself delegates to `destroyProcessWithEscalation`,
  // which absorbs every rejection (see its own docblock). So against the only
  // implementation Station constructs, `failures` is always empty and this
  // `AggregateError` never forms.
  //
  // Kept anyway because this module is written against `ACPProbeLike`, not
  // against `ACPProbe` — `addACPManagerConnection` takes an injectable
  // `createProbe`, and the interface's `dispose?()` is an ordinary
  // `Promise<void>` that a conforming implementation may reject. What the
  // catch buys is the LOOP: without it the first rejection leaves every later
  // probe undisposed, which is the opposite of what a shutdown that exists to
  // reap engines should do. Retaining the failed probe in the map is
  // deliberate for the same reason (station#3422's "keep a survivor" rule).
  // If `ACPProbeLike` is ever narrowed to a non-throwing `dispose`, delete
  // this whole block with it.
  const failures: unknown[] = [];
  for (const [id, probe] of probes) {
    try {
      await probe.dispose?.();
      probes.delete(id);
      configs.delete(id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'ACP probe shutdown failed.');
  }
  configs.clear();

  return {
    probeTimer: null,
    cullTimer: null,
  };
}
