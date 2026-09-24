import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  type ApprovalMode,
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MUSE_HELD_TURN_UNFINISHED_CODE,
  MUSE_LINGERING_CHILD_REAPED_CODE,
  MUSE_SERVE_UNAVAILABLE_CODE,
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_SLOT_RELEASING_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
  readApprovalMode,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../services/infra/process-utils.js';
import {
  adapterSessionStartDuration,
  adapterTurnDuration,
  providerOps,
} from '../../telemetry/metrics.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTaskStopResult,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
} from '../adapter-shape.js';
import type { CliAuthState, CliCommandResult } from '../auth/cli-auth.js';
import {
  buildCliRuntimePrerequisites,
  findCliBinary,
} from '../auth/cli-auth.js';
import {
  AsyncEventQueue,
  type AsyncEventStreamOptions,
} from '../sessions/async-event-queue.js';
import {
  decodeChatAttachments,
  rejectFileAttachments,
} from '../sessions/chat-attachments.js';
import { projectBoundedToolOutput } from '../tool-output-projection.js';
import {
  buildMuseExecArgs,
  museBackgroundTaskRowId,
  observeMuseToolTask,
  parseMuseLaunchedBackgroundTask,
  parseMuseLine,
  splitMuseLines,
  translateMuseRecord,
} from './muse-adapter-events.js';
import type {
  MuseActiveTurn,
  MuseProcessLike,
  MuseProviderMode,
  MuseSessionRecord,
  MuseSpawnResult,
} from './muse-adapter-types.js';
import {
  isMuseProviderMode,
  MUSE_MODEL_LAUNCH,
  MUSE_PROVIDER_MODES,
} from './muse-adapter-types.js';
import type {
  MuseServeProcessLike,
  MuseServeSpawnResult,
} from './muse-serve-rpc.js';
import { museUuidV7 } from './muse-serve-rpc.js';
import {
  MUSE_APPROVAL_DEADLINE_MS,
  MUSE_SERVE_HANDSHAKE_TIMEOUT_MS,
  MUSE_SERVE_INTERRUPT_SETTLE_MS,
  MUSE_SERVE_REQUEST_TIMEOUT_MS,
  type MuseServeHostPosture,
  MuseServeSession,
} from './muse-serve-session.js';
import { UNRESOLVED_TURN_TOOL_OUTPUT } from './unresolved-tool-output.js';

/**
 * Only `warn`/`info` are used, so the option is typed to exactly that slice —
 * a caller can pass a full `Logger` or a two-method stub, and neither this
 * adapter nor its tests can drift into `console.*`.
 */
type MuseAdapterLogger = Pick<Logger, 'warn' | 'info'>;

export interface MuseAdapterOptions {
  /**
   * Spawns one `muse exec --json` child. Injected by tests so no test in this
   * suite has to import `node:child_process` (the Vitest resource manifest
   * gate would then demand an explicit process-heavy classification).
   */
  processFactory?: (args: string[], cwd?: string) => MuseSpawnResult;
  now?: () => Date;
  /** Mints the durable `--session-id` handed to every turn of a session. */
  newSessionId?: () => string;
  terminateProcess?: (processHandle: MuseProcessLike) => Promise<void>;
  logger?: MuseAdapterLogger;
  /** Injected so credential-presence detection is testable without touching a real home dir. */
  env?: NodeJS.ProcessEnv;
  /** Injected so credential-presence detection never needs a real file in tests. */
  credentialFileExists?: (path: string) => boolean;
  /**
   * Resolves the `muse` binary path for the readiness probe. Injected so the
   * credential-derivation tests exercise the INSTALLED branch on a host that
   * has no muse at all (CI): `buildCliRuntimePrerequisites` early-returns
   * `missing` before any derivation runs when the binary is absent.
   */
  findBinary?: (command: string) => string | null;
  /**
   * Runs the readiness probe. Injected so the same tests never spawn a real
   * process — this suite is deliberately spawn-free (see the resource
   * manifest gate in `scripts/vitest-resource-manifest.mjs`).
   */
  runCommand?: (
    command: string,
    args: string[],
    signal?: AbortSignal,
  ) => Promise<CliCommandResult | null>;
  /**
   * Declared absolute per-turn budget in milliseconds (wall-clock from turn
   * start; activity never moves it). Absent means NO total budget: Station
   * does not end a live turn on a schedule of its own choosing. A declared
   * value outside (0, 24 h] also means no total budget, and is reported once
   * as a warning on the first turn. Never read from request/child/user
   * metadata — server-owned only.
   */
  turnTimeoutMs?: number;
  /**
   * Declared idle limit in milliseconds: a full window with no verified
   * protocol activity (non-empty streamed text, a newly started tool, or a
   * newly identified tool result) AND no tool in flight ends the turn.
   * Absent means NO idle bound: a silent turn is surfaced (the stall
   * watchdog's `progressSilence`) and the user decides whether to Stop it
   * (#2269). A declared value outside (0, 24 h] also means none, and is
   * reported once on the first turn. When declared it is also the window
   * after which a child still running after its turn settled is reaped.
   * Server-owned only.
   */
  turnIdleTimeoutMs?: number;
  /**
   * #2300: how long a send waits for a settled turn's child to exit before
   * refusing with the retryable `MUSE_TURN_SLOT_RELEASING_CODE`. Defaults to
   * {@link MUSE_SETTLED_CHILD_EXIT_WAIT_MS}; injected by tests.
   */
  settledChildExitWaitMs?: number;
  /**
   * #2452: drive sessions through `muse serve` (MSP), so tool approvals —
   * a workflow subagent's included — reach Station and workflow children
   * appear as child work. Absent means every session runs on `muse exec`,
   * byte-identical to before; the Station runtime opts in. Even when set, a
   * session falls back to `muse exec` (with a `muse-serve-unavailable`
   * warning) when the host cannot be used, and the `echo` e2e override
   * always runs exec (`--provider echo` is not honoured under serve).
   */
  serve?: MuseServeAdapterOptions;
}

export interface MuseServeAdapterOptions {
  /** Spawns one `muse serve` host. Injected by tests (no real process). */
  spawnHost?: (
    posture: MuseServeHostPosture,
    cwd?: string,
  ) => MuseServeSpawnResult;
  terminateHost?: (spawned: MuseServeSpawnResult) => Promise<void>;
  /** Station's bound on an unanswered approval (default 30 minutes). */
  approvalTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  interruptSettleMs?: number;
  newCommandId?: () => string;
}

/**
 * #2269 (owner direction 2026-09-22: Station does not kill live work on its
 * own schedule). A live Muse turn has no Station-chosen bound. Two bounds
 * apply only when a server-owned caller DECLARES them, and no production
 * caller does (`station-runtime.ts` constructs this adapter with neither):
 *
 * - IDLE (`turnIdleTimeoutMs`, no default): a full window with no VERIFIED
 *   protocol activity (non-empty streamed text, a newly started tool, or a
 *   newly identified tool result) ends the turn — but never while a tool is
 *   in flight (a `tool.started` whose muse task has not finished, #2308) or
 *   background work the turn launched is pending (#2300): that is known
 *   in-progress work, not silence. Each verified activity reschedules the
 *   window, and the tool's task finishing (completed/failed/cancelled) or
 *   its result re-arms it. Its expiry is `MUSE_TURN_IDLE_TIMEOUT_CODE`. A
 *   30-minute default used to apply to every turn; it was the last timer
 *   that ended a live turn Station had not been asked to bound. A silent
 *   turn is now shown as silent (the stall watchdog's `progressSilence`,
 *   "No output for …" with a Stop button) and the user decides.
 * - TOTAL (`turnTimeoutMs`, no default): an absolute wall-clock ceiling from
 *   turn start. Its expiry is `MUSE_TURN_TOTAL_TIMEOUT_CODE`. A fixed 2 h
 *   default used to apply here and killed a healthy turn whose bash tool
 *   completed every ~5 minutes.
 *
 * A declared value outside (0, 24 h] is refused (no bound) and reported once,
 * never replaced by a bound nobody declared. No request/child/user metadata
 * can choose or extend either bound. Both are capped at 24 h (well inside
 * Node's setTimeout range).
 *
 * Separately, a child still running after its turn SETTLED is reaped one
 * window after the settle (#2328/#2300, {@link MUSE_LINGERING_CHILD_REAP_MS},
 * or the declared idle window). That bounds a process that outlived its
 * turn, not a live turn.
 */
export const MUSE_LINGERING_CHILD_REAP_MS = 30 * 60_000;
export const MUSE_MAX_SUPERVISION_TIMEOUT_MS = 24 * 60 * 60_000;
/**
 * Resolution of the lingering-child reap window: a positive finite number
 * within the 24 h cap is honored; anything else (absent, zero, negative,
 * NaN, Infinity, above the cap) resolves to the given default — never to "no
 * bound", because a child that outlived its turn holds the session's slot.
 * Exported for unit tests. The declared turn bounds deliberately do not use
 * this: they have no default to fall back to (see
 * {@link resolveMuseTurnBudget}).
 */
export function resolveMuseSupervisionBound(
  value: number | undefined,
  defaultMs: number,
): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MUSE_MAX_SUPERVISION_TIMEOUT_MS
  ) {
    return value;
  }
  return defaultMs;
}

/**
 * A declared turn bound (TOTAL or IDLE), or `undefined` for none. Absent -> none. A
 * declared value that is not a positive finite number within the 24 h cap
 * also resolves to none (reported as `invalid`), rather than to a substitute
 * budget nobody declared: the only choices for a malformed declaration are
 * inventing a budget or applying none, and inventing one is the failure this
 * policy exists to remove. The caller warns once so the misconfiguration is
 * visible.
 */
export function resolveMuseTurnBudget(value: number | undefined): {
  budgetMs: number | undefined;
  invalid: boolean;
} {
  if (value === undefined) return { budgetMs: undefined, invalid: false };
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MUSE_MAX_SUPERVISION_TIMEOUT_MS
  ) {
    return { budgetMs: value, invalid: false };
  }
  return { budgetMs: undefined, invalid: true };
}

/**
 * Terminal codes for an idle expiry and for a DECLARED absolute budget's
 * expiry. Defined in the provider contract so the UI reads the same values;
 * re-exported here for the adapter's existing importers.
 * `station-control-delegation.ts`'s budget reasons match these strings.
 */
export { MUSE_TURN_IDLE_TIMEOUT_CODE, MUSE_TURN_TOTAL_TIMEOUT_CODE };

/**
 * Cap on the unterminated stdout tail carried across chunk boundaries. muse
 * writes one JSON object per line and the largest observed line is its
 * `run_terminal` (the full turn text), so a partial line past this cap is a
 * child writing without newlines rather than a legitimate record — it is
 * dropped instead of growing the turn's memory without limit.
 */
export const MUSE_STDOUT_BUFFER_MAX_CHARS = 1_048_576;

/**
 * #2269: bound on remembered tool-result ids per turn (replay dedup for idle
 * rescheduling). A duplicate `tool_result` receipt must not extend the idle
 * window; the ids are remembered so a replay reads as a replay. The queue
 * evicts oldest-first past this cap — an evicted id replaying reads as new,
 * which only reschedules idle on what is still a protocol frame the child
 * actually emitted (and a declared total budget, if any, still bounds it).
 */
const MUSE_SEEN_TOOL_CALL_IDS_MAX = 500;

/**
 * Outputs for a call whose muse task reached `completed` / `failed` but
 * whose `tool_result` never arrived before the turn settled. The status
 * follows muse's reported phase; the sentence says the result is missing.
 */
export const MUSE_FINISHED_NO_RESULT_OUTPUT =
  'Muse reported the tool finished but sent no result.';
export const MUSE_FAILED_NO_RESULT_OUTPUT =
  'Muse reported the tool failed but sent no result.';

/** Output for a tool call muse cancelled before reporting a result. */
export const MUSE_CANCELLED_TOOL_OUTPUT =
  'Muse cancelled this tool call before it reported a result.';

/**
 * #2300: outputs for a background task's row (`muse-task:<taskId>`). The
 * first three follow the final phase muse itself reported for the task. The
 * last two are Station's: the turn was stopped (Stop kills the child's whole
 * process group, background work included), or it ended — the child exited,
 * or the turn closed for another reason — before muse reported the task's
 * fate, which is then unknown.
 */
export const MUSE_BACKGROUND_TASK_COMPLETED_OUTPUT =
  'Muse reported this background task completed.';
const MUSE_BACKGROUND_TASK_FAILED_OUTPUT =
  'Muse reported this background task failed.';
const MUSE_BACKGROUND_TASK_CANCELLED_OUTPUT =
  'Muse cancelled this background task.';
export const MUSE_BACKGROUND_TASK_STOPPED_OUTPUT =
  "The turn was stopped before this background task reported a result. Muse's process exited after Station signalled its process group; that the task itself ended with it was not separately confirmed.";
export const MUSE_BACKGROUND_TASK_STOP_UNCONFIRMED_OUTPUT =
  "The turn was stopped before this background task reported a result. Station could not confirm that Muse's process stopped, so the task may still be running.";
export const MUSE_BACKGROUND_TASK_UNRESOLVED_OUTPUT =
  'The Muse turn ended before this background task reported a result, so whether it finished is unknown.';

/**
 * #2300: bound on background tasks tracked per turn. An announcement past it
 * is not tracked (logged once), so it neither opens a row nor holds the turn —
 * the turn then behaves for that task exactly as it did before #2300.
 */
export const MUSE_PENDING_BACKGROUND_TASKS_MAX = 64;

/**
 * #2300 (review M5): how long a send waits for the PREVIOUS turn's child to
 * exit when that turn has already ended. The server frees a turn at its
 * `turn.completed`, but the child can still take a moment to exit (~160 ms
 * observed after muse's follow-up run), and until it does it owns the
 * session's `--session-id`. Past this wait the send is refused with the
 * retryable `MUSE_TURN_SLOT_RELEASING_CODE`.
 */
