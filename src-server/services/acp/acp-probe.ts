import { resolve } from 'node:path';
import {
  type Client,
  type ProviderInfo,
  RequestError,
  type SetProviderRequest,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { acpProbeCleanupRetention } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type AcpInboundExtensionHandler,
  createAcpInboundExtensionRequestHandler,
} from './acp-inbound-extension-policy.js';
import { ACPProcess, type InitializeResult } from './acp-process.js';
import { prepareManagedAcpWorkspace } from './managed-acp-workspace.js';

/**
 * The minimum shape needed to destroy a process with escalation. `ACPProcess`
 * satisfies it; tests can supply a minimal double.
 */
export interface EscalatableProcess {
  destroy(): Promise<void>;
  /**
   * archive#3441 HIGH-1: async now -- it does not resolve until it has
   * either confirmed the group is gone (and released the owned-process
   * registry record) or given up waiting (and left the record in place). See
   * `ACPProcess.forceGroupKill()` for why signal delivery alone is not
   * confirmation.
   */
  forceGroupKill(): Promise<void>;
}

/**
 * archive#1863: destroy a process, racing it against a deadline that is
 * guaranteed to exceed the destroy escalation (SIGTERM → 1s → SIGKILL → 1s
 * confirm ≈ 2s). On a miss — or a destroy that rejects — ESCALATE to an
 * unconditional group SIGKILL instead of abandoning the operation. The
 * previous shape raced destroy() through `runWithinProbeDeadline`, whose
 * `finally` swallowed the losing side (`void operation.catch(() => undefined)`),
 * so a missed deadline dropped the destroy entirely and could leak the engine.
 *
 * `deadlineMs` defaults above the escalation so a healthy destroy always wins;
 * the parameter exists so a test can force a miss and prove the escalation
 * still reaps the process.
 */
