import type { ModelLaunchCapabilities } from '@kontourai/station-contracts/provider';
import type { ProviderSession } from '../adapter-shape.js';

/**
 * What muse can actually deliver for model selection, declared ONCE.
 *
 * Two independent gates read a launch declaration before a muse turn can
 * carry a model: `MuseAdapter.metadata.modelLaunch` (the dispatch-time gate in
 * `orchestration-service.ts`) and `launchCapabilities()` in
 * `execution-target-resolver.ts` (the pre-dispatch gate, a hardcoded
 * per-provider table). They are separate tables that must agree, so both read
 * this constant rather than restating it — a divergence would accept a model
 * at one gate and refuse it at the other.
 *
 * What muse supports, and nothing more:
 * - `muse exec --model <ID>` is validated against muse's OWN catalog (an
 *   unknown id exits 1 with a catalog error before any JSONL), so an override
 *   is genuinely applied at start and on every turn — every turn is its own
 *   process, so there is no session-level switch to miss.
 * - Omission retains the session's accepted selector, because that is exactly
 *   what `sendTurn` does (`input.modelId ?? record.modelId`).
 * - Resume is NOT claimed anywhere for muse (no `resume` capability, no
 *   `adoptSession`), so an override at resume is refused rather than declared
 *   on the strength of the per-turn flag.
 *
 * One caveat this table cannot express, stated here so a reader of the
 * declaration meets it: under the `echo` startup provider (#550), muse REFUSES
 * `--model` outright (`--model requires --provider meta`, exit 2 before any
 * JSONL; live-verified against Muse Code 1.0.1-R1848.1), so `buildMuseExecArgs` drops the selection there and this table's
 * claims describe `meta` — muse's default and the only provider a Station
 * deployment runs by default. `echo` is reachable only through the
 * `STATION_E2E_MUSE_PROVIDER` test-determinism knob, whose whole purpose is a
 * run with no model behind it.
 */
export const MUSE_MODEL_LAUNCH: ModelLaunchCapabilities = {
  defaultAtStart: 'engine-selected',
  omissionAtResume: 'retain-session-model',
  omissionPerTurn: 'retain-session-model',
  overrideAtStart: true,
  overrideAtResume: false,
  overridePerTurn: true,
};

/**
 * The two startup providers `muse exec --provider <MODE>` accepts, exactly as
 * `muse exec --help` spells them ("Startup provider: echo or meta (default:
 * meta)"). Declared as a closed vocabulary because the value becomes engine
 * ARGV: anything outside this list is refused rather than forwarded, so a
 * hostile or fat-fingered configuration cannot inject a flag of its own into
 * the binary's option surface (the same line `install-provenance.ts` draws
 * before a value reaches `git ls-remote`).
 *
 * `meta` is muse's own default. Naming it explicitly is a no-op on the wire
 * and is admitted only so the knob speaks muse's vocabulary rather than a
 * Station-invented subset.
 */
export const MUSE_PROVIDER_MODES = ['echo', 'meta'] as const;

export type MuseProviderMode = (typeof MUSE_PROVIDER_MODES)[number];

export function isMuseProviderMode(value: string): value is MuseProviderMode {
  return (MUSE_PROVIDER_MODES as readonly string[]).includes(value);
}

/**
 * Structural view of the per-turn `muse exec --json` child.
 *
 * Deliberately narrower than `CodexProcessLike`: muse never reads from stdin
 * (the prompt rides argv), so there is no `stdin` member here and no way for
 * an adapter path to accidentally write to a process that isn't listening.
 * Declared structurally so tests can inject an EventEmitter + PassThrough
 * double without importing `node:child_process` (see the resource-manifest
 * gate in `scripts/vitest-resource-manifest.mjs`).
 */
export interface MuseProcessLike {
  readonly pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
  removeListener(event: 'exit', listener: (code: number | null) => void): this;
}

/**
 * The live child for one turn. Muse's contract is one process PER TURN:
 * `muse exec --json` streams JSONL for a single prompt and exits, so this
 * record is created at `sendTurn` and torn down when that turn terminates.
 */