const MUSE_SETTLED_CHILD_EXIT_WAIT_MS = 5_000;

/**
 * A send refused because the previous turn's child had not yet exited (see
 * {@link MUSE_SETTLED_CHILD_EXIT_WAIT_MS}). A refusal to act, and retryable:
 * the same send succeeds once that process is gone.
 *
 * A `SendTurnRefusedError` because it IS a pre-effect refusal — nothing was
 * spawned — and that type is what makes the orchestration layer retire the
 * dispatch cleanly and rethrow it. Any other error thrown from `sendTurn` is
 * converted to `foreground_message_indeterminate` (the turn MAY have
 * started), which is what the plain "already has an active turn" error
 * became before #2300 (and, for a still-running occupant, until #2415).
 */
export class MuseTurnSlotReleasingError extends SendTurnRefusedError {
  readonly code = MUSE_TURN_SLOT_RELEASING_CODE;
  readonly retryable = true;
  /**
   * Kept off the message: a client queue shows the refusal text to the user
   * verbatim, and a thread id there is noise. `sendTurn` logs it.
   */
  constructor(readonly threadId: string) {
    super(
      "Muse is still closing the previous turn's process; try again in a moment.",
    );
    this.name = 'MuseTurnSlotReleasingError';
  }
}

/**
 * Human form of a Station-owned duration, for user-facing warnings. Exact:
 * whole hours or whole minutes when the value is one, otherwise seconds
 * (fractional when needed) — a 90 s limit reads "90 seconds", never a
 * rounded "2 minutes".
 */