export async function destroyProcessWithEscalation(
  process: EscalatableProcess,
  deadlineMs: number,
  onMiss?: (error: unknown) => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `ACP process cleanup did not settle within ${deadlineMs}ms.`,
          ),
        ),
      deadlineMs,
    );
  });
  try {
    await Promise.race([process.destroy(), deadline]);
  } catch (error) {
    onMiss?.(error);
    // The graceful destroy may still be running or may have rejected; force an
    // immediate group kill so the engine (and its grandchild) are reaped
    // regardless, then let destroy settle so its internal state converges. The
    // settle is bounded: a destroy that cannot converge (e.g. a wedged
    // terminateProcess) must not hold the caller forever after the process is
    // already dead. Awaited (archive#3441 HIGH-1): forceGroupKill() itself
    // now waits to CONFIRM the kill before releasing the registry record, so
    // the record is not gone by the time the second destroy() below runs.
    await process.forceGroupKill();
    await Promise.race([
      process.destroy().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default cleanup deadline: comfortably above SIGTERM → 1s → SIGKILL → 1s. */
const DESTROY_ESCALATION_UPPER_BOUND_MS = 5_000;

/**
 * Which path asked for a probe. It selects the deadline budget, and it is a
 * parameter rather than something the probe infers because the probe cannot
 * tell the two apart from its own state:
 *
 * - `'request'` — an HTTP request is awaiting this probe (create/update a
 *   connection, Reconnect, a registry install's mode refresh). These sit
 *   under real client deadlines — the SDK client's default is 30s
 *   (`packages/sdk/src/client/http.ts`) and the desktop app's native HTTP
 *   broker bounds response headers at 20s (`src-desktop/src/lib.rs`) — and
 *   they run inside `applyAgentConfigurationMutation`'s serialized
 *   agent-configuration queue, which `reloadAgents`/`switchAgent` share. A
 *   probe on this path must therefore stay SMALL, not generous.
 * - `'background'` — nothing is waiting: boot-time `startAll` and the
 *   5-minute staleness sweep. This is the path that actually establishes
 *   availability over time, so it is the one that can afford to wait out a
 *   cold engine start.
 *
 * The default is `'request'`, deliberately: a caller that has not thought
 * about which path it is on must inherit the SHORT budget, never the long
 * one.
 */
export type ACPProbeInitiator = 'request' | 'background';

/**
 * archive#3404: the FIRST-contact budget for the handshake, used only when
 * this probe has never completed a successful `initialize`
 * (`lastHandshakeObservedAt === 0`) AND nothing is waiting on it
 * (`initiator === 'background'`). Measured against a real engine
 * (`opencode acp`, same host/binary, three consecutive runs): the cold
 * spawn→initialize took 40,001ms; warm runs took 2,604ms and 1,098ms;
 * `session/new` was 371/482/339ms. A cold spawn can therefore legitimately
 * exceed 40s, which the old flat 10s deadline turned into a guaranteed
 * first-probe timeout: the connection reported `unavailable` and only
 * self-healed once something else had warmed the engine.
 *
 * The budget is a SHARED deadline across `initialize` and `session/new`, not
 * a fresh allowance per phase, so it bounds the handshake at the number named
 * here instead of twice it. Computed worst case for one `runProbe`, with the
 * default 10s `operationTimeoutMs` and no engine retained from an earlier
 * failed cleanup:
 *
 *   handshake ≤ 60,000ms (this budget, both phases together)
 *   + cleanup ≤ max(operationTimeoutMs, 5,000) + 2,000 settle = 12,000ms
 *   = 72,000ms for a background first-contact probe.
 *
 * Every other probe — every `'request'`-initiated one, and every re-probe of
 * a connection that has handshaked before — is bounded at
 * `operationTimeoutMs` + 12,000ms = 22,000ms by default. Stated precisely,
 * because the earlier wording ("BELOW both client deadlines") was arithmetic
 * that does not hold: the HANDSHAKE is 10,000ms, comfortably under the 20s
 * desktop broker bound and the 30s SDK one, and the remaining 12,000ms is
 * cleanup that only costs anything when a destroy MISSES its deadline — the
 * archive#1863 pathology, not the ordinary path, where destroy settles in
 * milliseconds. A request that hits both the full handshake budget and a
 * missed cleanup does exceed the 20s desktop bound.
 *
 * A REQUEST is not the same thing as a probe, and archive#3404 has to say so:
 * `removeConnection` (PUT / DELETE / an idempotent re-POST) awaits
 * `ACPProbe.dispose()`, which joins whatever probe is in flight — possibly a
 * `'background'` one on the 60,000ms cold budget that no client asked for.
 * `dispose()` therefore signals `disposeRequested`, which collapses the
 * in-flight handshake's remaining budget instead of waiting it out, so a
 * request's cost is its own probe plus cleanup, never someone else's cold
 * start. Without that, an edit landing 5s into a cold sweep cost ~67s of
 * dispose plus a ≤22,000ms re-probe inside the serialized
 * agent-configuration queue.
 *
 * archive#3448 M-1 correction: this paragraph used to say `retryPendingCleanup`
 * "at the head of a run adds up to another 12,000ms per engine retained from
 * a previous run" (archive#3422). Both halves are false now that
 * `retryPendingCleanup` runs fire-and-forget rather than awaited at the head
 * of `runProbe` (see that call site): it is no longer "at the head of a run"
 * in any sense that gates this arithmetic, and it adds NOTHING to what a
 * caller of `probe()` pays, regardless of how many engines are retained or
 * how long their destroys take -- that is the whole point of archive#3448.
 * See `MAX_CLEANUP_RETRY_ATTEMPTS`'s own docblock for what the retry work
 * still costs in aggregate wall time (unchanged) and who pays it now
 * (nobody waiting on this method's return value).
 *
 * Not covered by that arithmetic: workspace preparation is filesystem work
 * with no deadline of its own.
 */
const COLD_START_OPERATION_TIMEOUT_MS = 60_000;

/**
 * archive#3441: how many times a single survivor's destroy is retried before
 * Station gives up on it. `retryPendingCleanup` used to retry forever -- a
 * systematically unkillable engine added one entry per cycle, and every
 * cycle re-attempted every entry still in the set, so cycle N cost roughly
 * N × ~13s (the destroy race, `max(operationTimeoutMs, DESTROY_ESCALATION_
 * UPPER_BOUND_MS)`, plus `ACPProcess.forceGroupKill()`'s own confirm wait
 * (up to `FORCE_GROUP_KILL_CONFIRM_MS`, acp-process.ts) when the graceful
 * destroy escalates, plus up to 2s for the forced second destroy) --
 * serially, awaited at the head of `runProbe`, which `addACPManagerConnection`
 * and `reconnectACPManagerConnection` await directly from user-facing routes.
 *
 * Five caps the extra cost any ONE survivor can add over its whole retained
 * lifetime to roughly 5 × ~13s ≈ 1 minute, spread across cycles rather than
 * paid in one, and caps how large the set can grow for a single
 * systematically-bad connection instead of growing without limit.
 *
 * Disclosure (archive#3441) -- the aggregate steady-state cost, measured
 * against the actual code (see
 * `owned-process-reaping.test.ts`'s "MEDIUM-4" timing test for the receipt):
 * once a connection has accumulated `MAX_CLEANUP_RETRY_ATTEMPTS - 1` (4)
 * concurrently-retained survivors -- the worst case this bound permits --
 * every probe cycle pays a destroy-and-confirm attempt on each of those 4
 * plus its own new spawn: measured ≈65s of TOTAL work in the archive#3422-shaped
 * hang (destroy never settles at all, so each attempt pays the full
 * `operationTimeoutMs` deadline miss), or ≈5s when destroy() REJECTS QUICKLY
 * but never confirms (no deadline is missed, so each attempt's cost is
 * `ACPProcess.forceGroupKill()`'s own confirm wait alone, ≈1.0-1.2s/attempt).
 * archive#3441 bounded that work; it did NOT change who pays for it --
 * `retryPendingCleanup` was still the first AWAITED statement in `runProbe`,
 * serially, so every one of those seconds landed on whichever caller was
 * awaiting `probe()`, `reconnectACPManagerConnection`'s user-facing Reconnect
 * route included (archive#3448, split out from this issue specifically
 * because the bound above does not by itself remove the tax).
 *
 * archive#3448 changed who pays: `retryPendingCleanup` now runs
 * fire-and-forget, concurrently with the rest of `runProbe`, rather than
 * gating it (see that call site and {@link ACPProbe.cleanupRetryFlight}).
 * The wall-clock cost measured above is UNCHANGED -- the same destroy race,
 * the same confirm wait, the same up-to-5-attempts bound -- but it is no
 * longer paid by anything that awaits `probe()`. A Reconnect click now costs
 * only its own spawn+handshake, regardless of how many survivors are
 * pending or how long their destroys take to settle. See
 * `acp-probe.test.ts`'s fault-injected "pending survivors ... never settle"
 * tests for the proof that `probe()` no longer waits on this work, and the
 * "still retried" tests for proof nothing is silently dropped by the move.
 *
 * Survivors are NOT retried "on the SAME cadence (once per probe cycle)":
 * `retryPendingCleanup` joins an already
 * in-flight pass rather than starting a new one ({@link
 * ACPProbe.cleanupRetryFlight}), so a probe cycle that lands while a pass is
 * still running contributes ZERO additional attempts -- it is absorbed into
 * the running pass instead of adding its own. The real effective cadence is
 * `min(probe cadence, pass duration)`, not probe cadence alone. This matters
 * because a probe cycle can now fire far faster than a pass drains (a user
 * clicking Reconnect repeatedly, or a background sweep tick overlapping a
 * slow pass), and see {@link MAX_PENDING_CLEANUP_SIZE} for why that used to
 * be safe on the OLD serialized shape and is not, by itself, safe on this
 * one.
 *
 * Second correction (archive#3448): `cleanupProbeProcess`'s `onMiss`
 * callback set
 * `this.lastSuccess = false` unconditionally on ANY destroy-race miss --
 * including the ordinary "destroy() rejects quickly but never confirms"
 * mode this docblock measures above, not only a full deadline miss. On the
 * OLD serialized shape that was harmless: the retry ran to completion BEFORE
 * the handshake even started, so any `lastSuccess = false` a survivor's miss
 * wrote was always overwritten by the handshake's own `true` moments later.
 * Decoupling removed that ordering guarantee -- a survivor's `onMiss` could
 * now fire WHILE a concurrent handshake was succeeding, or immediately after
 * it had already written `lastSuccess = true`, silently flipping a genuinely
 * available connection to reporting UNAVAILABLE with `lastError === null` --
 * exactly the "unavailable with no reason" shape `lastError`'s own docblock
 * says must not be possible. Fixed by gating that write on which cleanup this
 * is: `cleanupProbeProcess` now takes an explicit `isPrimaryCleanup` flag,
 * true only for the run's OWN process reaped from `runProbe`'s `finally`
 * (`priorAttempts === 0`, the same call whose outcome this run's `lastSuccess`
 * already describes) and false for every attempt `retryPendingCleanupOnce`
 * drives on a background survivor -- the background path no longer touches
 * `lastSuccess` at all, so a background pass, however it interleaves with a
 * concurrent handshake, cannot contaminate this run's result.
 *
 * Abandoning an entry does not kill it, and that is an accurate
 * description, not a claim nothing computes: the
 * engine was registered with `spawnOwnedChild` at spawn (acp-process.ts),
 * and `ACPProcess.forceGroupKill()` releases that registry record ONLY once
 * it has independently CONFIRMED the process is gone (never on SIGKILL
 * delivery alone, and never merely because an escalation reached it) -- so
 * a survivor abandoned here, whose kill was never
 * confirmed, still has its record for the host-wide orphan sweep in
 * `process-utils.ts` to find and reclaim once its actual owner (this
 * Station) is gone.
 */
export const MAX_CLEANUP_RETRY_ATTEMPTS = 5;

/**
 * The "4 concurrently-retained
 * survivors, worst case" claim in {@link MAX_CLEANUP_RETRY_ATTEMPTS}'s own
 * docblock was DERIVED, on the old serialized shape, from an invariant nothing
 * enforced directly -- every cycle retried the WHOLE set to completion before
 * its own new spawn even started, so exactly one entry could reach the
 * 5-attempt bound and get abandoned per cycle, capping steady-state size at 4
 * as a side effect of that ordering. Decoupling the retry from the probe (see
 * `retryPendingCleanup`'s call site) broke the invariant the derivation
 * depended on: attempts are now consumed at a rate bounded by pass duration,
 * while new entries can arrive at the probe's own (now much faster) cadence,
 * so the set is only stable while `cadence >= MAX_CLEANUP_RETRY_ATTEMPTS x
 * (time per attempt)` -- and nothing enforced that. A/B'd against
 * `origin/main` at a 50ms probe interval: `main` stayed flat at 4; this
 * branch, pre-fix, climbed past 20 within 25 cycles -- each one a live
 * orphaned engine at roughly archive#3422's measured ~300MB.
 *
 * This constant makes the bound structural instead of incidental:
 *
 * 1. What actually grows `pendingCleanup`'s size is `runProbe`'s own
 *    `pendingCleanup.set(process, 0)`, called ONCE per spawn, unconditionally,
 *    before `attemptCleanup` ever runs on that entry. `attemptCleanup` only
 *    ever decides whether an ALREADY-present entry stays (`.set` on an
 *    existing key, size unchanged) or leaves (`.delete`); it cannot make the
 *    set larger.
 *
 * 2. The bound `attemptCleanup` enforces is gated on `priorAttempts === 0`
 *    -- it refuses to let a NEW entry's own first retention decision keep it
 *    once `MAX_PENDING_CLEANUP_SIZE` OTHER entries are already retained, but
 *    never evicts an entry ALREADY retained to make room. Applying the check
 *    to every retention decision regardless of
 *    `priorAttempts` measurably inverts the allowance's intent
 *    (see the `- 1` paragraph below): under the un-isolated
 *    50ms-interval scenario, every one of 21 size-bound abandons had
 *    `otherRetainedCount === 4` WITH the run's own new process also already
 *    a set member (added by `runProbe` before its own `attemptCleanup`
 *    call) -- i.e. size 5, not 4. The concurrent BACKGROUND pass,
 *    re-attempting an already-retained OLDER
 *    survivor at that exact moment, saw the same "4 others" and evicted THAT
 *    entry mid-retry -- the new arrival was then retained against a set of
 *    3. Net effect measured: a survivor's real attempt count collapsed to
 *    ~2 under saturation (4,3,2,2,2,...,2,1,1,1 against the serialized
 *    shape's full 5,5,5,5,5,...,5,4,3,2,1), and {@link MAX_CLEANUP_RETRY_ATTEMPTS} became
 *    UNREACHABLE -- 0 of 21 abandonments in that run went through it,
 *    directly contradicting that constant's own "a transiently unkillable
 *    child gets repeated attempts rather than one." With the gate on
 *    `priorAttempts === 0`, at the same 50ms interval: flat at 4, all 16
 *    size-bound abandons at `attempts: 1` (new arrivals refused admission,
 *    nothing already retained evicted), and
 *    {@link MAX_CLEANUP_RETRY_ATTEMPTS} reachable again -- 5 retry-bound
 *    abandons against 0 before.
 *
 *    The per-process distribution does NOT return to the serialized
 *    shape's, and cannot: it
 *    bifurcates. Admitted entries age to the full 5; entries refused
 *    admission take exactly one attempt (measured
 *    5,5,5,5,1,1,1,1,5,1,...). Total destroy work is unchanged either way
 *    -- 50 attempts across 25 processes, mean 2.0, both before and after --
 *    because the aggregate budget under saturation is throughput-limited by
 *    the decoupling itself. The serialized shape spends 115 attempts on the
 *    same scenario only because it serialises, which is exactly what its
 *    ~662ms per Reconnect buys. What the gate restores is CONSECUTIVENESS, which is
 *    the property a transiently unkillable child actually needs: the same
 *    budget concentrated on a bounded working set instead of spread one
 *    attempt at a time across every survivor.
 *
 * Consequently: the set's RETAINED-member size never exceeds this number,
 * but the map's momentary size can reach one more -- this constant plus the
 * run's own new process, for the brief window between `runProbe`'s `set`
 * above and that same process's own `attemptCleanup` call deciding its
 * fate. Measured continuously, the decoupled shape peaks at 5 whenever a
 * probe is in flight; the serialized shape peaks at 4, since it never holds
 * a not-yet-decided entry in the map at all. "Never exceed this number" is
 * not the precise claim; what holds is narrower and stated here.
 *
 * `- 1`, not the bound itself: a NEWLY spawned process's own first cleanup
 * attempt (`priorAttempts === 0`, from `runProbe`'s own `finally`) must
 * always be free to make its OWN first attempt without being pre-empted by
 * an already-full set -- it is that attempt's OUTCOME (reap vs retain) that
 * decides whether it adds to the set at all, so the cap is checked against
 * how many OTHER entries are already retained, not including itself.
 *
 * Abandoning an entry here does not kill it, for the same reason
 * {@link MAX_CLEANUP_RETRY_ATTEMPTS}'s own "Abandoning an entry does not
 * kill it" paragraph documents for the attempt-bound path -- read that
 * paragraph for the mechanism (the owned-process registry record, and the
 * host-wide orphan sweep that eventually reclaims it). This path reaches
 * that same outcome SOONER than the attempt-bound path does, so a reader
 * following only this constant needs the same disclosure, not a
 * re-derivation of it.
 *
 * This bound's soundness depends on `probe()`'s `probeFlight` dedupe (see
 * that method): `priorAttempts === 0` is trustworthy as "the run's own
 * process, and only the run's own process" solely because at most ONE
 * `runProbe` is ever in flight per `ACPProbe` instance at a time. Without
 * that, two concurrent runs could each add a `priorAttempts === 0` entry,
 * and one run's background pass (or `dispose()`'s direct call) could decide
 * the OTHER run's still-in-flight entry's fate -- the same sharing this
 * constant's sibling fix (`isPrimaryCleanup` on {@link
 * ACPProbe.cleanupProbeProcess}) depends on `probeFlight` to rule out.
 */
export const MAX_PENDING_CLEANUP_SIZE = MAX_CLEANUP_RETRY_ATTEMPTS - 1;

/**
 * A probe failure reduced to text that may cross an API boundary.
 *
 * Message only -- no stack, no serialized cause. That much is structural, but
 * it is not by itself a safety argument: the message is engine-authored and a
 * spawn/handshake error routinely quotes the command line, so anything the
 * operator put in a connection's `args` (an `--api-key=…`, a token in a URL)
 * can appear in it. `redactSecrets` removes those.
 *
 * It deliberately stops there. The log sink additionally runs
 * `sanitizeFreeText`, which strips paths and URLs — correct for a log, wrong
 * here, because the whole value of this field is telling an operator WHICH
 * command in WHICH directory failed, and a spawn failure whose path has been
 * scrubbed answers nothing. So this is a weaker guarantee than the log's, by
 * choice: secrets out, operator-owned paths kept.
 */
function probeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * The availability probe's client. It exists to complete a handshake and tear
 * down, so it serves no session — but it is a real ACP peer on a real wire,
 * and Kiro under `--agent-engine v3` is evidenced sending its token-refresh
 * callback `_kiro/auth/getAccessToken` to the client BEFORE it answers
 * `initialize`, which is inside this probe's lifetime.
 *
 * `extMethod` therefore runs the same inbound-extension policy the chat
 * adapter runs: refuse with `-32601`, and never bridge a credential. It used
 * to be `async () => ({})` — the identical fabricated-empty-success defect,
 * on the identical credential channel, one file over.
 *
 * The probe also advertises no filesystem or terminal capability. The SDK's
 * Client shape still requires callbacks, so every such callback explicitly
 * refuses with JSON-RPC `-32601`; none can return a plausible empty/success
 * value if an agent sends an undeclared request during the handshake.
 */
function createProbeClient(onExtMethod: AcpInboundExtensionHandler): Client {
  const unsupported = (method: string): never => {
    throw RequestError.methodNotFound(method);
  };
  return {
    sessionUpdate: async () => {},
    requestPermission: async () =>
      ({ granted: false, outcome: { outcome: 'cancelled' } }) as any,
    readTextFile: async () => unsupported('fs/read_text_file'),
    writeTextFile: async () => unsupported('fs/write_text_file'),
    createTerminal: async () => unsupported('terminal/create'),
    terminalOutput: async () => unsupported('terminal/output'),
    releaseTerminal: async () => unsupported('terminal/release'),
    waitForTerminalExit: async () => unsupported('terminal/wait_for_exit'),
    killTerminal: async () => unsupported('terminal/kill'),
    extNotification: async () => {},
    extMethod: async (method, params) => onExtMethod(method, params),
  };
}

export class ACPProbe {
  cachedModes: Array<{ id: string; name: string; description?: string }> = [];
  cachedConfigOptions: any[] = [];
  cachedCapabilities: any = null;
  /**
   * archive#895 wave B: the full initialize agentCapabilities handshake (loadSession,
   * mcpCapabilities, sessionCapabilities, …), kept alongside the existing
   * `cachedCapabilities` (promptCapabilities-only, back-compat) rather than
   * replacing it — `getCapabilities()` stays as-is for existing callers.
   */
  cachedAgentCapabilities: InitializeResult['agentCapabilities'] | null = null;
  /** `null` means providers/list was not observed; an empty array is observed negative data. */
  cachedProviderRouting: ProviderInfo[] | null = null;
  /**
   * archive#1549: the instant of the last SUCCESSFUL `initialize` handshake,
   * NOT `lastProbeAt`. The two differ exactly where it matters: a failed
   * probe still bumps `lastProbeAt` while deliberately retaining the previous
   * (now stale) capability cache, so stamping evidence with `lastProbeAt`
   * would keep re-dating an observation nothing re-observed.
   *
   * Set on every successful handshake INCLUDING one that carried no
   * `agentCapabilities` at all (the field is optional in the ACP SDK and the
   * client does not default it). That case is a real observation with a real
   * answer — "Station met this CLI and it advertised nothing" — and must not
   * be confused with "Station has never met this CLI". Keying the timestamp
   * on capability PRESENCE instead would collapse the two and leave a
   * successfully-probed agent permanently reported as unchecked.
   *
   * `0` means no handshake has ever succeeded.
   *
   * archive#3404: MONOTONIC — set only by a successful handshake, and never
   * cleared. Clearing it on consecutive failures would make `> 0` mean "the
   * last two probes did not both fail" rather than "a handshake has
   * succeeded": two consecutive failures would put a long-known connection
   * back into "never handshaked", and this field carries two decisions
   * that read it as first contact: the cold-start budget in `runProbe` and
   * `PROBING` in `acp-manager-view.ts`. A permanently-broken engine that once
   * handshaked would go back onto the 60s cold budget and render
   * `PROBING` for ~72s on every 5-minute sweep — precisely the
   * slow-vs-broken confusion archive#3404 exists to remove, inverted.
   */
  lastHandshakeObservedAt = 0;
  lastProbeAt = 0;
  lastSuccess = false;
  /**
   * Why the most recent probe failed, as a message plus the phase it failed in
   * ('spawn', 'initialize', 'session creation', …). `null` after a successful
   * probe, so "unavailable with no reason" cannot outlive the failure that
   * caused it. The message is redacted at capture (see `probeErrorMessage`),
   * which is what makes it projectable — not the absence of a stack.
   */
  lastError: { message: string; phase: string } | null = null;
  /**
   * ONE inbound-extension handler for the whole probe's lifetime, not one
   * per probe run. `acp-manager.ts` re-probes every connection every 60s
   * with no staleness gate, so a per-run handler would re-log an identical
   * refusal every minute forever — the handler's own dedupe can only work
   * if the handler outlives the run. This is also the registry-scoping
   * property the policy module documents: one registry per connection,
   * referenced by nothing else.
   */
  private readonly inboundExtensionPolicy: AcpInboundExtensionHandler;
  /** Survivor → destroy attempts already spent on it. See {@link MAX_CLEANUP_RETRY_ATTEMPTS}. */
  private readonly pendingCleanup = new Map<ACPProcess, number>();
  /**
   * archive#3448: dedupes concurrent `retryPendingCleanup()` calls the same
   * way `probeFlight` dedupes concurrent `probe()` calls. Before this fix,
   * `runProbe` was the ONLY caller of `retryPendingCleanup`, and it awaited
   * it before doing anything else -- so at most one call ran at a time.
   * Firing it fire-and-forget from `runProbe` (see the call site) makes it
   * possible for a SECOND, independent call -- `dispose()` calls
   * `retryPendingCleanup()` directly, twice -- to start while the first is
   * still in flight. Without this join, two concurrent passes could both
   * read the same survivor out of `pendingCleanup`'s snapshot and destroy it
   * twice concurrently; joining the in-flight promise instead means
   * `dispose()` also correctly waits for a background retry a `runProbe`
   * left running, rather than racing it.
   */
  private cleanupRetryFlight: Promise<void> | null = null;
  private probeFlight: Promise<boolean> | null = null;
  private disposed = false;
  /**
   * archive#3404: aborted when `dispose()` is called, so an in-flight
   * handshake can be ABANDONED at once instead of waiting out its remaining
   * budget. `runProbe` only observes `disposed` BETWEEN phases, so without
   * this a dispose landing during a 60s cold `initialize` waited the full 60s
   * — and `dispose()` is what `removeConnection` awaits, which is what
   * PUT/DELETE/re-POST `/api/connections/acp` await inside the serialized
   * agent-configuration queue. A user editing a connection 5s into its cold
   * background sweep would have blocked ~67s there, against a 30s SDK client
   * deadline and a 20s desktop broker bound.
   *
   * A REMOVABLE listener, not a long-pending promise. This was first written
   * as a `Promise<void>` resolved by `dispose()`, which meant every
   * `.then()` `runWithinProbeDeadline` registered against it stayed attached
   * to a promise that is pending for the whole life of the connection —
   * unremovable by construction, and registered TWICE per probe run
   * (`initialize` and `session creation`). Measured on that shape: ~1,080
   * bytes retained per call, so a connection swept every ~5 minutes accrued
   * ~620KB/day and ~55MB after a month, and at shutdown every accumulated
   * reaction fired at once, each constructing an `Error` with a stack.
   * `AbortSignal` has the same "signal once, observe from anywhere" shape and
   * an `off` switch, so the race's `finally` can hand the memory back.
   */
  private readonly disposeRequested = new AbortController();

  constructor(
    private config: ACPConnectionConfig,
    // `warn` is what this class calls; `debug` is what it hands to ACPProcess
    // (acp-process.ts logs at debug), so the type covers both rather than
    // forcing a cast at the handoff. The point of typing it at all is that the
    // compiler now checks the ARGUMENT ORDER — untyped `any` is what let
    // pino-style (fields, message) through and killed engine probing.
    private logger: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'debug'>>,
    private managedWorkspaceHomeDir: string,
    private readonly processFactory: (
      options: ConstructorParameters<typeof ACPProcess>[0],
    ) => ACPProcess = (options) => new ACPProcess(options),
    private readonly operationTimeoutMs = 10_000,
    /**
     * archive#3526: injectable so a test can observe ONLY the emissions ITS
     * OWN probe instance produces. `acpProbeCleanupRetention` is one of many
     * OpenTelemetry counters `metrics.ts` creates via `meter.createCounter`;
     * in this repo's test environment nothing registers a real OTel
     * `MeterProvider` (`initializeTelemetry` in `telemetry.ts` only starts
     * one when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which no test/CI setup
     * here does), so `metrics.getMeter('station')` resolves OTel's
     * process-wide NOOP meter, whose `createCounter` hands back ONE
     * module-level singleton object for EVERY counter name and EVERY meter
     * in the process -- not merely every `ACPProbe` instance sharing this
     * one counter, but every counter `metrics.ts` exports sharing this one
     * `.add`. That is an environment fact, not an OTel API guarantee:
     * `@opentelemetry/sdk-metrics` returns a DISTINCT instrument per name
     * once a real `MeterProvider` is registered, and if this repo's test
     * setup ever starts registering one, `vi.resetModules()` re-importing
     * would begin isolating correctly on its own and this parameter becomes
     * belt-and-braces rather than the only mechanism that works. Note what
     * would NOT start working: a shared spy. `acpProbeCleanupRetention` is a
     * module-level `const`, so every probe built with the default holds that
     * one object whatever `createCounter` returned at module init —
     * registering a provider changes which counter the module resolves, not
     * the fact that all of its consumers share it. Confirmed live against a
     * real `MeterProvider`: instruments were distinct per name, and a shared
     * spy still observed a foreign probe's emit. It is also why re-importing this module under
     * `vi.resetModules()` does not help under the CURRENT (Noop) regime: a
     * fresh module instance still resolves that same process-wide singleton
     * (confirmed live -- the re-imported class was genuinely distinct, but
     * its `acpProbeCleanupRetention` was still `===` the original).
     * Defaults to the real counter for every production call site and every
     * test that does not need per-instance isolation; a few tests in
     * `acp-probe.test.ts` (see its archive#3526 comment above the telemetry
     * describe) pass their own disjoint `{ add: vi.fn() }` instead.
     */
    private readonly cleanupRetentionRecorder: Pick<
      typeof acpProbeCleanupRetention,
      'add'
    > = acpProbeCleanupRetention,
  ) {
    this.inboundExtensionPolicy = createAcpInboundExtensionRequestHandler({
      logger: this.logger,
      connectionId: `probe:${this.config.id}`,
    });
  }

  /**
   * archive#1088: the ONE directory this probe both spawns the engine CLI in
   * and hands it as the `session/new` cwd.
   *
   * Before this there were two, and they disagreed: the spawn used
   * `config.cwd ?? this.cwd` while `newSession()` was passed `this.cwd`
   * unconditionally, so a connection WITH a configured directory had its CLI
   * launched there and then told its session lived somewhere else entirely.
   *
   * An unconfigured probe uses a deterministic private workspace under
   * Station home, disjoint from every session workspace. That prevents an
   * indexing engine from scanning HOME while allowing repeated probes of the
   * same connection to reuse their harmless empty cwd.
   *
   * `||` and `expandTilde` for the same two reasons the adapter documents
   * (acp-adapter.ts, archive#1087): the connection form persists `cwd: ""` for an
   * untouched field and `spawn` reads `cwd: ''` as "inherit the parent's",
   * and this field is free text that users fill in with a literal `~`.
   * `??` and no expansion were how the probe kept both bugs after the adapter
   * was fixed.
   *
   * Deliberately NOT dropping `session/new` (the issue asks whether the probe
   * needs it): `sessionResult.modes` and `configOptions` are the probe's
   * entire reason for existing — they populate the Connections hub's mode and
   * model pickers. `initialize` alone does not carry them.
   */
  private async probeCwd(): Promise<string> {
    // `resolve`, not just `expandTilde`: a relative `config.cwd` is free text
    // from the Connections form and the route schema does not constrain its
    // shape. Unresolved, `spawn` interprets it against Station's own directory
    // — so `cwd: "."` lands the agent in the install root, which is the exact
    // outcome archive#1088 is named after, and `".."` walks further out. It also
    // reached `session/new`, where a relative path means something different
    // to the agent than it does to Station.
    const configured = this.config.cwd
      ? resolve(expandTilde(this.config.cwd))
      : '';
    return (
      configured ||
      (await prepareManagedAcpWorkspace(
        { kind: 'probe', connectionId: this.config.id },
        this.managedWorkspaceHomeDir,
      ))
    );
  }

  /**
   * `initiator` selects the deadline budget — see {@link ACPProbeInitiator}.
   * A caller that joins an already-in-flight probe gets THAT probe's budget,
   * not its own: the dedupe exists so two callers cannot spawn two engines
   * for one connection, and abandoning the join to honour a shorter budget
   * would report failure for a handshake that is still running and may be
   * about to succeed.
   */
  async probe(initiator: ACPProbeInitiator = 'request'): Promise<boolean> {
    if (this.disposed) return false;
    if (this.probeFlight) return this.probeFlight;

    const operation = this.runProbe(initiator);
    this.probeFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.probeFlight === operation) this.probeFlight = null;
    }
  }

  private async runProbe(initiator: ACPProbeInitiator): Promise<boolean> {
    // archive#3404: "first contact" is `lastHandshakeObservedAt === 0` — no
    // `initialize` has ever SUCCEEDED — not `lastProbeAt === 0`. Both fields
    // are monotonic (see the field's own note: the reset that used to make
    // this contrast false was removed), so the difference between them is
    // only what they record. `lastProbeAt` is stamped on every terminal path
    // in this method, including ones that never reached the engine at all (a
    // cleanup-retry failure, a workspace-preparation failure, a
    // process-factory throw such as an ENOENT for an engine that is not
    // installed yet). Keying the budget on it made the cold allowance one-shot per
    // probe OBJECT, consumed by whichever attempt happened to be first: probe
    // an engine before it is installed, ENOENT in ~30ms, and the connection
    // is then permanently on the warm budget against a stone-cold engine.
    // This is the same discriminator `acp-manager-view.ts` reads to classify
    // `PROBING`, so both decisions now derive from ONE notion of first
    // contact rather than two that disagree.
    //
    // The cold budget additionally requires that nothing is waiting on this
    // probe. See {@link ACPProbeInitiator}: on the request path the enlarged
    // budget would outlive the client deadlines above it and hold the
    // serialized agent-configuration queue while doing so.
    const probeBudgetMs =
      this.lastHandshakeObservedAt === 0 && initiator === 'background'
        ? COLD_START_OPERATION_TIMEOUT_MS
        : this.operationTimeoutMs;
    // archive#3448: fire-and-forget, NOT awaited. This used to be the first
    // AWAITED statement in this method, so every caller of `probe()` -- the
    // user-facing Reconnect route included -- paid the full retry cost for
    // every survivor still pending from earlier cycles before a fresh engine
    // could even be spawned (see MAX_CLEANUP_RETRY_ATTEMPTS's docblock for the
    // measured aggregate: ~20s steady-state, ~60s when destroys hang).
    // Nothing about spawning a fresh engine depends on prior survivors being
    // reaped first, so retrying them concurrently with the rest of this run
    // removes that cost from every caller's return value instead of merely
    // shrinking it. `retryPendingCleanup` is documented as never throwing
    // against the real destroy chain (see its own docblock); the `.catch`
    // below exists only so a conforming-but-rejecting override can never
    // produce an unhandled rejection.
    //
    // archive#3448 L-4 disclosure: the awaited call this replaced had its
    // own `try/catch` here, which on a rejection set `lastError = {message,
    // phase: 'cleanup retry'}`, logged 'ACPProbe cleanup retry failed;
    // skipping a new probe', and returned `false` WITHOUT attempting a new
    // spawn at all. None of that survives the move to fire-and-forget: a
    // rejection here now only logs the generic warning below, never sets
    // `lastError`, and never skips the spawn that follows. Against the real
    // `retryPendingCleanup` chain this is moot -- its own docblock
    // establishes it does not throw, and no test asserted the old
    // behaviour -- but it is a real, if inert, behavioural change that
    // vanished silently rather than being called out.
    void this.retryPendingCleanup().catch((error) => {
      this.logger.warn('ACPProbe cleanup retry failed', {
        err: error,
        id: this.config.id,
      });
    });
    if (this.disposed) return false;

    let cwd: string;
    try {
      cwd = await this.probeCwd();
    } catch (error) {
      this.lastProbeAt = Date.now();
      this.lastSuccess = false;
      this.lastError = {
        message: probeErrorMessage(error),
        phase: 'workspace preparation',
      };
      this.logger.warn(
        'ACPProbe workspace preparation failed; skipping spawn',
        {
          err: error,
          id: this.config.id,
        },
      );
      return false;
    }
    // Tracks which step of the probe is in flight so a failure can be
    // attributed; 'spawn' covers the process factory itself, which sits
    // before either deadline-labelled phase.
    let probePhase = 'spawn';
    let process: ACPProcess;
    try {
      process = this.processFactory({
        command: this.config.command,
        args: this.config.args,
        cwd,
        createClient: () => createProbeClient(this.inboundExtensionPolicy),
        clientCapabilities: {},
        logger: this.logger,
      });
    } catch (err) {
      // Mark the probe failed, not merely annotated. Recording a reason while
      // leaving `lastSuccess`/`lastProbeAt` untouched would let a previously
      // healthy connection report AVAILABLE while carrying a non-null
      // `lastError` -- a reason contradicting the status beside it, which is
      // the exact shape this field exists to remove.
      this.lastProbeAt = Date.now();
      this.lastSuccess = false;
      this.lastError = {
        message: probeErrorMessage(err),
        phase: probePhase,
      };
      throw err;
    }
    this.pendingCleanup.set(process, 0);

    // ONE deadline for the whole handshake, shared by both phases, rather
    // than a fresh `probeBudgetMs` each. A per-phase allowance makes the
    // handshake cost TWICE the number the budget names, and that total is
    // what an awaiting client and the serialized agent-configuration queue
    // actually pay. `remainingHandshakeMs` is clamped at 0 so a phase that
    // starts after the budget is already spent fails immediately instead of
    // arming a timer with a negative delay (which fires at once anyway, but
    // would report a negative duration in the failure message).
    const handshakeDeadlineAt = Date.now() + probeBudgetMs;
    const remainingHandshakeMs = () =>
      Math.max(0, handshakeDeadlineAt - Date.now());

    try {
      probePhase = 'initialize';
      const initResult = await this.runWithinProbeDeadline(
        process.start(),
        'initialize',
        remainingHandshakeMs(),
        probeBudgetMs,
      );
      if (this.disposed) return false;
      probePhase = 'session creation';
      const sessionResult = await this.runWithinProbeDeadline(
        process.newSession(cwd),
        'session creation',
        remainingHandshakeMs(),
        probeBudgetMs,
      );
      if (this.disposed) return false;

      this.cachedModes = sessionResult.modes?.availableModes ?? [];
      this.cachedConfigOptions = sessionResult.configOptions ?? [];
      this.cachedCapabilities =
        initResult.agentCapabilities?.promptCapabilities ?? null;
      this.cachedAgentCapabilities = initResult.agentCapabilities ?? null;
      this.cachedProviderRouting = initResult.providerRouting ?? null;
      this.lastHandshakeObservedAt = Date.now();
      this.lastSuccess = true;
      this.lastError = null;
    } catch (err) {
      if (this.disposed) {
        this.lastSuccess = false;
        return false;
      }
      this.lastError = {
        message: probeErrorMessage(err),
        phase: probePhase,
      };
      // archive#3404: "has this connection ever handshaked" is
      // `lastHandshakeObservedAt > 0`, NOT `lastSuccess`. `lastSuccess` holds
      // the PREVIOUS run's outcome here (nothing resets it at run entry), so
      // reading it as "has ever succeeded" would make the branch mean "the
      // previous run also failed" — success, fail, fail takes the `else` and
      // discards a real handshake observation.
      if (this.lastHandshakeObservedAt > 0) {
        this.logger.warn('ACPProbe failed; retaining stale cache', {
          err,
          id: this.config.id,
        });
      } else {
        // A connection that has never succeeded is the hardest one to
        // diagnose from status alone, so the failure must reach the logs —
        // there is no cache to retain, only the reason it never worked.
        this.logger.warn('ACPProbe failed; no cache to retain', {
          err,
          id: this.config.id,
        });
        this.cachedModes = [];
        this.cachedConfigOptions = [];
        this.cachedCapabilities = null;
        this.cachedAgentCapabilities = null;
        this.cachedProviderRouting = null;
      }
      this.lastSuccess = false;
    } finally {
      this.lastProbeAt = Date.now();
      // Drop it only once it is actually gone. This is the primary reaping
      // path -- a survivor removed here never reaches retryPendingCleanup at
      // all, which is how a live owner ended up holding engines it had no
      // remaining reference to (archive#3422). Attempt bookkeeping and the
      // retry bound live in attemptCleanup (archive#3441), shared with
      // retryPendingCleanup so the two paths cannot drift.
      await this.attemptCleanup(process, 0);
    }

    return this.lastSuccess;
  }

  /**
   * archive#1863: the destroy path must NOT be silently abandoned. See
   * {@link destroyProcessWithEscalation} for the mechanism. The deadline is
   * guaranteed above destroy()'s own escalation so a healthy destroy wins; a
   * miss escalates to a group SIGKILL.
   *
   * `isPrimaryCleanup` gates
   * whether a miss may write `this.lastSuccess = false`. `onMiss` fires on
   * ANY destroy-race miss, including the ordinary "destroy() rejects quickly
   * but never confirms" mode (measured ~1.0-1.2s in {@link
   * MAX_CLEANUP_RETRY_ATTEMPTS}'s own docblock), not only a full deadline
   * miss. `retryPendingCleanupOnce` now drives this concurrently with an
   * in-flight handshake (archive#3448), so a background survivor's miss
   * could otherwise overwrite THIS run's own, independently-derived
   * `lastSuccess` -- flipping a probe that just handshaked successfully to
   * reporting unavailable, with `lastError` left `null` (no catch block runs
   * for it), which is exactly the "unavailable with no reason" shape that
   * field's docblock says must never happen. Only the run's OWN process --
   * reaped from `runProbe`'s `finally` with `priorAttempts === 0`, the one
   * call whose outcome this run's `lastSuccess` is actually about -- may
   * still write it; every attempt `retryPendingCleanupOnce` drives on a
   * background survivor must not, regardless of how it interleaves with a
   * concurrent handshake.
   *
   * `priorAttempts === 0` identifies "the run's own process" only because
   * `probe()`'s `probeFlight` dedupe guarantees at most one `runProbe` is
   * ever in flight per `ACPProbe` instance at a time -- with two concurrent
   * runs (not possible today), a background pass from ONE could reach the
   * OTHER's freshly-added, still-mid-handshake entry (also `priorAttempts
   * === 0`) and write `lastSuccess` for a result that call never produced.
   */
  private async cleanupProbeProcess(
    process: ACPProcess,
    isPrimaryCleanup: boolean,
  ): Promise<void> {
    const deadlineMs = Math.max(
      this.operationTimeoutMs,
      DESTROY_ESCALATION_UPPER_BOUND_MS,
    );
    await destroyProcessWithEscalation(process, deadlineMs, (error) => {
      if (isPrimaryCleanup) {
        this.lastSuccess = false;
      }
      this.logger.warn(
        'ACPProbe process cleanup missed its deadline; escalating to group SIGKILL',
        { err: error, id: this.config.id, isPrimaryCleanup },
      );
    });
  }

  /**
   * Race an operation against the probe deadline. When the deadline wins, the
   * operation is intentionally left running in the background and its eventual
   * rejection is swallowed (`void operation.catch`): the probe's `finally`
   * destroys the process regardless, so a hung start/session is reclaimed by
   * `cleanupProbeProcess` rather than by this race.
   *
   * archive#1863: this is why `destroy()` NO LONGER goes through this helper —
   * there is no further cleanup after destroy, so abandoning it there leaked
   * the engine. Destroy now uses `cleanupProbeProcess`, which escalates to a
   * group SIGKILL on a miss instead of abandoning.
   */
  private async runWithinProbeDeadline<T>(
    operation: Promise<T>,
    phase: string,
    remainingMs: number,
    budgetMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              // Both numbers, because the budget is shared: the phase failed
              // after `remainingMs`, and the reason it had only that much is
              // the `budgetMs` total the earlier phase drew from.
              `ACP probe ${phase} did not settle within its ${remainingMs}ms share of the ${budgetMs}ms probe budget.`,
            ),
          ),
        remainingMs,
      );
    });
    // archive#3404: the third racer collapses the remaining budget the moment
    // `dispose()` is called. The probe's result is worthless once its owner is
    // being torn down (the connection is being removed or replaced by a fresh
    // probe), and the caller of `dispose()` is an HTTP request — so waiting
    // out a cold engine's 60s here is latency paid for an answer nobody reads.
    // The abandoned `operation` is handled exactly as the deadline case
    // handles it: left running, its rejection swallowed, and the process
    // reclaimed by `cleanupProbeProcess` in `runProbe`'s `finally`.
    // The listener is REMOVED in the `finally` below. `disposeRequested` lives
    // as long as the connection and this method runs twice per probe run, so
    // an observer that could not be detached would accumulate on it for the
    // life of the process — see the field's own note.
    const abandoned = () =>
      new Error(`ACP probe ${phase} was abandoned: the probe was disposed.`);
    const disposeSignal = this.disposeRequested.signal;
    let onAbort: (() => void) | undefined;
    const abandonOnDispose = new Promise<never>((_, reject) => {
      // Already disposed: reject now rather than wait for an abort that has
      // already happened and will never fire again.
      if (disposeSignal.aborted) {
        reject(abandoned());
        return;
      }
      onAbort = () => reject(abandoned());
      disposeSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, deadline, abandonOnDispose]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) disposeSignal.removeEventListener('abort', onAbort);
      void operation.catch(() => undefined);
      // A dispose landing between the race settling and this line still
      // rejects `abandonOnDispose`, and nothing downstream is holding it.
      void abandonOnDispose.catch(() => undefined);
    }
  }

  getModes() {
    return this.cachedModes;
  }
  getConfigOptions() {
    return this.cachedConfigOptions;
  }
  getCapabilities() {
    return this.cachedCapabilities;
  }
  /** archive#895 wave B: the full initialize agentCapabilities handshake — evidence only. */
  getAgentCapabilities(): InitializeResult['agentCapabilities'] | null {
    return this.cachedAgentCapabilities;
  }
  getProviderRouting(): ProviderInfo[] | null {
    return this.cachedProviderRouting;
  }

  /** Run a capability-gated provider mutation on a fresh, bounded ACP connection. */
  async setProvider(input: SetProviderRequest): Promise<void> {
    await this.mutateProvider((process) => process.setProvider(input));
  }

  /** Run a capability-gated provider disable on a fresh, bounded ACP connection. */
  async disableProvider(providerId: string): Promise<void> {
    await this.mutateProvider((process) => process.disableProvider(providerId));
  }

  private async mutateProvider(
    operation: (process: ACPProcess) => Promise<unknown>,
  ): Promise<void> {
    if (this.disposed) throw new Error('ACP probe is disposed.');
    const cwd = await this.probeCwd();
    const process = this.processFactory({
      command: this.config.command,
      args: this.config.args,
      cwd,
      createClient: () => createProbeClient(this.inboundExtensionPolicy),
      clientCapabilities: {},
      logger: this.logger,
    });
    this.pendingCleanup.set(process, 0);
    try {
      await this.runWithinProbeDeadline(
        process.start(),
        'initialize',
        this.operationTimeoutMs,
        this.operationTimeoutMs,
      );
      await this.runWithinProbeDeadline(
        operation(process),
        'provider mutation',
        this.operationTimeoutMs,
        this.operationTimeoutMs,
      );
    } finally {
      await this.attemptCleanup(process, 0);
    }
    // Refresh the manager's declared-vs-observed projection from a complete
    // probe only after the mutation itself succeeded.
    await this.probe('request');
  }
  /**
   * archive#1549: when the last SUCCESSFUL handshake was observed (epoch ms),
   * or `0` when none ever has. Paired with `getAgentCapabilities` so a
   * consumer deriving a `ControlPlaneObservation` can date the evidence
   * honestly instead of stamping it "now" — and so that a handshake carrying
   * NO capabilities is still an observation, with the answer "no".
   */
  getHandshakeObservedAt(): number {
    return this.lastHandshakeObservedAt;
  }
  isAvailable() {
    return this.lastSuccess;
  }

  /**
   * archive#3404: whether a probe run is currently in flight. The manager
   * view reads this so a connection whose FIRST handshake is still
   * outstanding reports `PROBING` instead of `UNAVAILABLE` — without it, a
   * slow-starting engine that already burnt its first (cold-timed-out) probe
   * is indistinguishable from a broken one until a later probe happens to
   * succeed.
   */
  isProbeInFlight(): boolean {
    return this.probeFlight !== null;
  }

  /**
   * archive#3404: `disposed` alone is only observed BETWEEN handshake phases,
   * so signalling `disposeRequested` is what makes this bounded by cleanup
   * work rather than by whatever budget the in-flight probe happens to be on.
   * The wait that remains is `cleanupProbeProcess`'s
   * `max(operationTimeoutMs, 5,000) + 2,000` per retained engine, which is the
   * same wait `main` had — the unbounded handshake join is what this removes.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.disposeRequested.abort();
    try {
      await this.retryPendingCleanup();
    } catch {
      // The active probe's finally block gets one more cleanup attempt.
    }
    // `.catch` rather than a bare await: the process-factory path RETHROWS out
    // of `runProbe`, and a rejection here would skip the second cleanup pass
    // below — the one that exists to reap an engine the aborted run retained.
    await this.probeFlight?.catch(() => undefined);
    await this.retryPendingCleanup();
  }

  /**
   * archive#3448: joins an already-in-flight call instead of starting a
   * second one -- see {@link ACPProbe.cleanupRetryFlight}'s own note for why
   * that join is needed once `runProbe` stopped awaiting this before
   * spawning. The actual retry loop, and the "does not throw" guarantee that
   * makes this join-or-run wrapper itself non-throwing, live in {@link
   * ACPProbe.retryPendingCleanupOnce}.
   */
  private async retryPendingCleanup(): Promise<void> {
    if (this.cleanupRetryFlight) return this.cleanupRetryFlight;
    const operation = this.retryPendingCleanupOnce();
    this.cleanupRetryFlight = operation;
    try {
      await operation;
    } finally {
      if (this.cleanupRetryFlight === operation) this.cleanupRetryFlight = null;
    }
  }

  /**
   * Retry cleanup for any probe processes that did not settle through their
   * own `finally` block. `cleanupProbeProcess` delegates to
   * `destroyProcessWithEscalation`, whose catch/finally absorb every rejection
   * path (the graceful destroy miss is caught, the second destroy is
   * `.catch`-guarded, and the timer is cleared in `finally`), so this method
   * does not throw. archive#1863 M3: the previous `AggregateError` throw was
   * unreachable dead code; it was removed rather than left as a guard whose
   * rejection path never executes (the repo's founding finding).
   *
   * archive#3441 LOW-3: this claim also depends on `attemptCleanup`'s calls
   * into `ACPProcess.survivesCleanup()` and (via `forceGroupKill()`)
   * `waitUntilProcessGone()` never rejecting either -- the default
   * `probeIdentity` never does, but the option is injectable, and neither of
   * those two call sites guarded against a rejecting one before this fix
   * round. Both now fail closed (a probe that cannot answer is never read as
   * confirmation of death), which is what makes this docblock's "does not
   * throw" true of the WHOLE call chain, not just
   * `destroyProcessWithEscalation`'s own local absorption.
   *
   * archive#3422: this set is named for retrying, and used to forget instead.
   * It dropped every entry unconditionally, and `destroyProcessWithEscalation`
   * never throws -- it catches and escalates -- so a process that SURVIVED its
   * own reaping was indistinguishable from one that died, and was removed from
   * the only list that would have brought Station back to it. Measured: 21
   * orphaned engines at ~300MB each on one host, 12 under a live owner that
   * had no remaining reference to any of them.
   *
   * Keep a survivor and try again next cycle, up to {@link
   * MAX_CLEANUP_RETRY_ATTEMPTS} (archive#3441 -- the original fix had no
   * cap). The probe runs about once a minute, so a transiently unkillable
   * child gets repeated attempts rather than one, and a permanently
   * unkillable one is abandoned rather than accumulating forever.
   *
   * archive#3448: this loop, and every attempt it drives, now runs
   * concurrently with the rest of `runProbe` (see that call site) rather than
   * gating it -- callers of `probe()` observe none of this method's wall time.
   */
  private async retryPendingCleanupOnce(): Promise<void> {
    // Snapshot the entries: `attemptCleanup` mutates `pendingCleanup`
    // (delete/set) as it goes, and iterating the live map while mutating it
    // would either skip an entry or reprocess one added mid-loop.
    for (const [process, attempts] of Array.from(this.pendingCleanup)) {
      await this.attemptCleanup(process, attempts);
    }
  }

  /**
   * archive#3441: the one place that attempts a survivor's destroy again and
   * decides whether to retain it, so `runProbe`'s finally block and
   * `retryPendingCleanup` cannot drift into two different retention rules.
   * `priorAttempts` is the number of destroy attempts already spent on this
   * process (0 for one freshly added by `runProbe`).
   *
   * archive#3441 MEDIUM-1: for a RETRY (`priorAttempts > 0` -- this entry was
   * carried over from an earlier cycle, so real time has passed since it was
   * last checked), ask identity BEFORE signalling, not only after.
   * `cleanupProbeProcess` signals the pid unconditionally; checking identity
   * only afterward (the pre-fix order) meant every retry cycle delivered at
   * least one real SIGTERM/SIGKILL to whatever pid this entry names, even
   * when that pid had already been recycled by an unrelated process between
   * cycles. A pid `survivesCleanup()` no longer recognizes as this object's
   * own (dead, or a birth-fingerprint mismatch) is treated exactly like a
   * reaped one -- there is nothing left here for Station to signal. The
   * FIRST attempt (`priorAttempts === 0`, from `runProbe`'s own finally,
   * called in the same cycle the process was spawned) does not need this:
   * no cycle boundary has passed for the pid to have been reused across.
   *
   * archive#3448 L-2 disclosure, not fixed here: the identity check above is
   * a PRE-check, taken once before `cleanupProbeProcess` runs. Inside it,
   * `destroy()` rejecting escalates to `forceGroupKill()`, which signals
   * `-pid` with no re-check of its own -- so between this method's identity
   * check and that signal (destroy's own race window, plus whatever
   * `forceGroupKill` takes to act), the pid could be recycled by an
   * unrelated process and still receive the group-kill. This window existed
   * before archive#3448; what changed is that it runs CONCURRENTLY with
   * `processFactory` spawning this SAME probe's next engine (retries are no
   * longer serialized ahead of a fresh spawn), so the freshly-spawned
   * process is a candidate for that recycled pid in a way it was not when
   * the retry fully completed before the next spawn started. Low
   * probability -- pid reuse within one escalation's own short race window,
   * landing on this probe's own next spawn specifically -- and a
   * disclosed, unfixed gap.
   *
   * `priorAttempts === 0` also selects
   * `isPrimaryCleanup` for {@link ACPProbe.cleanupProbeProcess} -- see that
   * parameter's own docblock for why the contamination fix depends
   * on it, and {@link MAX_PENDING_CLEANUP_SIZE} for the set-size cap
   * this method also enforces below.
   */
  private async attemptCleanup(
    process: ACPProcess,
    priorAttempts: number,
  ): Promise<void> {
    if (priorAttempts > 0 && !(await process.survivesCleanup())) {
      this.pendingCleanup.delete(process);
      // archive#3441 LOW-1: this pre-check confirmed the pid is gone (dead,
      // or reused by a different process) without ever signalling it -- but
      // an EARLIER attempt's SIGKILL is very plausibly why, and that
      // attempt's own `forceGroupKill()` may not have been the one to
      // observe it (its confirm window can close before the kernel reaps a
      // still-terminating process). This is that confirmation, on a later
      // cycle; release now rather than leaving the registry record for this
      // Station's own eventual restart sweep to find.
      process.releaseIfConfirmedGone();
      this.cleanupRetentionRecorder.add(1, { outcome: 'reaped' });
      return;
    }
    await this.cleanupProbeProcess(process, priorAttempts === 0);
    // Retention buys nothing once disposed -- no probe will revisit the set,
    // and holding entries makes shutdown pay a destroy race per survivor,
    // per connection. An overrun shutdown is SIGKILLed, which is one of the
    // conditions that produces orphans in the first place.
    if (this.disposed) {
      this.pendingCleanup.delete(process);
      return;
    }
    if (!(await process.survivesCleanup())) {
      this.pendingCleanup.delete(process);
      // archive#3441 LOW-1: `cleanupProbeProcess` above may have released
      // this already (a confirmed `forceGroupKill()`, or a successful
      // `destroy()`) -- `releaseIfConfirmedGone` is idempotent, so a second
      // call here is a no-op in that case. It is NOT a no-op when the
      // confirm window timed out (no release, correctly, per HIGH-1) and the
      // process died shortly after: this `survivesCleanup()` call is what
      // notices, and without this release the record would otherwise leak
      // for this Station's entire remaining lifetime.
      process.releaseIfConfirmedGone();
      this.cleanupRetentionRecorder.add(1, { outcome: 'reaped' });
      return;
    }
    const attempts = priorAttempts + 1;
    if (attempts >= MAX_CLEANUP_RETRY_ATTEMPTS) {
      this.pendingCleanup.delete(process);
      this.logger.warn(
        'ACPProbe engine survived cleanup across the retry bound; abandoning further attempts',
        { id: this.config.id, attempts },
      );
      this.cleanupRetentionRecorder.add(1, { outcome: 'abandoned' });
      return;
    }
    // Gated on `priorAttempts === 0` --
    // ONLY a brand-new entry's own first retention decision can grow
    // `pendingCleanup`'s size at all (it is already a member by this point,
    // added in `runProbe` before it was ever attempted -- see that call
    // site -- so `size - 1` counts how many OTHER survivors are already
    // retained). An EXISTING entry being retried again (`priorAttempts >
    // 0`) never changes the set's size by retaining -- it is already
    // counted -- so applying the same check there does not defend the
    // bound, it just evicts an already-retained survivor mid-retry instead
    // of refusing the arrival that actually grows the set.
    //
    // Applying the check unconditionally would be measurably wrong:
    // under the un-isolated 50ms-interval scenario, EVERY one of 21
    // size-bound abandons had `otherRetainedCount === 4` with the subject
    // ALSO in the set -- i.e. size 5, the run's own new process being the
    // fifth member. The concurrent background pass, re-attempting an
    // ALREADY-RETAINED survivor at that exact moment, saw the same
    // count and evicted THAT older entry mid-retry instead -- the new
    // process was then retained against a set of 3. Net effect: a
    // survivor's real attempt count collapsed to ~2
    // (4,3,2,2,2,...,2,1,1,1) against the serialized shape's full 5
    // (5,5,5,5,5,...,5,4,3,2,1),
    // and `MAX_CLEANUP_RETRY_ATTEMPTS` became unreachable -- 0 of 21
    // abandonments in that run went through it, directly contradicting
    // {@link MAX_CLEANUP_RETRY_ATTEMPTS}'s own "a transiently unkillable
    // child gets repeated attempts rather than one." The gate matches
    // the ALLOWANCE's documented intent
    // exactly: a newly spawned process's own first attempt can still be
    // refused ADMISSION when the set is already full, but nothing already
    // admitted is evicted to make room for it. See {@link
    // MAX_CLEANUP_RETRY_ATTEMPTS}'s own "Abandoning an entry does not kill
    // it" paragraph for what happens to an entry abandoned by either path --
    // this one reaches that outcome sooner.
    if (priorAttempts === 0) {
      const otherRetainedCount = this.pendingCleanup.size - 1;
      if (otherRetainedCount >= MAX_PENDING_CLEANUP_SIZE) {
        this.pendingCleanup.delete(process);
        this.logger.warn(
          'ACPProbe engine survived cleanup but the pending-cleanup set is already at its size bound; abandoning early rather than growing it further',
          {
            id: this.config.id,
            attempts,
            otherRetainedCount,
            maxPendingCleanupSize: MAX_PENDING_CLEANUP_SIZE,
          },
        );
        this.cleanupRetentionRecorder.add(1, {
          outcome: 'abandoned',
          reason: 'set-size-bound',
        });
        return;
      }
    }
    this.pendingCleanup.set(process, attempts);
    this.logger.warn(
      'ACPProbe engine survived cleanup; retaining it for another attempt',
      { id: this.config.id, attempts },
    );
    this.cleanupRetentionRecorder.add(1, { outcome: 'retained' });
  }
}