/** What a spawn factory hands back for one turn. */
export interface MuseSpawnResult {
  process: MuseProcessLike;
  /**
   * Drops the owned-process registry record for this child (see
   * `spawnOwnedChild`). A per-turn spawner would otherwise leave one record
   * per turn behind for the startup sweep to read.
   */
  release?: () => void;
}

export interface MuseActiveTurn {
  turnId: string;
  process: MuseProcessLike;
  release?: () => void;
  startedAt: number;
  /**
   * Minted once, at the FIRST `run_output_delta` of this turn, and reused for
   * every later delta. Muse supplies no item id of its own; reusing `turnId`
   * would assert an identity across two different id spaces that muse never
   * claims.
   */
  itemId?: string;
  /**
   * Accumulated `run_output_delta.text`. On a successful turn it becomes
   * `turn.completed.outputText`; on a failed turn (archive#3450: a failed
   * turn publishes `runtime.error` only, never `turn.completed`) it is
   * folded, bounded, into the published `runtime.error.message` instead —
   * see `muse-adapter.ts`'s `outputTextDetail`.
   */
  outputText: string;
  /**
   * True once a terminal event closed the turn: usually `run_terminal` or
   * the child exiting. A completed `run_terminal` while background work is
   * pending does NOT settle (#2300, see `heldRuns`).
   */
  settled: boolean;
  /** Set by `interruptTurn`/`stopSession` so the exit handler can classify. */
  interrupted: boolean;
  /** Partial JSONL line carried across stdout chunk boundaries. */
  stdoutBuffer: string;
  /**
   * Bounded tail of the child's stderr, carried into the `runtime.error` this
   * turn publishes if it ends without a completed terminal. Never published on
   * its own: muse writes a workspace banner to stderr on EVERY invocation, so
   * a per-turn stderr event would be a content-free toast every turn.
   */
  stderrText: string;
  /** True once this turn's stderr tail has been relayed to the server log. */
  stderrLogged: boolean;
  /** True once the stdout buffer overflowed and was dropped (logged once). */
  stdoutOverflowed: boolean;
  terminationPromise?: Promise<boolean>;
  /**
   * #2269: per-turn deadlines, both cleared only when the slot is freed.
   *
   * - `totalTimeoutHandle`: armed ONLY when the server declared a turn budget
   *   (`turnTimeoutMs`); absolute from turn start, never rescheduled.
   * - `idleTimeoutHandle`: full silence window with no verified protocol
   *   activity AND no tool in flight; rescheduled by `noteVerifiedActivity`,
   *   and not armed at all while a tool is in flight (an open call not yet in
   *   `awaitingResultToolCalls`).
   */
  totalTimeoutHandle?: ReturnType<typeof setTimeout>;
  idleTimeoutHandle?: ReturnType<typeof setTimeout>;
  /** Resolved idle window for this turn (server-owned config). */
  idleLimitMs: number;
  /**
   * Declared absolute budget for this turn (server-owned config), or
   * `undefined` when none was declared — the default: no total timer.
   */
  totalLimitMs: number | undefined;
  /** Wall-clock of the last verified protocol activity (turn start initially). */
  lastProgressAt: number;
  /**
   * Tool-result ids already counted as liveness, oldest-first, bounded by
   * `MUSE_SEEN_TOOL_CALL_IDS_MAX`. A replayed receipt is still published
   * (the transcript is a fact) but never reschedules idle.
   */
  seenToolCallIds: string[];
  /**
   * #2308: what each muse task has revealed about itself so far, keyed by
   * `task_id` (see `observeMuseToolTask`). Bounded by the same cap as
   * `seenToolCallIds`; a task is dropped at its final lifecycle phase.
   */
  toolTasks: Map<string, MuseToolTaskBinding>;
  /**
   * Tool calls this turn published `tool.started` for and has not yet seen a
   * result for (`call_id` -> tool name). Whatever remains when the turn
   * settles is closed as `unresolved`.
   */
  openToolCalls: Map<string, string>;
  /**
   * Open calls whose muse task already reached `completed`/`failed`, keyed
   * by `call_id` to that phase: still awaiting (and pairable with) their
   * `tool_result`, but no longer running, so they do not hold the idle
   * deadline disarmed. If the result never arrives, settle reports the
   * phase muse gave rather than `unresolved`. Keys are always a subset of
   * `openToolCalls`. Tracked per call id: two tasks sharing one `call_id`
   * share this entry (a disclosed limit — the first task finishing re-arms
   * idle even if the second is still running).
   */
  awaitingResultToolCalls: Map<string, 'completed' | 'failed'>;
  /**
   * #2300: background tasks a `workflow` tool result announced as `launched`
   * and whose `task_lifecycle` has not yet reported a final phase, keyed by
   * muse's `taskId`. Each has an open tool row `muse-task:<taskId>`.
   *
   * Deliberately NOT in `openToolCalls`: those are calls of the current run
   * that settle's #2308 closure reports as unresolved, and a background task
   * is not a call — its launching call already completed. While this map is
   * non-empty the idle deadline is disarmed, and a completed `run_terminal`
   * holds the turn open instead of settling it.
   */
  pendingBackgroundTasks: Map<
    string,
    { toolCallId: string; toolName: string; announcedAt: number }
  >;
  /**
   * #2300: background tasks that reached a final phase with no follow-up run
   * submitted for them yet (cleared by the follow-up's `command_accepted`,
   * client id `muse-runtime-background-terminal`). Muse delivers every settled task's
   * result in an automatic follow-up run, so while this is non-empty a
   * completed `run_terminal` still holds the turn — even when the task
   * settled BEFORE the run that launched it ended.
   */
  awaitingReportTasks: Set<string>;
  /**
   * #2300: resolves once the turn's slot is freed (`finishTurn`). A send
   * that arrives while the previous turn is settled but its child is still
   * exiting waits on this, bounded, instead of being refused outright.
   */
  slotReleased: Promise<void>;
  /**
   * #2300: set when Station tried to stop this child and could not confirm
   * it stopped. A send that finds the slot still held by such a turn is
   * refused definitively, not retryably: the slot frees only if the process
   * exits on its own or the idle reap, one window later, confirms stopping
   * it — no prompt retry will succeed.
   */
  terminationUnconfirmed?: boolean;
  /**
   * #2300: tasks that settled while no run had yet been held, i.e. before
   * the run that launched them ended. Only a clean exit held for such tasks
   * alone is closed without a warning (the unverified-invariant case).
   */
  settledBeforeHold: Set<string>;
  resolveSlotReleased: () => void;
  /**
   * #2300: how many completed runs this turn has held open for pending
   * background work. Non-zero means muse's automatic follow-up run is being
   * delivered on this turn: a child exit now closes the turn with
   * `turn.completed` (see the adapter's exit handler), not `runtime.error`.
   */
  heldRuns: number;
  /**
   * #2300: set when a run is held and cleared by the next run's first text:
   * that run's text is joined to the earlier text with a paragraph break,
   * so the streamed transcript and `turn.completed.outputText` agree.
   */
  runSeparatorPending: boolean;
  /**
   * #2300: true once the current run has streamed a non-empty delta, so its
   * `run_terminal.text` (the run's FULL text) is not appended a second time.
   */
  runStreamedText: boolean;
  /**
   * #2300: number of background rows settle closed while the child could
   * still be running them. If the idle deadline later reaps that child, the
   * reap is announced with a `runtime.warning` rather than done silently.
   */
  backgroundRowsClosedAtSettle: number;
}

/**
 * What `observeMuseToolTask` has learned about one muse task so far. A task
 * only becomes a tool start once BOTH identities and `started` have been
 * observed for the same `task_id`.
 */
export interface MuseToolTaskBinding {
  toolName?: string;
  toolCallId?: string;
  started: boolean;
  /** True once this binding has produced its start. */
  emitted?: boolean;
}

export interface MuseSessionRecord {
  externalThreadId: string;
  /**
   * The `--session-id` handed to every `muse exec` for this thread. Muse's
   * multi-turn continuity is proven to key off this id across separate
   * processes, so it is the session's durable engine-side identity.
   */
  museSessionId: string;
  session: ProviderSession;
  cwd?: string;
  modelId?: string;
  activeTurn?: MuseActiveTurn;
  /** Set by `stopSession` so a child exit it caused is not re-classified. */
  stopped: boolean;
}