export function formatMuseDuration(ms: number): string {
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? '' : 's'}`;
  if (ms > 0 && ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  if (ms > 0 && ms % 60_000 === 0) return unit(ms / 60_000, 'minute');
  return unit(ms / 1_000, 'second');
}

/**
 * Where the muse CLI stores its credential, honoring XDG. Presence only —
 * the file is never opened, so no secret material is read (the detection line
 * in docs/design/connections-onboarding.md §1).
 */
export function museCredentialPath(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return configHome
    ? join(configHome, 'muse', 'auth.json')
    : join(homedir(), '.config', 'muse', 'auth.json');
}

/**
 * `authenticated` means "a credential is available to muse", derived from an
 * env key or the presence of the credential file — never from the CLI merely
 * running. Validity is proven on first use, not here.
 */
export function museCredentialState(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): CliAuthState {
  if (env.META_API_KEY?.trim()) return 'authenticated';
  return fileExists(museCredentialPath(env))
    ? 'authenticated'
    : 'unauthenticated';
}

/**
 * Names the startup provider a CONTAINED run may put on `muse exec`.
 *
 * Station has never passed `--provider`, so muse's own default (`meta`) has
 * always applied — which makes a muse turn cost a real Meta key and a network
 * round trip, and is why no journey has ever run one. muse ships an `echo`
 * provider precisely for this: a byte-compatible event envelope produced from
 * the prompt alone, no key, no network, deterministic reply (live-verified
 * against Muse Code 1.0.1-R1848.1).
 *
 * The variable NAMES the request; it does not authorize it. Authorization is
 * the conjunction in {@link museProviderOverrideContained} — see that
 * function for why the name alone cannot be trusted.
 */
export const MUSE_PROVIDER_OVERRIDE_ENV = 'STATION_E2E_MUSE_PROVIDER';

/** Why an exec session's child work is `not-reported` (#2452). */
export const MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON =
  'This Muse session runs through `muse exec`, which reports no subagent identity.';

/** Bound on the refused value echoed back in the first turn's warning. */
export const MUSE_REFUSED_VALUE_MAX_CHARS = 120;

/**
 * The runner-owned instance namespace for the one suite that asks for this.
 *
 * CROSS-FILE COUPLE — this pattern must match `scripts/run-e2e-suite.mjs`'s
 * `e2e-${suite}-${Date.now()}-${base36}` minting; change both together. It is
 * a transcription of a shape produced in another file, with no shared constant
 * and nothing that fails if the two drift, so it is pinned by comment at both
 * ends the way a wire format would be. `resource-posture.ts`'s
 * `STARTER_CLEAN_INSTALL_INSTANCE` transcribes the same minting for its own
 * suite and carries the same coupling.
 *
 * Drift is silent in the SAFE direction — a mismatch makes the override inert
 * and reds `agents-new-muse-echo-turn.spec.ts` rather than widening anything —
 * but it reds it as a mystery, so the pointer is worth more than the guard.
 */
const MUSE_E2E_SMOKE_LIVE_INSTANCE = /^e2e-smoke-live-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Whether this process is the disposable E2E runtime the override is for.
 *
 * Uses the same temp-home plus instance-namespace authorization pattern as
 * other isolated E2E seams: keep one journey deterministic without weakening
 * a persistent home, so "the explicit E2E value alone has no effect".
 *
 * What the conjunction buys, precisely, and what it does not:
 *
 * On a CLI-SPAWNED server both markers are spawn-owned.
 * `packages/cli/src/commands/lifecycle.ts` builds the child env by spreading
 * `process.env` and then OVERWRITING `STATION_HOME_SOURCE` (from its own
 * resolved flag decision) and `STATION_INSTANCE_ID` (from the runner-owned
 * instance name), so neither can be forged from a `.env` — which matters
 * because `src-server/index.ts` imports `dotenv/config`, and a `.env` file in
 * the server's cwd is otherwise enough to put ANY variable into `process.env`.
 * That is the case this gate is for, and there the name alone is inert.
 *
 * On a DIRECTLY-LAUNCHED server (`npm run dev:server`, or the built
 * `dist-server/command-station.js` entry run by hand — both load dotenv before
 * anything else) there is no attestation at all: nothing
 * server-side produces or cross-checks either marker, so a `.env` can set all
 * three variables and the override applies. This gate accepts that residual
 * rather than closing it — exactly as `resource-posture.ts` does with the same
 * two markers. The line drawn is "a production server started the normal way
 * cannot be flipped by a file", not "these markers are unforgeable".
 */
function museProviderOverrideContained(env: NodeJS.ProcessEnv): boolean {
  return (
    env.STATION_HOME_SOURCE === '--temp-home' &&
    MUSE_E2E_SMOKE_LIVE_INSTANCE.test(env.STATION_INSTANCE_ID ?? '')
  );
}

/** Why a named override did not become argv. */
interface MuseProviderOverrideRefusal {
  /**
   * `uncontained-environment` — the runtime is not the disposable E2E one, so
   * the variable has no effect here whatever it says.
   * `not-a-provider-mode` — contained, but the value is not one muse accepts.
   */
  reason: 'uncontained-environment' | 'not-a-provider-mode';
  value: string;
}

/**
 * Resolves the override, or refuses it with the state that refused it.
 *
 * Unset (or whitespace) means UNSET and is silent: the caller emits no
 * `--provider` at all and the invocation is byte-identical to the one Station
 * has always built.
 *
 * Containment is checked BEFORE the vocabulary, because on an uncontained
 * runtime the value is beside the point — even a perfectly spelled `echo` has
 * no effect there, and reporting "not a provider mode" would name the wrong
 * problem. A value outside {@link MUSE_PROVIDER_MODES} is then refused rather
 * than forwarded: it would be spliced straight into the engine's option
 * surface, so `--workspace`, `-w /etc` or `--yolo` sitting in a misconfigured
 * environment would be an argv injection into state-mutating flags. Both
 * refusals fall back to the pre-existing default rather than throwing, so one
 * environment variable cannot take the runtime down at construction.
 */
export function resolveMuseProviderOverride(
  env: NodeJS.ProcessEnv,
  onRefused?: (refusal: MuseProviderOverrideRefusal) => void,
): MuseProviderMode | undefined {
  const raw = env[MUSE_PROVIDER_OVERRIDE_ENV]?.trim();
  if (!raw) return undefined;
  if (!museProviderOverrideContained(env)) {
    onRefused?.({ reason: 'uncontained-environment', value: raw });
    return undefined;
  }
  if (!isMuseProviderMode(raw)) {
    onRefused?.({ reason: 'not-a-provider-mode', value: raw });
    return undefined;
  }
  return raw;
}

/**
 * Cap on the stderr tail retained per turn. The tail is never published on its
 * own — it is appended to the `runtime.error` a failed turn publishes, which
 * is the only diagnosis a user gets for (say) an expired key.
 */
const MUSE_STDERR_TAIL_MAX_CHARS = 400;

/**
 * Cap on the accumulated/reported turn text folded into a failed turn's
 * `runtime.error.message` (archive#3450 review). Sized the same order as
 * `MUSE_STDERR_TAIL_MAX_CHARS` so the two DETAILS this file appends —
 * `outputTextDetail` (this bound) and `stderrDetail` — total <= 900 chars
 * and can never together blow `runtime-auth-health-monitor.ts`'s
 * `MAX_RUNTIME_MESSAGE_LENGTH` (4096) on their own.
 *
 * The two halves reach that bound differently, and only one of them makes it
 * literal. `outputTextDetail` scrubs BEFORE it truncates, so 500 is its real
 * ceiling — `redactSecrets` can LENGTHEN a string (`Bearer x` ->
 * `Bearer [REDACTED]`), and bounding after it is what pins the number.
 * `stderrDetail` cannot do the same: `handleStderr` already slices the raw
 * text to `MUSE_STDERR_TAIL_MAX_CHARS` at accumulation time, so it redacts a
 * pre-truncated buffer and its 400 can expand. Both remain far under 4096
 * even at redaction's worst expansion ratio, so the safety conclusion holds
 * either way — but only the first bound is exact.
 *
 * This bounds only those two appended details. It does NOT bound the
 * `outcome.error.message` PREFIX they are appended to — a second archive#3450
 * review round found that prefix unbounded at the `muse-terminal-not-completed`
 * call site (`effect.terminal`/`effect.reason` interpolated verbatim), which
 * `MUSE_TERMINAL_FIELD_MAX_CHARS` bounds separately, below.
 */
const MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS = 500;

/**
 * Cap on `effect.terminal`/`effect.reason` when interpolated into
 * `muse-terminal-not-completed`'s `runtime.error.message` prefix
 * (archive#3450 review round 2). Both come from `extractString`
 * (`muse-adapter-events.ts:17-19`), a bare `typeof value === 'string'` with
 * no length cap of its own — so either field can carry up to
 * `MUSE_STDOUT_BUFFER_MAX_CHARS` (1,048,576) chars of child-controlled JSONL.
 * Unbounded, an oversized `reason` would blow `MAX_RUNTIME_MESSAGE_LENGTH`
 * through the message PREFIX rather than through `outputTextDetail`/
 * `stderrDetail` (which `MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS`/
 * `MUSE_STDERR_TAIL_MAX_CHARS` already bound) — the same
 * `RuntimeAuthHealthEventDiagnostic` throw archive#3450 exists to remove,
 * reached by a route the discriminated union does not touch.
 */
const MUSE_TERMINAL_FIELD_MAX_CHARS = 200;

/**
 * The terminal outcome `settleTurn` publishes exactly one event for.
 *
 * A discriminated union rather than one object with optional `aborted`/
 * `error` flags (archive#3450 review): the old shape let a caller pass both
 * `aborted: true` and `error`, which nothing checked — the union makes
 * "exactly one of aborted/error/completed" a compile-time property of every
 * call site instead of a comment asserting it holds.
 */
type MuseTurnSettleOutcome =
  | {
      kind: 'aborted';
      abortReason: string;
      /**
       * #2300: whether the child is known to have stopped. Only then may a
       * pending background row say its process exited.
       */
      terminationConfirmed: boolean;
    }
  | {
      kind: 'error';
      error: { message: string; code: string };
      /**
       * True for a Station-owned deadline. The deadline, not anything muse
       * wrote, is why the turn ended, and muse writes unrelated warnings to
       * stderr on every run (workspace banner, rules-file truncation), so
       * appending the stderr tail would present those as the cause.
       */
      omitStderr?: boolean;
      /**
       * Turn text muse had produced or reported before the failure. Never
       * published as `turn.completed.outputText` (this outcome never
       * publishes `turn.completed`) — folded, bounded, into
       * `runtime.error.message` by `outputTextDetail` instead, so it is not
       * silently dropped when it is the only carrier of the text (e.g. no
       * deltas streamed and `run_terminal.text` never reached anywhere
       * else).
       */
      outputText?: string;
    }
  | {
      kind: 'completed';
      finishReason: 'stop' | 'cancelled' | 'other';
      outputText?: string;
    };

function createMuseProcess(args: string[], cwd?: string): MuseSpawnResult {
  const binary = findCliBinary('muse') ?? 'muse';
  // Mirrors the Codex spawn recipe (windowsHide + detached + piped stdio +
  // a Station-owned TMPDIR), routed through `spawnOwnedChild` so a per-turn
  // spawner's children are registered and reapable if Station dies without
  // running cleanup — a per-turn process leaks worse than a per-session one.
  const { proc, release } = spawnOwnedChild(binary, args, {
    cwd,
    env: childProcessEnvironment({ TMPDIR: ensureEngineSpawnTmpDir() }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { process: proc as unknown as MuseProcessLike, release };
}

/**
 * The host's data home: `XDG_DATA_HOME` pinned under the Station home, so a
 * session's durable log (what `session/resume` reads) belongs to this Station
 * home rather than to whichever muse data the user's shell points at. muse's
 * CONFIG (credential, settings, model choice) stays in `XDG_CONFIG_HOME` and
 * is untouched.
 */
export function museServeDataHome(homeDir: string = resolveHomeDir()): string {
  return join(homeDir, 'engine-data', 'muse');
}

/** `muse serve` argv for a host posture. The sandbox is on unless disabled. */
export function buildMuseServeArgs(posture: MuseServeHostPosture): string[] {
  return ['serve', ...(posture.disableSandbox ? ['--disable-sandbox'] : [])];
}

function createMuseServeHost(
  posture: MuseServeHostPosture,
  cwd?: string,
): MuseServeSpawnResult {
  const binary = findCliBinary('muse') ?? 'muse';
  const dataHome = museServeDataHome();
  mkdirSync(dataHome, { recursive: true });
  const { proc, release } = spawnOwnedChild(
    binary,
    buildMuseServeArgs(posture),
    {
      cwd,
      env: childProcessEnvironment({
        TMPDIR: ensureEngineSpawnTmpDir(),
        XDG_DATA_HOME: dataHome,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return { process: proc as unknown as MuseServeProcessLike, release };
}

/**
 * Ends a host: stdin is already closed (the host exits on EOF and flushes its
 * durable log), so give it a moment to leave on its own, then take the
 * process group down.
 */
async function terminateMuseServeHost(
  spawned: MuseServeSpawnResult,
): Promise<void> {
  const processHandle = spawned.process;
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      processHandle.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await terminateProcessTree(processHandle, {
    graceMs: 500,
    killConfirmMs: 1_000,
    processGroup: true,
  });
}

async function terminateMuseProcess(
  processHandle: MuseProcessLike,
): Promise<void> {
  await terminateProcessTree(processHandle, {
    graceMs: 100,
    killConfirmMs: 1_000,
    processGroup: true,
  });
}

/**
 * Muse Code adapter.
 *
 * Architecture note — this is the repo's first PER-TURN external engine.
 * `muse exec --json` runs ONE prompt, streams JSONL on stdout, and exits;
 * continuity across turns comes from reusing `--session-id`, which two live
 * `muse exec` runs were proven to share context through. So:
 *
 * - `startSession` spawns nothing. It mints the durable muse session id and
 *   publishes `session.started` + `session.configured`.
 * - `sendTurn` spawns the turn's child and tears it down when the turn ends.
 * - A child exit is a NORMAL per-turn event and must never publish
 *   `session.exited`; only `stopSession` does that.
 *
 * #2300 — `run_terminal` does not always end the turn. Muse's `workflow`
 * tool launches work in the background and returns
 * `{"status":"launched","taskId":…}` at once; the run then reaches its
 * `run_terminal`, but `muse exec` does NOT exit. It waits for the task,
 * reports the task's `task_lifecycle` completion, submits an automatic
 * follow-up run (`command_accepted` from `muse-runtime-background-terminal`)
 * that reports the result, and exits after that run's own `run_terminal`
 * (live-measured on muse 1.3.0-R3401.1; the capture is
 * `__tests__/fixtures/muse-1.3-background-workflow-turn.jsonl`). Owner
 * decision on #2300: Station HOLDS the turn open across that.
 *
 * - A launch announces a background task: its row is opened as
 *   `tool.started` with `toolCallId: muse-task:<taskId>` and settled by the
 *   task's final `task_lifecycle` phase. That id scheme is persisted in the
 *   event log, so it is a deliberate one-way choice: the prefix keeps the row
 *   distinct from the launching call's own row (`tool:<call_id>`, completed
 *   when the launch returned) and from any real muse `call_id`.
 * - A COMPLETED `run_terminal` while the turn is still owed a background
 *   report (below) does not settle. The follow-up run is published on the SAME turn — its
 *   text as a new item, joined to earlier text by a paragraph break, its
 *   tools as ordinary rows — and `turn.completed` fires once, at the last
 *   run's terminal, with the composed text. No second `turn.started` is
 *   ever minted (#2324 owns provider-triggered turns).
 * - The hold lasts until every announced task has settled AND a follow-up
 *   run has reported it. Muse delivers each settled task's result in a
 *   follow-up run; the follow-up is recognised by its `command_accepted`
 *   (client id `muse-runtime-background-terminal`), and its terminal releases
 *   the tasks it reported. If muse stops stamping that id, nothing releases
 *   the hold early: the follow-up text still lands on the turn, and the
 *   turn closes when the child exits.
 * - UNVERIFIED muse invariant: that muse also submits a follow-up for a task
 *   that settles BEFORE the run that launched it ends. The only live
 *   capture settles the task after run 1's terminal. The hold for such a
 *   task therefore still delivers a follow-up that does come, but if muse
 *   instead exits cleanly (code 0, no signal) with no task still pending
 *   and no follow-up started, the turn closes exactly as it did before
 *   #2300: `turn.completed`, `stop`, the text so far, and no warning. A
 *   non-zero or signal exit, or one with a task still pending, gets the
 *   warning below.
 * - Neither the idle deadline nor any other Station-chosen bound applies
 *   while a task is pending or the turn is held: it runs until muse finishes
 *   or someone presses Stop, which kills the child's process group and
 *   closes pending rows cancelled. A held turn with no user to press Stop —
 *   a delegated or Station-initiated turn — therefore runs until muse
 *   finishes it. (A budget a server-owned caller DECLARES via
 *   `turnTimeoutMs` still applies; no production caller declares one.)
 * - A held turn that ends any other way — a follow-up terminal that is not
 *   `completed`, the child exiting first, or a declared budget — closes its
 *   pending rows as unresolved, publishes a `runtime.warning`
 *   (`muse-held-turn-unfinished`, carrying the terminal and reason, or the
 *   exit code) and closes the turn with `turn.completed` (`finishReason`
 *   from the terminal, or `other`). Never `runtime.error`: that marks the
 *   session failed and offers "Send again", which would re-launch the
 *   workflow run 1 already started.
 * - The background row is named `<tool>_background` (e.g.
 *   `workflow_background`), not the launching tool's own name: it is not a
 *   second call of that tool, and per-name tool counts must not read it as
 *   one.
 * - Turns that launch nothing are unchanged, down to their timing.
 */
export class MuseAdapter implements ProviderAdapterShape {
  readonly provider = 'muse' as const;
  readonly metadata: ProviderAdapterMetadata;
  private static readonly baseMetadata = {
    displayName: 'Muse Code',
    continuity: { resume: 'none', fork: 'none', rewind: 'none' },
    builtin: true,
    engineId: engineId('muse'),
    // No `abortSettlement`: it is consulted only where a discovery call has
    // to settle before an abort resolves (`ConnectionInspector`
    // wraps `listModelCatalog`/`listModels`), and this adapter implements
    // neither. Declaring it would be a settlement policy with nothing behind
    // it.
    //
    // The one model channel muse genuinely has, declared once in
    // `MUSE_MODEL_LAUNCH`. Without this, `resolveModelLaunchPlan` returns
    // `override-unsupported` and every model request is refused before
    // `buildMuseExecArgs` ever runs — while the capability matrix claims
    // `modelSelection: session/flag`.
    modelLaunch: MUSE_MODEL_LAUNCH,
  } as const;

  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, MuseSessionRecord>();
  private readonly processFactory: (
    args: string[],
    cwd?: string,
  ) => MuseSpawnResult;
  private readonly now: () => Date;
  private readonly newSessionId: () => string;
  private readonly terminateProcess: (
    processHandle: MuseProcessLike,
  ) => Promise<void>;

  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialFileExists: (path: string) => boolean;
  private readonly findBinary: (command: string) => string | null;
  private readonly turnTimeoutMs: number | undefined;
  /** A declared `turnTimeoutMs` that was refused; reported on the first turn. */
  private readonly refusedTurnTimeoutMs: unknown;
  private refusedTurnTimeoutReported = false;
  /** The declared idle bound, or `undefined` for none (the default). */
  private readonly turnIdleTimeoutMs: number | undefined;
  /** A declared `turnIdleTimeoutMs` that was refused; reported on the first turn. */
  private readonly refusedTurnIdleTimeoutMs: unknown;
  private refusedTurnIdleTimeoutReported = false;
  /** How long a child may outlive its settled turn before it is reaped. */
  private readonly lingeringChildReapMs: number;
  /**
   * Resolved ONCE, at construction, from {@link MUSE_PROVIDER_OVERRIDE_ENV}:
   * a mid-run env mutation cannot change what a session's later turns run
   * under. `undefined` is the default and means no `--provider` is emitted.
   */
  private readonly providerOverride: MuseProviderMode | undefined;
  /**
   * The refused raw value, held for the FIRST turn to report rather than
   * logged where it was found.
   *
   * `station-runtime.ts` builds this adapter in a FIELD INITIALIZER, and its
   * logger closure reads `this.logger` lazily precisely because the runtime's
   * own logger is not assigned until later in its constructor body. So
   * anything this constructor logs reaches an `undefined` logger and is
   * dropped — a warning nothing ever emits. Deferring the report to the first
   * turn is what makes it real, and {@link providerNoticeReported} keeps it to
   * one per process rather than one per turn.
   */
  private readonly providerRefusal: MuseProviderOverrideRefusal | undefined;
  private providerNoticeReported = false;

  constructor(private readonly options: MuseAdapterOptions = {}) {
    // `resume` and `tool-calls` are NOT claimed: Station implements no
    // adoption of a pre-existing muse session. `approvals` is claimed only
    // when sessions run through `muse serve`, the one channel that carries
    // them (#2452); a session that falls back to exec announces that it
    // cannot ask (`muse-serve-unavailable`).
    this.metadata = {
      ...MuseAdapter.baseMetadata,
      description: options.serve
        ? 'Muse Code runtime over the local muse CLI: one `muse serve` host per session, `muse exec` per turn as the fallback.'
        : 'Muse Code runtime over the local muse CLI, one `muse exec` per turn.',
      capabilities: [
        'agent-runtime',
        'session-lifecycle',
        'external-process',
        'image-input',
        ...(options.serve ? (['approvals'] as const) : []),
      ],
    };
    this.processFactory = options.processFactory ?? createMuseProcess;
    this.now = options.now ?? (() => new Date());
    this.newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
    this.terminateProcess = options.terminateProcess ?? terminateMuseProcess;
    this.env = options.env ?? process.env;
    this.credentialFileExists = options.credentialFileExists ?? existsSync;
    this.findBinary = options.findBinary ?? findCliBinary;
    // Neither turn bound has a default (see MUSE_LINGERING_CHILD_REAP_MS's
    // doc); a malformed declaration is kept to be reported, not replaced.
    const budget = resolveMuseTurnBudget(options.turnTimeoutMs);
    this.turnTimeoutMs = budget.budgetMs;
    this.refusedTurnTimeoutMs = budget.invalid
      ? options.turnTimeoutMs
      : undefined;
    const idle = resolveMuseTurnBudget(options.turnIdleTimeoutMs);
    this.turnIdleTimeoutMs = idle.budgetMs;
    this.refusedTurnIdleTimeoutMs = idle.invalid
      ? options.turnIdleTimeoutMs
      : undefined;
    // The reap window fails CLOSED to its default: a child that outlived its
    // turn holds the session's slot, so "no bound" is not an option here.
    this.lingeringChildReapMs = resolveMuseSupervisionBound(
      this.turnIdleTimeoutMs,
      MUSE_LINGERING_CHILD_REAP_MS,
    );
    let refusal: MuseProviderOverrideRefusal | undefined;
    this.providerOverride = resolveMuseProviderOverride(this.env, (refused) => {
      refusal = refused;
    });
    this.providerRefusal = refusal;
  }

  /**
   * The model this session can honestly claim.
   *
   * Under `echo`, `buildMuseExecArgs` drops `--model` (muse refuses the
   * combination outright), so no selection is ever applied — and a session
   * that reports one would be asserting a fact nothing computed. The REQUEST
   * is still legitimate and is still remembered on the record: agents carry a
   * default model, and refusing the turn over it would be the wrong trade.
   * What is withheld is the CLAIM that it took effect.
   */
  private appliedModelId(modelId: string | undefined): string | undefined {
    return this.providerOverride === 'echo' ? undefined : modelId;
  }

  /**
   * Reports a refused `turnTimeoutMs` / `turnIdleTimeoutMs` declaration once,
   * on the first turn — deferred for the same reason as
   * {@link reportProviderNoticeOnce}: this adapter is built before the
   * runtime's logger is wired.
   */
  private reportRefusedTurnBudgetOnce(): void {
    const logger = this.options.logger;
    if (!logger?.warn) return;
    if (
      !this.refusedTurnTimeoutReported &&
      this.refusedTurnTimeoutMs !== undefined
    ) {
      logger.warn(
        `Ignoring Muse turnTimeoutMs=${String(this.refusedTurnTimeoutMs)}: not a positive number of milliseconds up to ${MUSE_MAX_SUPERVISION_TIMEOUT_MS}. Muse turns run with no total budget.`,
      );
      this.refusedTurnTimeoutReported = true;
    }
    if (
      !this.refusedTurnIdleTimeoutReported &&
      this.refusedTurnIdleTimeoutMs !== undefined
    ) {
      logger.warn(
        `Ignoring Muse turnIdleTimeoutMs=${String(this.refusedTurnIdleTimeoutMs)}: not a positive number of milliseconds up to ${MUSE_MAX_SUPERVISION_TIMEOUT_MS}. Muse turns run with no idle bound.`,
      );
      this.refusedTurnIdleTimeoutReported = true;
    }
  }

  /**
   * Says, exactly once and only when there is something to say, what provider
   * this process's muse turns are actually running under.
   *
   * Every branch is surprising in a log that does not mention it: a named
   * override silently inert on an uncontained runtime, a misspelled one
   * silently keeping the old default, and an accepted `echo` silently
   * replacing the model with a prompt echo.
   *
   * The flag is burned only once a logger call actually RAN.
   *
   * That guard does NOT cover the `station-runtime.ts` case, and should not be
   * read as covering it: the shim it passes is always a truthy object whose
   * methods no-op internally while the runtime's own logger is unassigned, so
   * `logger.warn` is present and this code cannot tell the notice was
   * swallowed. Deferring the report to the first turn is what handles that —
   * by then the runtime logger is wired. The guard is for the case it can
   * actually see: an adapter constructed with NO logger at all, which is every
   * `new MuseAdapter()` in the tests and any future caller that omits one.
   * There, burning the flag on a call that never happened would silence the
   * notice for the life of the process.
   *
   * A throwing `warn` deliberately leaves the flag unburned: the throw fails
   * that turn, and the next turn tries the notice again rather than treating
   * an unreported state as reported.
   */
  private reportProviderNoticeOnce(): void {
    if (this.providerNoticeReported) return;
    const logger = this.options.logger;
    if (this.providerRefusal !== undefined) {
      if (!logger?.warn) return;
      logger.warn(
        this.providerRefusal.reason === 'uncontained-environment'
          ? `Ignoring ${MUSE_PROVIDER_OVERRIDE_ENV}: it applies only to a disposable end-to-end runtime (a --temp-home under a runner-owned instance id), and this is not one. Muse turns keep the engine's own default provider.`
          : `Ignoring ${MUSE_PROVIDER_OVERRIDE_ENV}: not one of ${MUSE_PROVIDER_MODES.join(
              ', ',
            )}. Muse turns keep the engine's own default provider.`,
        // Scrubbed and bounded: the refused value is arbitrary environment
        // content, and the point of echoing it is to show the operator their
        // typo, not to relay whatever else was mis-assigned to the variable.
        {
          reason: this.providerRefusal.reason,
          value: redactSecrets(this.providerRefusal.value).slice(
            0,
            MUSE_REFUSED_VALUE_MAX_CHARS,
          ),
        },
      );
      this.providerNoticeReported = true;
      return;
    }
    if (this.providerOverride === 'echo') {
      if (!logger?.info) return;
      logger.info(
        `${MUSE_PROVIDER_OVERRIDE_ENV}=echo: muse turns run its echo provider, which answers from the prompt alone. No model is selected and no model answers.`,
      );
      this.providerNoticeReported = true;
    }
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    // muse exposes no auth-STATUS surface: its only auth verbs are
    // `muse auth set` (writes a key from stdin) and `muse login` (interactive
    // browser flow), neither safe to run as a readiness check, and there is no
    // read-only equivalent of `codex login status`. Deriving the auth state
    // from `muse --version` exiting 0 would report "authenticated" on the
    // strength of the binary merely running — a label nothing computes.
    //
    // So this observes the credential STORE instead, which is the same line
    // docs/design/connections-onboarding.md §1 already draws for the AWS
    // credential chain: presence is detectable, contents are never read. The
    // key's validity is proven on first use, surfacing as the `runtime.error`
    // `settleTurn` publishes for a turn that ends without a completed
    // terminal, which carries the bounded tail of muse's own stderr.
    return buildCliRuntimePrerequisites({
      command: 'muse',
      displayName: 'Muse Code',
      versionArgs: ['--version'],
      authArgs: ['--version'],
      findBinary: this.findBinary,
      ...(this.options.runCommand
        ? { runCommand: this.options.runCommand }
        : {}),
      installStep: 'Install the Muse Code CLI and ensure `muse` is on PATH.',
      authStep:
        'Run `muse auth set --api-key-stdin` (or set META_API_KEY) before starting Station.',
      detectAuthState: async () =>
        museCredentialState(this.env, this.credentialFileExists),
      signal: options?.signal,
    });
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId)) {
      throw new Error(`Muse session already exists: ${input.threadId}`);
    }
    const startedAt = Date.now();
    const requestedApprovalMode = readApprovalMode(input.modelOptions);
    // #2452: a `muse serve` host first, when this runtime enables it. Any
    // failure to use it (no such subcommand, a failed handshake, a schema
    // this Station has not verified, a refused session start) falls back to
    // `muse exec` for THIS session, and says so below.
    let serve: MuseServeSession | undefined;
    let serveStarted:
      | Awaited<ReturnType<MuseServeSession['start']>>
      | undefined;
    let serveUnavailable: string | undefined;
    if (this.options.serve && this.providerOverride !== 'echo') {
      const candidate = this.createServeSession(input.threadId, input.cwd);
      try {
        serveStarted = await candidate.start({
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
          approvalMode: requestedApprovalMode,
        });
        serve = candidate;
      } catch (error) {
        serveUnavailable = errorMessage(error);
        this.options.logger?.warn?.(
          'Muse serve unavailable; this session falls back to muse exec.',
          { reason: serveUnavailable },
        );
      }
    }
    if (this.sessions.has(input.threadId)) {
      await serve?.stop();
      throw new Error(`Muse session already exists: ${input.threadId}`);
    }
    const museSessionId = serveStarted?.museSessionId ?? this.newSessionId();
    const nowIso = this.now().toISOString();
    // What the session REPORTS is what a turn will actually apply, which under
    // `echo` is no model at all — see `appliedModelId`. `record.modelId` below
    // keeps the request itself. Under serve, the model the host reported.
    const appliedModelId = serveStarted
      ? (serveStarted.modelId ?? input.modelId)
      : this.appliedModelId(input.modelId);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      // Exec: ready immediately, there is no process until the first turn.
      // Serve: the host's handshake has already completed.
      status: 'ready',
      model: appliedModelId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const record: MuseSessionRecord = {
      externalThreadId: input.threadId,
      museSessionId,
      session,
      cwd: input.cwd,
      modelId: input.modelId,
      stopped: false,
      ...(serve ? { serve } : {}),
    };
    this.sessions.set(input.threadId, record);
    const transportMetadata = serveStarted
      ? {
          museTransport: 'serve',
          museApprovalMode: serveStarted.plan.museMode,
          museSandbox: serveStarted.plan.disableSandbox
            ? 'disabled'
            : 'enabled',
          ...(serveStarted.plan.stationMode
            ? { approvalMode: serveStarted.plan.stationMode }
            : {}),
        }
      : {
          museTransport: 'exec',
          // Exec runs `--approval-mode never` inside muse's sandbox, which is
          // what `auto` applies under serve. Reported only when a posture was
          // requested, so the chip names what applied instead of the request.
          ...(requestedApprovalMode ? { approvalMode: 'auto' } : {}),
        };

    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: nowIso,
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: {
        ...input.metadata,
        museSessionId,
      },
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: nowIso,
      method: 'session.configured',
      sessionId: input.threadId,
      // ADAPTER-LEVEL withhold only, and the distinction matters: omitting
      // `model` here is not the same as clearing it downstream. The session
      // projection folds this event as `event.model ?? baseSession.model`
      // (`services/orchestration/orchestration-session-state.ts`), which reads
      // an absent — and an explicitly-`undefined` — `model` as CARRY-FORWARD,
      // so a row pre-seeded with a model keeps that claim through the READ
      // MODEL even though this adapter's own record is honest. Clearing it end
      // to end needs a contract-level cleared-marker the fold honors, plus a
      // projection test: #848. Until then, do not read this withhold as
      // end-to-end clearing.
      ...(appliedModelId ? { model: appliedModelId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      metadata: {
        ...input.metadata,
        museSessionId,
        ...transportMetadata,
      },
    });
    if (!serve)
      this.publishExecTransportFacts(input.threadId, serveUnavailable);

    providerOps.add(1, {
      operation: 'adapter-session-start',
      provider: this.provider,
    });
    adapterSessionStartDuration.record(Date.now() - startedAt, {
      provider: this.provider,
    });
    return record.session;
  }

  /**
   * What an exec session cannot do, said once at its start. `muse exec`
   * names no subagent (its muse matrix cell is declared for serve), so its
   * child work is `not-reported` rather than an empty "nothing running" it
   * never derived. When serve was wanted and could not be used, the reason
   * is published: approvals cannot reach Station on this path.
   */
  private publishExecTransportFacts(
    threadId: string,
    serveUnavailable: string | undefined,
  ): void {
    const createdAt = this.now().toISOString();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt,
      method: 'child-work.updated',
      delta: {
        kind: 'not-reported',
        reporterThreadId: threadId,
        reason: MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON,
      },
    });
    if (serveUnavailable === undefined) return;
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt,
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_SERVE_UNAVAILABLE_CODE,
      message:
        "Muse's approval channel (`muse serve`) could not be used, so this session runs through `muse exec`: tools run without asking you, inside muse's sandbox.",
      details: {
        reason: redactSecrets(serveUnavailable).slice(
          0,
          MUSE_REFUSED_VALUE_MAX_CHARS * 2,
        ),
      },
    });
  }

  private createServeSession(
    threadId: string,
    cwd: string | undefined,
  ): MuseServeSession {
    const serve = this.options.serve ?? {};
    const spawnHost = serve.spawnHost ?? createMuseServeHost;
    return new MuseServeSession({
      threadId,
      now: this.now,
      publish: (event) => this.publish(event),
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      spawnHost: (posture) => spawnHost(posture, cwd),
      terminateHost: serve.terminateHost ?? terminateMuseServeHost,
      newCommandId: serve.newCommandId ?? (() => museUuidV7()),
      approvalTimeoutMs: resolveMuseSupervisionBound(
        serve.approvalTimeoutMs,
        MUSE_APPROVAL_DEADLINE_MS,
      ),
      handshakeTimeoutMs:
        serve.handshakeTimeoutMs ?? MUSE_SERVE_HANDSHAKE_TIMEOUT_MS,
      requestTimeoutMs: serve.requestTimeoutMs ?? MUSE_SERVE_REQUEST_TIMEOUT_MS,
      interruptSettleMs:
        serve.interruptSettleMs ?? MUSE_SERVE_INTERRUPT_SETTLE_MS,
    });
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.requireSession(input.threadId);
    // `stopSession` sets `stopped` and then AWAITS termination. During that
    // await the child's exit handler frees the turn slot, which re-opens the
    // guard below — so without this check a turn could spawn after stop, bill
    // tokens, and publish `content.text-delta`/`turn.completed` AFTER
    // `session.exited`.
    if (record.stopped) {
      throw this.refuseSend(
        input.threadId,
        new SendTurnRefusedError('This Muse session is stopped.'),
      );
    }
    if (record.serve) return this.sendServeTurn(record, record.serve, input);
    // The slot is held until the child EXITS, not until the turn settles: two
    // `muse exec` processes must never run concurrently against one
    // `--session-id`. #2300 (review M5): the server frees a turn at its
    // terminal event, so a queued send can arrive while the previous child
    // is still exiting; that is waited out briefly, not refused.
    const previous = record.activeTurn;
    if (previous?.settled && !previous.terminationUnconfirmed) {
      await this.waitForSlotRelease(previous);
      // A Stop that lands during the wait acts on the OLD turn (the one
      // still in the slot), which is the right target; this send is then
      // refused cleanly, as a pre-effect refusal, rather than thrown as a
      // plain error the orchestration layer would record as indeterminate.
      if (record.stopped) {
        throw this.refuseSend(
          input.threadId,
          new SendTurnRefusedError('This Muse session is stopped.'),
        );
      }
    }
    const occupant = record.activeTurn;
    if (occupant) {
      // Retryable only while the previous child is merely exiting. If
      // Station already tried to stop it and could not confirm it stopped
      // (Stop, stopSession, or a deadline reap left it termination-
      // unconfirmed), no prompt retry will succeed: the slot frees only if
      // the process exits on its own or the lingering-child reap, one window
      // later, confirms stopping it (with no declared idle bound, measured
      // from the settle: an unconfirmed Stop is retried 30 minutes after the
      // Stop, not after the turn's last activity). That is the definitive refusal, still a
      // pre-effect one so the dispatch is retired cleanly.
      if (occupant.settled && !occupant.terminationUnconfirmed) {
        throw this.refuseSend(
          input.threadId,
          new MuseTurnSlotReleasingError(input.threadId),
        );
      }
      if (occupant.settled) {
        throw this.refuseSend(
          input.threadId,
          new SendTurnRefusedError(
            'Station could not confirm that the previous Muse process stopped. It will try stopping it again; this message can be sent again after that.',
          ),
        );
      }
      // #2415: the occupant is a live turn. Refusing is certain and nothing
      // was spawned, so this is a pre-effect refusal too; a plain error here
      // was recorded as an indeterminate turn start, whose lingering
      // boundary row blocked every later send on the thread. The thread id
      // stays out of the message (see `refuseSend`).
      throw this.refuseSend(
        input.threadId,
        new SendTurnRefusedError(
          'This Muse session already has an active turn.',
        ),
      );
    }
    this.reportProviderNoticeOnce();
    this.reportRefusedTurnBudgetOnce();
    const turnId = crypto.randomUUID();
    const modelId = input.modelId ?? record.modelId;
    const decoded = decodeChatAttachments(input.attachments);
    rejectFileAttachments('Muse Code', decoded);
    if (decoded.length && this.providerOverride === 'echo')
      throw new Error('Muse echo does not accept image attachments.');
    let imageDirectory: string | undefined;
    const imagePaths: string[] = [];
    const cleanupImages = () => {
      if (!imageDirectory) return;
      try {
        rmSync(imageDirectory, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        this.options.logger?.warn?.('Muse image staging cleanup was deferred.');
      }
      imageDirectory = undefined;
    };
    try {
      if (decoded.length)
        imageDirectory = mkdtempSync(join(tmpdir(), 'station-muse-images-'));
      for (const [index, image] of decoded.entries()) {
        const extension = image.attachment.mimeType.split('/')[1];
        const path = join(imageDirectory!, `${index}.${extension}`);
        writeFileSync(path, Buffer.from(image.base64, 'base64'), {
          mode: 0o600,
        });
        imagePaths.push(path);
      }
    } catch (error) {
      cleanupImages();
      throw error;
    }
    const args = buildMuseExecArgs({
      imagePaths,
      sessionId: record.museSessionId,
      prompt: input.input,
      modelId,
      cwd: record.cwd,
      // Omitted entirely when unset, which is the default: the argv is then
      // byte-identical to the one Station has always built.
      ...(this.providerOverride ? { provider: this.providerOverride } : {}),
    });

    let spawned: MuseSpawnResult;
    try {
      spawned = this.processFactory(args, record.cwd);
    } catch (error) {
      cleanupImages();
      throw error;
    }
    const turnStartedAt = Date.now();
    let resolveSlotReleased: () => void = () => {};
    const slotReleased = new Promise<void>((resolve) => {
      resolveSlotReleased = resolve;
    });
    const turn: MuseActiveTurn = {
      turnId,
      process: spawned.process,
      release: () => {
        try {
          spawned.release?.();
        } finally {
          cleanupImages();
        }
      },
      startedAt: turnStartedAt,
      idleLimitMs: this.turnIdleTimeoutMs,
      lingeringChildReapMs: this.lingeringChildReapMs,
      totalLimitMs: this.turnTimeoutMs,
      lastProgressAt: turnStartedAt,
      seenToolCallIds: [],
      toolTasks: new Map(),
      openToolCalls: new Map(),
      awaitingResultToolCalls: new Map(),
      pendingBackgroundTasks: new Map(),
      awaitingReportTasks: new Set(),
      settledBeforeHold: new Set(),
      slotReleased,
      resolveSlotReleased,
      heldRuns: 0,
      runSeparatorPending: false,
      runStreamedText: false,
      backgroundRowsClosedAtSettle: 0,
      outputText: '',
      settled: false,
      interrupted: false,
      stdoutBuffer: '',
      stderrText: '',
      stderrLogged: false,
      stdoutOverflowed: false,
    };
    record.activeTurn = turn;
    record.modelId = modelId;
    const appliedModelId = this.appliedModelId(modelId);
    record.session = {
      ...record.session,
      status: 'running',
      // Under `echo` the claim is CLEARED, not carried: a plain
      // `modelId ?? record.session.model` would let an earlier reported model
      // survive a turn that provably ran without one.
      model:
        this.providerOverride === 'echo'
          ? undefined
          : (appliedModelId ?? record.session.model),
      updatedAt: this.now().toISOString(),
    };
    this.attachProcess(record, turn);
    this.armTurnDeadlines(record, turn);

    // Independent review MEDIUM-1: carries the server-owned
    // `firstTurnInstructionsComposed` marker (reserved metadata, stripped
    // from any caller-supplied value) onto THIS turn's own persisted
    // record — see the constant's doc comment in provider.ts — so the
    // delegate-seam disclosure can derive 'delivered' from this turn
    // having actually composed it, not merely from having started.
    // #2269: host-authored supervision facts for the delegation projection.
    // Computed here from server-owned config only — never from
    // `input.metadata` (caller-influenced) or child output. The projection
    // forwards these; other adapters omit them (honest unknown).
    const turnStartedAtIso = new Date(turnStartedAt).toISOString();
    const turnStartedMetadata: Record<string, unknown> = {
      ...(input.recoveryCorrelationId
        ? { recoveryCorrelationId: input.recoveryCorrelationId }
        : {}),
      ...(input.metadata?.[FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]
        ? { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true }
        : {}),
      // #2452: exec applies `--approval-mode never` inside muse's sandbox
      // whatever was requested — `auto` in Station's vocabulary — so a
      // requested posture is answered with what actually applied.
      ...(readApprovalMode(input.modelOptions) ? { approvalMode: 'auto' } : {}),
      // Each bound appears only when it was declared, because only then
      // does anything enforce it. With neither (production), the
      // declaration says exactly that: this turn has no Station-imposed
      // bound, and the delegation projection shows "none declared".
      supervision: {
        provider: this.provider,
        turnId,
        startedAt: turnStartedAtIso,
        ...(this.turnTimeoutMs === undefined
          ? {}
          : {
              deadlineAt: new Date(
                turnStartedAt + this.turnTimeoutMs,
              ).toISOString(),
              totalLimitMs: this.turnTimeoutMs,
            }),
        ...(this.turnIdleTimeoutMs === undefined
          ? {}
          : { idleLimitMs: this.turnIdleTimeoutMs }),
      },
    };
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: this.now().toISOString(),
      method: 'turn.started',
      turnId,
      prompt: input.displayInput ?? input.input,
      ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
      ...(Object.keys(turnStartedMetadata).length > 0
        ? { metadata: turnStartedMetadata }
        : {}),
    });
    providerOps.add(1, {
      operation: 'adapter-turn-start',
      provider: this.provider,
    });

    return { threadId: input.threadId, turnId };
  }

  private async sendServeTurn(
    record: MuseSessionRecord,
    serve: MuseServeSession,
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const decoded = decodeChatAttachments(input.attachments);
    rejectFileAttachments('Muse Code', decoded);
    const approvalMode: ApprovalMode | undefined = readApprovalMode(
      input.modelOptions,
    );
    let turnId: string;
    try {
      ({ turnId } = await serve.sendTurn({
        prompt: input.input,
        displayPrompt: input.displayInput ?? input.input,
        images: decoded.map((image) => ({
          mediaType: image.attachment.mimeType,
          base64: image.base64,
        })),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(approvalMode ? { approvalMode } : {}),
        ...(input.ambientContext
          ? { ambientContext: input.ambientContext }
          : {}),
        ...(input.recoveryCorrelationId
          ? { recoveryCorrelationId: input.recoveryCorrelationId }
          : {}),
        ...(input.metadata?.[FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]
          ? { firstTurnInstructionsComposed: true }
          : {}),
      }));
    } catch (error) {
      if (error instanceof SendTurnRefusedError) {
        throw this.refuseSend(input.threadId, error);
      }
      throw error;
    }
    if (input.modelId) record.modelId = input.modelId;
    record.session = {
      ...record.session,
      status: 'running',
      model: input.modelId ?? record.session.model,
      updatedAt: this.now().toISOString(),
    };
    providerOps.add(1, {
      operation: 'adapter-turn-start',
      provider: this.provider,
    });
    return { threadId: input.threadId, turnId };
  }

  /**
   * #2452: stop ONE Muse workflow subagent (`subagent/stop`), leaving the
   * turn and its siblings running. Serve sessions only: `muse exec` names no
   * subagent, so an exec session has nothing to address.
   */
  async stopProviderTask(
    threadId: string,
    taskId: string,
  ): Promise<ProviderTaskStopResult> {
    const record = this.requireSession(threadId);
    if (!record.serve) return { outcome: 'unsupported' };
    return record.serve.stopChild(taskId);
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.requireSession(threadId);
    if (record.serve) return record.serve.interrupt(turnId);
    const turn = record.activeTurn;
    // Deliberately NOT gated on `turn.settled`. The slot is held until the
    // child exits, so a child that emits `run_terminal` and then wedges is
    // still occupying this session — stop is the only user-facing way to
    // reclaim it, and skipping a settled turn here left the session blocked
    // until the turn deadline. `settleTurn`/`finishTurn` are both idempotent,
    // so re-entering with a settled turn cannot double-close it.
    if (!turn) return { outcome: 'no-active-turn' } as const;
    if (turnId && turnId !== turn.turnId) {
      return { outcome: 'target-mismatch', activeTurnId: turn.turnId } as const;
    }
    turn.interrupted = true;
    const terminationConfirmed = await this.terminateTurn(turn);
    // The child's `exit` handler settles the turn (`turn.aborted`, because
    // `interrupted` is set) and frees the slot. If the process never emits
    // `exit` after being terminated, settle and free here so the turn cannot
    // stay open — and the session cannot stay blocked — forever.
    this.settleTurn(record, turn, {
      kind: 'aborted',
      abortReason: 'interrupted',
      terminationConfirmed,
    });
    if (terminationConfirmed) {
      this.finishTurn(record, turn);
      return { outcome: 'cancelled', turnId: turn.turnId } as const;
    }
    // Keep the settled turn handle in the single slot. The child is still
    // alive, so freeing it would allow a replacement turn to overwrite the
    // only handle capable of a forced teardown retry.
    return { outcome: 'termination-unconfirmed', turnId: turn.turnId } as const;
  }

  /**
   * Serve sessions (#2452) answer the engine's own approval: see
   * `MuseServeSession.respond`. `muse exec` exposes no approval channel, so
   * an exec session never publishes `request.opened` and there is nothing to
   * resolve against the engine. Publish-only there, mirroring the Ollama
   * adapter: a caller that resolves an unknown request still gets a matching
   * `request.resolved` rather than a thrown error.
   */
  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const serve = this.sessions.get(threadId)?.serve;
    if (serve) {
      await serve.respond(requestId, decision);
      return;
    }
    const statusMap: Record<
      string,
      'approved' | 'denied' | 'cancelled' | 'expired'
    > = {
      accept: 'approved',
      acceptForSession: 'approved',
      decline: 'denied',
      cancel: 'cancelled',
    };
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      requestId,
      method: 'request.resolved',
      status: statusMap[decision] ?? 'cancelled',
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) return;
    record.stopped = true;
    // Serve: the host ends with the session (its pending approvals resolve
    // cancelled, running turns abort, running children settle unresolved).
    await record.serve?.stop();
    const turn = record.activeTurn;
    if (turn) {
      turn.interrupted = true;
      const terminationConfirmed = await this.terminateTurn(turn);
      if (!terminationConfirmed) {
        // Retain both the session and the original child handle. Deleting the
        // record here would abandon a live process and could let a later stop
        // kill an unrelated replacement turn instead.
        throw new Error(
          `Muse session stop could not confirm termination for turn ${turn.turnId}.`,
        );
      }
      this.settleTurn(record, turn, {
        kind: 'aborted',
        abortReason: 'session-stopped',
        terminationConfirmed: true,
      });
      this.finishTurn(record, turn);
    }
    this.sessions.delete(threadId);
    const nowIso = this.now().toISOString();
    record.session = {
      ...record.session,
      status: 'closed',
      updatedAt: nowIso,
    };
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: nowIso,
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) => this.stopSession(threadId)),
      );
    } finally {
      this.events.close();
    }
  }

  streamEvents(
    options?: AsyncEventStreamOptions,
  ): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  private publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private requireSession(threadId: string): MuseSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) {
      throw new Error(`Muse session not found for thread: ${threadId}`);
    }
    return record;
  }

  private attachProcess(record: MuseSessionRecord, turn: MuseActiveTurn): void {
    turn.process.stdout.on('data', (chunk: Buffer | string) => {
      const { lines, remainder } = splitMuseLines(
        turn.stdoutBuffer,
        chunk.toString(),
      );
      // Bounded like stderr: a child writing without newlines would otherwise
      // grow this buffer for the life of the turn. An over-long partial line
      // is unparseable JSON anyway, so it is dropped rather than retained.
      if (remainder.length > MUSE_STDOUT_BUFFER_MAX_CHARS) {
        turn.stdoutBuffer = '';
        if (!turn.stdoutOverflowed) {
          turn.stdoutOverflowed = true;
          this.options.logger?.warn?.(
            `Muse wrote an unterminated stdout line over ${MUSE_STDOUT_BUFFER_MAX_CHARS} characters; the partial line was discarded.`,
          );
        }
      } else {
        turn.stdoutBuffer = remainder;
      }
      for (const line of lines) {
        this.handleStdoutLine(record, turn, line);
      }
    });
    turn.process.stderr.on('data', (chunk: Buffer | string) => {
      this.handleStderr(turn, chunk.toString());
    });
    turn.process.on('exit', (code) => {
      // Flush a final unterminated line: muse's last JSON object can arrive
      // without a trailing newline.
      const pending = turn.stdoutBuffer;
      turn.stdoutBuffer = '';
      if (pending.trim()) {
        this.handleStdoutLine(record, turn, pending);
      }
      // A per-turn child exiting is normal; it is NOT a session exit. But the
      // turn must still close, or `hasOpenTurn` stays true forever.
      if (!turn.settled) {
        if (turn.interrupted) {
          this.settleTurn(record, turn, {
            kind: 'aborted',
            abortReason: 'interrupted',
            // The child just exited: that much is observed.
            terminationConfirmed: true,
          });
        } else if (
          turn.heldRuns > 0 &&
          code === 0 &&
          !turn.process.signalCode &&
          turn.pendingBackgroundTasks.size === 0 &&
          turn.awaitingReportTasks.size > 0 &&
          [...turn.awaitingReportTasks].every((taskId) =>
            turn.settledBeforeHold.has(taskId),
          )
        ) {
          // #2300 (conservative), for exactly the UNVERIFIED case: every
          // task the turn is held for settled BEFORE the turn was first held
          // (i.e. before the run that launched it ended), no follow-up run
          // was accepted in this hold, and muse then exited cleanly. The one
          // live capture shows muse following up a task that settles AFTER
          // that terminal, never one that settled before it — so this exit
          // is closed exactly as before #2300: a completed turn with the
          // text so far, `stop`, and no warning. Any other clean exit while
          // held (a task pending at the first terminal that then settled, or
          // a follow-up that started and was cut off) is the verified shape
          // going wrong, and gets the warning below.
          this.settleTurn(record, turn, {
            kind: 'completed',
            finishReason: 'stop',
            outputText: turn.outputText,
          });
        } else if (turn.heldRuns > 0) {
          // #2300: a held turn whose child exited without a further
          // terminal. Run 1 completed, so this is not a failed turn — and a
          // `runtime.error` would offer "Send again", re-launching the work
          // run 1 already started. `other` because nothing reported how the
          // follow-up ended: it is not a proven `stop`, so it gets no clear
          // authority (`finish-reason-authority.ts`). Any task still pending
          // is closed as unresolved by settle; the exit itself is recorded
          // by the warning.
          const signal = turn.process.signalCode;
          this.publishHeldTurnUnfinished(
            record,
            turn,
            `Muse's process exited (${
              signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
            }) before it delivered the result of background work this turn launched.`,
          );
          this.settleTurn(record, turn, {
            kind: 'completed',
            finishReason: 'other',
            outputText: turn.outputText,
          });
        } else {
          this.settleTurn(record, turn, {
            kind: 'error',
            error: {
              message: `Muse exited before reporting a terminal result (code: ${code ?? 'unknown'}).`,
              code: 'muse-exit-without-terminal',
            },
          });
        }
      }
      // The child is gone: only now is it safe to free the turn slot and drop
      // the owned-process record. Freeing at `run_terminal` (while the child
      // still runs) would let a second `muse exec` start against the same
      // `--session-id`, and would un-register a child that can still wedge.
      this.releaseOwnedChild(turn);
      this.finishTurn(record, turn);
    });
    turn.process.on('error', (error) => {
      // A child that failed to start emits `error` and may never emit `exit`
      // (spawn ENOENT), so this path frees the slot itself.
      this.settleTurn(record, turn, {
        kind: 'error',
        error: {
          message: `Muse failed to start: ${error.message}`,
          code: 'muse-spawn-failed',
        },
      });
      this.finishTurn(record, turn);
    });
  }

  private handleStdoutLine(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    line: string,
  ): void {
    const parsed = parseMuseLine(line);
    if (!parsed) {
      // Malformed or unshaped lines are tolerated, not fatal: a partial write
      // or a future envelope must never tear down a live turn.
      if (line.trim()) {
        this.options.logger?.warn?.(
          'Muse emitted a JSONL line Station could not parse.',
        );
      }
      return;
    }
    const effect = translateMuseRecord(parsed);
    if (effect.kind === 'ignored') return;
    if (turn.settled) return;

    if (effect.kind === 'text-delta') {
      turn.itemId ??= crypto.randomUUID();
      // #2300: the first text of a follow-up run is joined to the held
      // run's text by a paragraph break, in the stream itself, so what the
      // live transcript renders and `turn.completed.outputText` agree.
      const delta = turn.runSeparatorPending
        ? `\n\n${effect.delta}`
        : effect.delta;
      turn.runSeparatorPending = false;
      turn.runStreamedText = true;
      turn.outputText += delta;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'content.text-delta',
        turnId: turn.turnId,
        itemId: turn.itemId,
        delta,
      });
      // `translateMuseRecord` already drops empty deltas, so reaching here is
      // verified protocol activity — never a heartbeat. Reschedules IDLE only;
      // a declared total never moves.
      this.noteVerifiedActivity(record, turn);
      return;
    }

    if (effect.kind === 'background-follow-up') {
      // #2300: muse submitted the run that reports every background task
      // settled so far, so the turn no longer owes their report; its
      // terminal can release the hold. A task that settles DURING this run
      // lands in `awaitingReportTasks` again and holds the turn for the next
      // follow-up.
      turn.awaitingReportTasks.clear();
      return;
    }

    if (effect.kind === 'task-lifecycle') {
      // #2300: a final phase for an announced background task settles its
      // row. Such a task has no `tool.*` binding (muse reports only its
      // final phase), so `observeMuseToolTask` below ignores it.
      if (turn.pendingBackgroundTasks.has(effect.taskId)) {
        this.settleBackgroundTask(record, turn, effect.taskId, effect.phase);
      }
      // #2308: muse 1.3 names the tool and its `call_id` on the tool task's
      // lifecycle records, so a start can be opened under the SAME id its
      // `tool_result` later closes (see `observeMuseToolTask`).
      const observed = observeMuseToolTask(
        turn.toolTasks,
        effect,
        MUSE_SEEN_TOOL_CALL_IDS_MAX,
      );
      if (!observed) return;
      if (observed.kind === 'cancelled') {
        this.closeCancelledTool(record, turn, observed);
        return;
      }
      if (observed.kind === 'finished') {
        // The task ended; its result is still owed and still pairs, but the
        // tool is no longer running, so it stops holding idle disarmed. A
        // result that never arrives is closed as unresolved at settle.
        if (
          turn.openToolCalls.has(observed.toolCallId) &&
          !turn.awaitingResultToolCalls.has(observed.toolCallId)
        ) {
          turn.awaitingResultToolCalls.set(
            observed.toolCallId,
            observed.outcome,
          );
          this.noteVerifiedActivity(record, turn);
        }
        return;
      }
      const start = observed;
      // At most one start per call id, and never a start for a call whose
      // result already arrived: that would reopen a finished row.
      if (
        turn.openToolCalls.has(start.toolCallId) ||
        turn.seenToolCallIds.includes(start.toolCallId)
      ) {
        return;
      }
      turn.openToolCalls.set(start.toolCallId, start.toolName);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'tool.started',
        turnId: turn.turnId,
        itemId: `tool:${start.toolCallId}`,
        toolCallId: start.toolCallId,
        toolName: start.toolName,
      });
      // A newly started tool is verified activity, counted once per call id
      // exactly like a newly identified result.
      this.noteVerifiedActivity(record, turn);
      return;
    }

    if (effect.kind === 'tool-completed') {
      // A result that omits `correlation_facts.tool_name` still pairs with
      // the start this turn opened under its `call_id`, which named the tool
      // from muse's own `task_kind`. With no such start there is nothing to
      // name it by, so it is dropped rather than published under a guess.
      const toolName =
        effect.toolName ?? turn.openToolCalls.get(effect.toolCallId);
      if (!toolName) return;
      // At most one `tool.completed` per call id per turn: a result for a
      // call already closed (by an earlier result, or by its task reporting
      // `cancelled`) is dropped, so a replayed or late receipt cannot add a
      // second outcome row. `seenToolCallIds` is bounded (oldest-first), so
      // a call evicted from it reads as new again — the same disclosed
      // bound its idle bookkeeping has.
      if (turn.seenToolCallIds.includes(effect.toolCallId)) return;
      // Its own itemId keeps the tool row distinct from the assistant text
      // item, and matches the `tool.started` itemId for the same call.
      turn.openToolCalls.delete(effect.toolCallId);
      turn.awaitingResultToolCalls.delete(effect.toolCallId);
      const isNewToolResult = !turn.seenToolCallIds.includes(effect.toolCallId);
      const preview = projectBoundedToolOutput(effect.output);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${effect.toolCallId}`,
        toolCallId: effect.toolCallId,
        toolName,
        status: effect.status,
        ...(effect.output === null ? {} : { output: preview.value }),
        ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
      });
      // Replay/duplicate completion receipts must not extend idle: only a
      // NEWLY identified tool result counts. Malformed/unknown/heartbeat
      // frames never reach this branch (`ignored` returns above).
      if (isNewToolResult) {
        if (turn.seenToolCallIds.length >= MUSE_SEEN_TOOL_CALL_IDS_MAX) {
          turn.seenToolCallIds.shift();
        }
        turn.seenToolCallIds.push(effect.toolCallId);
      }
      // #2300: after the launching call's own row closed, so its background
      // row reads after it. Opening one disarms idle, so it precedes the
      // activity note below.
      const launchedTaskId = parseMuseLaunchedBackgroundTask(
        toolName,
        effect.output,
      );
      if (launchedTaskId !== null) {
        this.announceBackgroundTask(
          record,
          turn,
          launchedTaskId,
          effect.toolCallId,
          toolName,
        );
      }
      if (isNewToolResult) {
        this.noteVerifiedActivity(record, turn);
      }
      return;
    }

    // #2300: a turn still owed a background report (a task pending, or
    // settled with no follow-up run submitted for it yet) is held; a held
    // turn's text accumulates across runs, and a terminal that is not
    // `completed` closes it honestly rather than as a failure (see the class
    // docblock).
    if (effect.completed && this.owesBackgroundReport(turn)) {
      this.appendRunTerminalText(turn, effect.text);
      this.holdTurn(turn);
      return;
    }
    if (turn.heldRuns > 0) {
      this.appendRunTerminalText(turn, effect.text);
      if (!effect.completed) {
        const terminal = this.boundedTerminalField(effect.terminal);
        const reason = this.boundedTerminalField(effect.reason);
        this.publishHeldTurnUnfinished(
          record,
          turn,
          `Muse's follow-up run ended without completing (terminal: ${terminal ?? 'unknown'}${reason ? `, reason: ${reason}` : ''}).`,
        );
      }
      this.settleTurn(record, turn, {
        kind: 'completed',
        // `stop` only for a completed terminal; otherwise muse's own
        // terminal classifies it (`cancelled` or `other`), neither of which
        // carries clear authority (`finish-reason-authority.ts`).
        finishReason: effect.finishReason,
        outputText: turn.outputText,
      });
      return;
    }

    // `run_terminal.text` is the FULL turn text, so it is used only when no
    // deltas streamed — appending it would duplicate what the transcript
    // already rendered. On the failure branch this is that text's only
    // remaining carrier (`settleTurn`'s `outputTextDetail` folds it into
    // `runtime.error.message` — archive#3450 review).
    const outputText =
      turn.outputText.length > 0 ? turn.outputText : (effect.text ?? undefined);
    // Bounded (archive#3450 review round 2 — MUSE_TERMINAL_FIELD_MAX_CHARS):
    // `effect.terminal`/`effect.reason` are child-controlled JSONL with no
    // length cap of their own, and this message's PREFIX is not covered by
    // `outputTextDetail`'s/`stderrDetail`'s bounds.
    const boundedTerminal = this.boundedTerminalField(effect.terminal);
    const boundedReason = this.boundedTerminalField(effect.reason);
    this.settleTurn(
      record,
      turn,
      effect.completed
        ? { kind: 'completed', finishReason: effect.finishReason, outputText }
        : {
            kind: 'error',
            outputText,
            error: {
              message: `Muse turn ended without completing (terminal: ${boundedTerminal ?? 'unknown'}${boundedReason ? `, reason: ${boundedReason}` : ''}).`,
              code: 'muse-terminal-not-completed',
            },
          },
    );
  }

  /**
   * Retains a bounded stderr tail; publishes NOTHING on its own.
   *
   * muse writes to stderr on every single invocation (`muse: workspace root:
   * <path>`), so publishing a `runtime.warning` here put a content-free toast
   * in front of the user on every turn — a new noise class (Codex's
   * equivalent warning is per-SESSION). The tail is instead appended to the
   * `runtime.error` a failed turn publishes, where it is the actual
   * diagnosis, and relayed once per turn to the server log so routine stderr
   * is recorded without interrupting anyone.
   *
   * The bound matters independently: `AsyncEventQueue` clears itself on
   * overflow, so an unbounded relay of a chatty child could discard the
   * turn's real events.
   */
  private handleStderr(turn: MuseActiveTurn, chunk: string): void {
    if (!chunk.trim()) return;
    // Keep the TAIL, not the head. muse prints a routine banner
    // (`muse: workspace root: …`, plus any rules-file warning) on every
    // invocation, which is ~300 chars before a failure reason is ever
    // written — retaining the head spent the whole budget on the banner and
    // dropped the one line this error exists to carry.
    turn.stderrText = (turn.stderrText + chunk).slice(
      -MUSE_STDERR_TAIL_MAX_CHARS,
    );
    if (turn.stderrLogged) return;
    turn.stderrLogged = true;
    this.options.logger?.info?.('Muse emitted stderr output during a turn.');
  }

  /**
   * The bounded stderr tail, formatted for a terminal error message.
   *
   * Scrubbed on the way out. Canonical runtime events are persisted and
   * rendered verbatim — `redactDeep` guards the LOGGING seam, not this one —
   * and muse is the first adapter to carry raw child stderr into an event
   * payload. Auth failures are exactly the output most likely to echo a
   * credential back, so the bound here is on content as well as length.
   */
  private stderrDetail(turn: MuseActiveTurn): string {
    const tail = redactSecrets(turn.stderrText).trim();
    return tail ? ` muse stderr: ${tail}` : '';
  }

  /**
   * Bounded, SCRUBBED formatting of turn text muse had produced or reported
   * before a failure, for `runtime.error.message` (archive#3450 review).
   *
   * Two of the four `error`-outcome call sites compute and pass
   * `outputText` — `handleStdoutLine`'s non-`completed` `run_terminal`
   * branch and `armTurnDeadline`'s timeout — and this is the only place that
   * outcome ever reads it, since a failed turn never publishes
   * `turn.completed`. Dropping it silently would be a product regression at
   * the narrower of the two: when no `content.text-delta` streamed, a
   * non-`completed` `run_terminal.text` is the ONLY carrier of that text
   * anywhere in the event stream, and `event-store.ts`'s message-search
   * indexing reads only `turn.completed.outputText` — so a failed turn's
   * sole explanatory text would otherwise vanish from both the transcript
   * and search. When deltas DID stream, this is redundant with what the
   * durable projection already reconstructed from them, but including it is
   * harmless (bounded, same as the stderr tail below).
   *
   * `redactSecrets` (archive#3450 review round 2): `stderrDetail` scrubs
   * because "auth failures are exactly the output most likely to echo a
   * credential back" — and this detail lands in the exact same
   * `runtime.error.message` string, at failure time, from a `run_terminal`
   * whose `text` muse itself produced. `turn.outputText` is already
   * published unscrubbed elsewhere (`content.text-delta`,
   * `turn.completed.outputText`), so this adds no new exposure class, but
   * leaving it unscrubbed here specifically would put unredacted text
   * immediately next to a redacted stderr tail inside one string.
   */
  private outputTextDetail(outputText: string | undefined): string {
    const trimmed = outputText?.trim();
    if (!trimmed) return '';
    // Redact BEFORE truncating, not after. Truncating first defeats the scrub
    // on a secret that straddles the cut — `slice(-500)` of a 600-char string
    // starting mid-token leaves a fragment with no `sk-` prefix, which
    // `redactSecrets` cannot match and which then publishes. Redacting first
    // also makes the bound literally true, since redaction can LENGTHEN a
    // string (`Bearer x` -> `Bearer [REDACTED]`).
    const redacted = redactSecrets(trimmed);
    const tail =
      redacted.length > MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS
        ? redacted.slice(-MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS)
        : redacted;
    return ` muse output before failure: ${tail}`;
  }

  /**
   * Bounds `effect.terminal`/`effect.reason` before they are interpolated
   * into `muse-terminal-not-completed`'s `runtime.error.message` PREFIX
   * (archive#3450 review round 2 — see `MUSE_TERMINAL_FIELD_MAX_CHARS`).
   * Head-truncated, not tail: unlike `outputTextDetail`'s free-form assistant
   * text (where the most RECENT content is the more diagnostic end), these
   * are short discriminator-shaped fields, so the front of an oversized value
   * is the more legible truncation.
   *
   * Scrubbed for the same reason `outputTextDetail` and `stderrDetail` are:
   * this lands in the same `runtime.error.message`, at the same failure
   * moment, from the same `run_terminal` record — and `reason` is the field
   * an engine is most likely to fill with an auth error (`401 unauthorized
   * for key sk-…`), which is the category that motivated scrubbing at all.
   * Leaving it bare would put one unredacted segment between two redacted
   * ones in a single string.
   */
  private boundedTerminalField(value: string | null): string | null {
    if (!value) return value;
    const redacted = redactSecrets(value);
    return redacted.length > MUSE_TERMINAL_FIELD_MAX_CHARS
      ? `${redacted.slice(0, MUSE_TERMINAL_FIELD_MAX_CHARS)}…`
      : redacted;
  }

  /**
   * archive#3450: a failed turn publishes `runtime.error` ONLY — never
   * alongside `turn.completed`. Before that fix every non-aborted failure
   * path pushed BOTH events into the same `AsyncEventQueue`: the lifecycle
   * fold reads strict FIFO and lands on `failed` (the last write wins
   * there), but every OTHER consumer of the stream — the "your agent
   * finished" push notification, `engine_turn` telemetry, the
   * `turn.event.projected` receipt, and `background-tasks-store.ts`'s
   * `closeDelegate` (which no-ops once the card already read `completed`) —
   * observed the intermediate `turn.completed` first and reported success
   * for a turn that failed. See bedrock-adapter.ts's and ollama-adapter.ts's
   * `publishTurnFailure` (archive#3442), which this mirrors.
   *
   * `MuseTurnSettleOutcome`'s discriminated union (archive#3450 review) is
   * what makes "exactly one of `turn.aborted` / `runtime.error` /
   * `turn.completed` per turn" true here: a caller cannot construct an
   * `outcome` that is both `aborted` and `error`, so this `switch` is
   * exhaustive by construction rather than by a comment asserting every call
   * site happens to agree.
   */
  private settleTurn(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    outcome: MuseTurnSettleOutcome,
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    const nowIso = this.now().toISOString();

    // #2308: a tool this turn started but never reported a result for is
    // closed BEFORE the turn's terminal. Muse's engine run is one process
    // per turn, and once the turn settles this adapter reads nothing more
    // from it, so no result can ever reach Station for these calls. The
    // projection deliberately carries an open call past its turn
    // (station#1558), so without this the row would read "running" forever.
    // For a call still RUNNING, `unresolved` with the turn-scoped sentence
    // says exactly that: no result, fate unknown — not a failure and not a
    // cancellation. A call whose task muse already reported finished keeps
    // that verdict (see below). (A task
    // that is proposed and never starts opened no row, so it needs none.)
    const openToolCalls = [...turn.openToolCalls];
    const finishedPhases = new Map(turn.awaitingResultToolCalls);
    turn.openToolCalls.clear();
    turn.awaitingResultToolCalls.clear();
    for (const [toolCallId, toolName] of openToolCalls) {
      // A call whose task muse reported finished keeps muse's verdict; only
      // a call still RUNNING at settle has an unknown fate.
      const phase = finishedPhases.get(toolCallId);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: nowIso,
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${toolCallId}`,
        toolCallId,
        toolName,
        ...(phase === 'completed'
          ? { status: 'success', output: MUSE_FINISHED_NO_RESULT_OUTPUT }
          : phase === 'failed'
            ? { status: 'error', output: MUSE_FAILED_NO_RESULT_OUTPUT }
            : { status: 'unresolved', output: UNRESOLVED_TURN_TOOL_OUTPUT }),
      });
    }
    // #2300: background work still pending when the turn ends gets the same
    // closure, also BEFORE the terminal. `aborted` means Stop / stopSession,
    // which signal the child's process group: `cancelled`, with wording that
    // claims no more than was observed. Anything else (the child exited, a
    // declared budget, a follow-up terminal that did not complete) leaves
    // the task's fate unknown: `unresolved`. Settle is final for this turn —
    // the adapter reads nothing from the child after it — so nothing later
    // supersedes these rows.
    const pendingBackground = [...turn.pendingBackgroundTasks];
    turn.pendingBackgroundTasks.clear();
    turn.awaitingReportTasks.clear();
    for (const [taskId, task] of pendingBackground) {
      const rowId = museBackgroundTaskRowId(taskId);
      this.rememberSettledRow(turn, rowId);
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: nowIso,
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${rowId}`,
        toolCallId: rowId,
        toolName: task.toolName,
        ...(outcome.kind === 'aborted'
          ? {
              status: 'cancelled',
              output: outcome.terminationConfirmed
                ? MUSE_BACKGROUND_TASK_STOPPED_OUTPUT
                : MUSE_BACKGROUND_TASK_STOP_UNCONFIRMED_OUTPUT,
            }
          : {
              status: 'unresolved',
              output: MUSE_BACKGROUND_TASK_UNRESOLVED_OUTPUT,
            }),
      });
    }
    if (outcome.kind !== 'aborted') {
      turn.backgroundRowsClosedAtSettle = pendingBackground.length;
    }
    // Parity with the pre-#2308 schedule for a settled turn: there, the idle
    // timer was always pending at settle, so a child that lingers after its
    // terminal was reaped one idle window on. Several things now leave a
    // live turn with no idle timer — no idle bound declared (the default,
    // #2269), a tool in flight (#2308), background work pending, and a turn
    // held for its follow-up run (#2300) — so the invariant is restored here
    // directly: a turn that settles with no idle timer gets the
    // lingering-child reap, from now (the time before was the turn's, not
    // the child's). Keyed on the missing timer rather than on the reasons it
    // was missing, so a future reason to disarm idle cannot silently strand
    // a lingering child (and with it the session's slot) again. A timer that
    // already fired (a declared idle deadline that caused this settle) is
    // still set, so it is not rescheduled. If the reap ends a child whose
    // background rows were closed here, it is announced
    // (`scheduleIdleTimer`), not silent.
    if (!turn.idleTimeoutHandle) {
      this.scheduleIdleTimer(record, turn);
    }

    switch (outcome.kind) {
      case 'aborted':
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: record.externalThreadId,
          createdAt: nowIso,
          method: 'turn.aborted',
          turnId: turn.turnId,
          reason: outcome.abortReason,
        });
        break;
      case 'error':
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: record.externalThreadId,
          createdAt: nowIso,
          method: 'runtime.error',
          severity: 'error',
          turnId: turn.turnId,
          // The bounded output-text detail and stderr tail ride the error
          // rather than a warning of their own: for a turn that died on an
          // expired key or an unknown model, this message is the ONLY
          // diagnosis the user gets, and an exit code alone names nothing.
          message: `${outcome.error.message}${this.outputTextDetail(outcome.outputText)}${outcome.omitStderr ? '' : this.stderrDetail(turn)}`,
          code: outcome.error.code,
          retriable: false,
        });
        break;
      case 'completed':
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: record.externalThreadId,
          createdAt: nowIso,
          method: 'turn.completed',
          turnId: turn.turnId,
          finishReason: outcome.finishReason,
          ...(outcome.outputText === undefined
            ? {}
            : { outputText: outcome.outputText }),
        });
        break;
      default: {
        // Exhaustiveness check: a new `MuseTurnSettleOutcome` variant that
        // isn't handled above fails the build here, not at runtime.
        const unhandled: never = outcome;
        throw new Error(
          `Unhandled Muse turn settle outcome: ${JSON.stringify(unhandled)}`,
        );
      }
    }

    adapterTurnDuration.record(Date.now() - turn.startedAt, {
      provider: this.provider,
    });
    providerOps.add(1, {
      operation: 'adapter-turn-complete',
      provider: this.provider,
    });

    if (!record.stopped) {
      record.session = {
        ...record.session,
        status: outcome.kind === 'error' ? 'error' : 'ready',
        updatedAt: nowIso,
      };
    }
  }

  /**
   * Idempotent slot release, run when the child is GONE (exit or spawn error)
   * or after termination is confirmed — never merely because the turn
   * settled. It drops the owned-process registry record, clears both
   * per-turn deadlines, and frees the session's single turn slot.
   */
  private finishTurn(record: MuseSessionRecord, turn: MuseActiveTurn): void {
    this.clearTurnTimers(turn);
    // Deliberately does NOT release the owned-process record. Freeing the turn
    // slot is a usability act (the session must not stay blocked by a wedged
    // child); un-registering the child is a safety act, and is only correct
    // once the child is actually gone. `terminateProcessTree` can fail to
    // confirm exit after SIGKILL, and Node emits `error` post-spawn too, so
    // releasing on those paths would hand Station's crash cleanup an orphan it
    // can no longer see. Release happens in the `exit` handler alone — which
    // still fires if the survivor exits later.
    if (record.activeTurn === turn) {
      record.activeTurn = undefined;
    }
    turn.resolveSlotReleased();
  }

  /** Drops the owned-process record. Only ever called once the child exited. */
  private releaseOwnedChild(turn: MuseActiveTurn): void {
    turn.release?.();
    turn.release = undefined;
  }

  /**
   * Arms the per-turn deadlines.
   *
   * - TOTAL is armed only when the server declared a budget
   *   (`turnTimeoutMs`), once, and never rescheduled. With no declaration a
   *   live turn is never ended on a Station-chosen schedule; a wedged child
   *   is visible as silence and stopped by the user.
   * - IDLE is armed only when the server declared an idle bound
   *   (`turnIdleTimeoutMs`); with none (the default, #2269) a silent live
   *   turn is surfaced as silence and stopped by the user. When declared it
   *   is rescheduled by verified protocol activity alone
   *   (`noteVerifiedActivity`) and is not armed while a tool is in flight.
   *   Malformed/unknown/heartbeat/stderr frames and duplicate completion
   *   receipts never touch it.
   *
   * Both settle with a terminal event FIRST — so the reason the user sees is
   * the deadline, not a downstream "exited before reporting a terminal
   * result" — and the child is then terminated and the slot freed, in the
   * same settle→terminate→finish order as before.
   */
  /**
   * Settles a deadline-killed turn, then terminates the child and frees the
   * slot ONLY once termination is confirmed — the same semantics as
   * `interruptTurn`'s `termination-unconfirmed` path. The original code
   * freed the slot in `.finally`, so an unconfirmed kill let a replacement
   * `muse exec` start against the same `--session-id` while the old child
   * could still be alive. On the unconfirmed path only the timers are
   * cleared; the slot stays held until the late `exit` handler releases and
   * frees it exactly once. The `activeTurn` guard keeps a late callback for
   * a superseded turn from touching its replacement's timers or slot.
   */
  private settleTimeoutTurn(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    outcome: MuseTurnSettleOutcome,
  ): void {
    this.settleTurn(record, turn, outcome);
    void this.terminateTurn(turn).then((confirmed) => {
      if (record.activeTurn !== turn) return;
      if (confirmed) {
        this.finishTurn(record, turn);
      } else {
        this.clearTurnTimers(turn);
      }
    });
  }

  /** Clears both per-turn deadlines without freeing the slot. Idempotent. */
  private clearTurnTimers(turn: MuseActiveTurn): void {
    if (turn.totalTimeoutHandle) {
      clearTimeout(turn.totalTimeoutHandle);
      turn.totalTimeoutHandle = undefined;
    }
    if (turn.idleTimeoutHandle) {
      clearTimeout(turn.idleTimeoutHandle);
      turn.idleTimeoutHandle = undefined;
    }
  }

  private armTurnDeadlines(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
  ): void {
    const totalLimitMs = turn.totalLimitMs;
    if (totalLimitMs !== undefined) {
      const totalHandle = setTimeout(() => {
        // #2300: a held turn is closed without `runtime.error` even by a
        // declared budget; the warning records why it ended.
        if (turn.heldRuns > 0) {
          this.publishHeldTurnUnfinished(
            record,
            turn,
            `Muse did not finish within the turn budget of ${formatMuseDuration(totalLimitMs)} declared for it, so Station stopped it before it delivered the result of background work this turn launched.`,
          );
          this.settleTimeoutTurn(record, turn, {
            kind: 'completed',
            finishReason: 'other',
            outputText: turn.outputText,
          });
          return;
        }
        this.settleTimeoutTurn(record, turn, {
          kind: 'error',
          outputText: turn.outputText.length > 0 ? turn.outputText : undefined,
          omitStderr: true,
          error: {
            message: `Muse did not finish the turn within the ${totalLimitMs}ms turn budget declared for it, so Station stopped it.`,
            code: MUSE_TURN_TOTAL_TIMEOUT_CODE,
          },
        });
      }, totalLimitMs);
      // A pending deadline must never be the reason the process stays alive.
      totalHandle.unref?.();
      turn.totalTimeoutHandle = totalHandle;
    }
    this.armIdleDeadline(record, turn);
  }

  /**
   * (Re)arms the declared idle deadline `idleLimitMs` from now; a no-op when
   * none was declared. Called once at turn start and again on every verified
   * protocol activity. Never called for
   * anything else — notably never for approval state (muse has no approval
   * channel) and never by the total path.
   *
   * While a tool is in flight (an open call whose muse task has not reached
   * `completed`/`failed`/`cancelled`) the deadline is cleared and NOT
   * re-armed: a running tool is known work, however long it runs. The task
   * finishing, or its result, is verified activity and re-arms it.
   */
  private armIdleDeadline(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
  ): void {
    if (turn.idleTimeoutHandle) {
      clearTimeout(turn.idleTimeoutHandle);
      turn.idleTimeoutHandle = undefined;
    }
    if (turn.settled) return;
    // #2269: no declared idle bound (the default) means a silent live turn is
    // never ended by Station. It is surfaced as silence instead — the stall
    // watchdog's `progressSilence` keys on the same parent-visible events —
    // and the user decides whether to Stop it.
    if (turn.idleLimitMs === undefined) return;
    if (this.hasToolInFlight(turn)) return;
    // #2300: pending background work is known work too, and owner decision
    // 2 gives a held turn no post-terminal budget: it runs until muse
    // finishes it or the user presses Stop.
    if (turn.pendingBackgroundTasks.size > 0) return;
    if (turn.heldRuns > 0) return;
    this.scheduleIdleTimer(record, turn);
  }

  /** True while any open call's muse task has not yet finished. */
  private hasToolInFlight(turn: MuseActiveTurn): boolean {
    return turn.openToolCalls.size > turn.awaitingResultToolCalls.size;
  }

  /**
   * Starts the per-turn idle timer from now: on a live turn, the declared
   * idle bound (`idleLimitMs`, called from `armIdleDeadline` only when one was
   * declared); on a settled turn, the lingering-child reap
   * (`lingeringChildReapMs`, called from `settleTurn`). A live turn's timer
   * that is still pending when the turn settles keeps running and reaps
   * instead. On a settled turn the callback only reaps the lingering child —
   * announced with a `runtime.warning` when settle closed background rows
   * (#2300).
   */
  private scheduleIdleTimer(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
  ): void {
    const idleLimitMs = turn.settled
      ? turn.lingeringChildReapMs
      : turn.idleLimitMs;
    if (idleLimitMs === undefined) return;
    const handle = setTimeout(() => {
      const lastActivityIso = new Date(turn.lastProgressAt).toISOString();
      if (turn.settled) {
        this.reapSettledChild(record, turn, idleLimitMs, lastActivityIso);
        return;
      }
      this.settleTimeoutTurn(record, turn, {
        kind: 'error',
        outputText: turn.outputText.length > 0 ? turn.outputText : undefined,
        omitStderr: true,
        error: {
          message: `Muse turn was idle for ${idleLimitMs}ms, the idle bound declared for it, with no verified protocol activity and no tool reported running (last activity at ${lastActivityIso}), so Station stopped it.`,
          code: MUSE_TURN_IDLE_TIMEOUT_CODE,
        },
      });
    }, idleLimitMs);
    handle.unref?.();
    turn.idleTimeoutHandle = handle;
  }

  /**
   * #2300: the run reached a completed `run_terminal` while background work
   * is pending, so the turn stays open for muse's follow-up run. Its text
   * becomes a new item, joined to what came before by a paragraph break.
   * Idle stays disarmed (`armIdleDeadline`) while the work is pending.
   */
  private holdTurn(turn: MuseActiveTurn): void {
    // A turn held only because a settled task is still owed its report may
    // have idle armed from run 1's activity; a held turn has no idle bound.
    if (turn.idleTimeoutHandle) {
      clearTimeout(turn.idleTimeoutHandle);
      turn.idleTimeoutHandle = undefined;
    }
    turn.heldRuns += 1;
    turn.itemId = undefined;
    turn.runStreamedText = false;
    turn.runSeparatorPending = turn.outputText.length > 0;
  }

  /**
   * #2300: true while the turn is owed a background report: a task is still
   * pending, or settled without a follow-up run having reported it yet.
   */
  private owesBackgroundReport(turn: MuseActiveTurn): boolean {
    return (
      turn.pendingBackgroundTasks.size > 0 || turn.awaitingReportTasks.size > 0
    );
  }

  /**
   * #2300: records why a held turn ended without muse delivering its
   * background result, before the turn's own `turn.completed`. The turn is
   * never closed with `runtime.error` (see the class docblock), so this
   * warning is the durable record of the terminal, reason, or exit code:
   * persisted in the event log and shown in the session diagnostics log,
   * toasted live, not rendered in the transcript.
   */
  private publishHeldTurnUnfinished(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    message: string,
  ): void {
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.externalThreadId,
      createdAt: this.now().toISOString(),
      method: 'runtime.warning',
      severity: 'warning',
      turnId: turn.turnId,
      code: MUSE_HELD_TURN_UNFINISHED_CODE,
      message,
    });
  }

  /**
   * Reaps a child still running after its turn settled (the #2328 parity
   * reap). Silent when nothing the turn knew of could still be running in
   * it; announced when settle closed background rows as unresolved (#2300),
   * with wording that depends on whether termination was confirmed. Frees
   * the slot only once termination is confirmed, as `settleTimeoutTurn`
   * does.
   */
  private reapSettledChild(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    idleLimitMs: number,
    lastActivityIso: string,
  ): void {
    const announce = turn.backgroundRowsClosedAtSettle > 0;
    void this.terminateTurn(turn).then((confirmed) => {
      if (announce) {
        this.publish({
          eventId: crypto.randomUUID(),
          provider: this.provider,
          threadId: record.externalThreadId,
          createdAt: this.now().toISOString(),
          method: 'runtime.warning',
          severity: 'warning',
          turnId: turn.turnId,
          code: MUSE_LINGERING_CHILD_REAPED_CODE,
          message: confirmed
            ? `Muse was still running ${formatMuseDuration(idleLimitMs)} after its turn ended, with background work from that turn unreported (last activity at ${lastActivityIso}), so Station stopped its process group. Whether that work stopped with it was not separately confirmed.`
            : `Muse was still running ${formatMuseDuration(idleLimitMs)} after its turn ended, with background work from that turn unreported (last activity at ${lastActivityIso}). Station tried to stop its process but could not confirm it stopped, so that work may still be running.`,
        });
      }
      if (record.activeTurn !== turn) return;
      if (confirmed) {
        this.finishTurn(record, turn);
      } else {
        this.clearTurnTimers(turn);
      }
    });
  }

  /**
   * #2300: logs a send refusal with its thread id — kept out of the error
   * text, which a client queue shows to the user verbatim — and returns
   * the error for the caller to throw.
   */
  private refuseSend(threadId: string, error: Error): Error {
    this.options.logger?.warn?.(
      `Muse refused a send for thread ${threadId}: ${error.message}`,
    );
    return error;
  }

  /**
   * #2300 (review M5): waits, bounded by
   * {@link MUSE_SETTLED_CHILD_EXIT_WAIT_MS}, for a settled turn's child to
   * exit and free the slot. Resolves either way; the caller re-checks.
   */
  private async waitForSlotRelease(turn: MuseActiveTurn): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turn.slotReleased,
        new Promise<void>((resolve) => {
          timer = setTimeout(
            resolve,
            this.options.settledChildExitWaitMs ??
              MUSE_SETTLED_CHILD_EXIT_WAIT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * #2300: folds a run's `run_terminal.text` into the turn text of a held
   * turn. That text is the run's FULL text, so it is appended only when the
   * run streamed none — the same rule the single-run path follows.
   */
  private appendRunTerminalText(
    turn: MuseActiveTurn,
    text: string | null,
  ): void {
    if (turn.runStreamedText || !text) return;
    turn.outputText += turn.runSeparatorPending ? `\n\n${text}` : text;
    turn.runSeparatorPending = false;
  }

  /**
   * #2300: opens the row for a background task a `workflow` result
   * announced. Idempotent per task id, including after it settled, so a
   * replayed launch result cannot reopen a finished row.
   */
  private announceBackgroundTask(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    taskId: string,
    toolCallId: string,
    toolName: string,
  ): void {
    const rowId = museBackgroundTaskRowId(taskId);
    if (
      turn.pendingBackgroundTasks.has(taskId) ||
      turn.seenToolCallIds.includes(rowId)
    ) {
      return;
    }
    if (turn.pendingBackgroundTasks.size >= MUSE_PENDING_BACKGROUND_TASKS_MAX) {
      this.options.logger?.warn?.(
        `Muse launched more than ${MUSE_PENDING_BACKGROUND_TASKS_MAX} background tasks in one turn; the rest are not tracked and do not hold the turn open.`,
      );
      return;
    }
    // Not the launching tool's own name: this row is not a second call of
    // it, and per-name tool counts (turn provenance) must not read it so.
    const rowToolName = `${toolName}_background`;
    turn.pendingBackgroundTasks.set(taskId, {
      toolCallId,
      toolName: rowToolName,
      announcedAt: Date.now(),
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.externalThreadId,
      createdAt: this.now().toISOString(),
      method: 'tool.started',
      turnId: turn.turnId,
      itemId: `tool:${rowId}`,
      toolCallId: rowId,
      toolName: rowToolName,
    });
  }

  /**
   * #2300: settles a background task's row from muse's own final phase.
   * Non-final phases are ignored. Verified activity: with nothing else
   * pending, idle re-arms from here for the follow-up run.
   */
  private settleBackgroundTask(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    taskId: string,
    phase: string,
  ): void {
    const status =
      phase === 'completed'
        ? ('success' as const)
        : phase === 'failed'
          ? ('error' as const)
          : phase === 'cancelled'
            ? ('cancelled' as const)
            : undefined;
    if (!status) return;
    const task = turn.pendingBackgroundTasks.get(taskId);
    if (!task) return;
    turn.pendingBackgroundTasks.delete(taskId);
    // Muse reports every settled task in a follow-up run; until one has,
    // the turn is still owed that report (`owesBackgroundReport`).
    turn.awaitingReportTasks.add(taskId);
    if (turn.heldRuns === 0) turn.settledBeforeHold.add(taskId);
    const rowId = museBackgroundTaskRowId(taskId);
    this.rememberSettledRow(turn, rowId);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.externalThreadId,
      createdAt: this.now().toISOString(),
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${rowId}`,
      toolCallId: rowId,
      toolName: task.toolName,
      status,
      output:
        status === 'success'
          ? MUSE_BACKGROUND_TASK_COMPLETED_OUTPUT
          : status === 'error'
            ? MUSE_BACKGROUND_TASK_FAILED_OUTPUT
            : MUSE_BACKGROUND_TASK_CANCELLED_OUTPUT,
    });
    this.noteVerifiedActivity(record, turn);
  }

  /** Records a closed row id so nothing can reopen it (bounded, oldest-first). */
  private rememberSettledRow(turn: MuseActiveTurn, rowId: string): void {
    if (turn.seenToolCallIds.includes(rowId)) return;
    if (turn.seenToolCallIds.length >= MUSE_SEEN_TOOL_CALL_IDS_MAX) {
      turn.seenToolCallIds.shift();
    }
    turn.seenToolCallIds.push(rowId);
  }

  /**
   * Closes a started tool whose muse task reported `cancelled` (see
   * `observeMuseToolTask`). Published as `cancelled` because that is the
   * outcome muse itself reported — not a failure nothing observed, and not
   * `unresolved`, which asserts that no verdict arrived. The call leaves
   * `openToolCalls`, so the idle deadline re-arms once nothing else is in
   * flight; the cancel is itself verified activity. It is also recorded as
   * seen, so a later start for the same `call_id` cannot reopen the row.
   */
  private closeCancelledTool(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
    tool: { toolName: string; toolCallId: string },
  ): void {
    if (!turn.openToolCalls.delete(tool.toolCallId)) return;
    turn.awaitingResultToolCalls.delete(tool.toolCallId);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.externalThreadId,
      createdAt: this.now().toISOString(),
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${tool.toolCallId}`,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      status: 'cancelled',
      output: MUSE_CANCELLED_TOOL_OUTPUT,
    });
    if (!turn.seenToolCallIds.includes(tool.toolCallId)) {
      if (turn.seenToolCallIds.length >= MUSE_SEEN_TOOL_CALL_IDS_MAX) {
        turn.seenToolCallIds.shift();
      }
      turn.seenToolCallIds.push(tool.toolCallId);
    }
    this.noteVerifiedActivity(record, turn);
  }

  /**
   * Records verified protocol activity and reschedules the IDLE deadline
   * only. Callers are `handleStdoutLine`'s text-delta, new-tool-start,
   * tool-task-finished and new-tool-result branches, `closeCancelledTool`,
   * and `settleBackgroundTask` (#2300)
   * — i.e. facts the child actually emitted — never stderr noise, malformed
   * lines, heartbeats, or duplicate receipts.
   */
  private noteVerifiedActivity(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
  ): void {
    if (turn.settled) return;
    if (record.activeTurn !== turn) return;
    turn.lastProgressAt = Date.now();
    this.armIdleDeadline(record, turn);
  }

  private terminateTurn(turn: MuseActiveTurn): Promise<boolean> {
    if (turn.terminationPromise) return turn.terminationPromise;
    const operation = this.terminateProcess(turn.process)
      .then(() => true)
      .catch((error: unknown) => {
        this.options.logger?.warn?.(
          `Muse turn process termination was not confirmed: ${errorMessage(error)}`,
        );
        // #2300: a later send must not be told this slot frees itself.
        turn.terminationUnconfirmed = true;
        return false;
      })
      .finally(() => {
        if (turn.terminationPromise === operation) {
          turn.terminationPromise = undefined;
        }
      });
    turn.terminationPromise = operation;
    return operation;
  }
}
