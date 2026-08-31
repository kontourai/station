import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  engineId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import { FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY } from '@kontourai/station-contracts/provider';
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
import type { Logger } from '../../utils/logger.js';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
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
  buildMuseExecArgs,
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
   * Per-turn deadline in milliseconds. `muse exec` has no timeout of its own,
   * so a wedged child would otherwise hold the turn (and `hasOpenTurn`) open
   * forever. Generous by default — this is a backstop for a hung process, not
   * a latency budget for a long answer.
   */
  turnTimeoutMs?: number;
}

/**
 * Backstop only: a `muse exec` still streaming after this is treated as hung.
 * Long model answers finish well inside it; the value exists so a wedged child
 * cannot hold a turn open for the life of the process.
 */
export const MUSE_DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * Cap on the unterminated stdout tail carried across chunk boundaries. muse
 * writes one JSON object per line and the largest observed line is its
 * `run_terminal` (the full turn text), so a partial line past this cap is a
 * child writing without newlines rather than a legitimate record — it is
 * dropped instead of growing the turn's memory without limit.
 */
export const MUSE_STDOUT_BUFFER_MAX_CHARS = 1_048_576;

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
 * On a DIRECTLY-LAUNCHED server (`npm run dev:server` / `start:server`, which
 * load dotenv before anything else) there is no attestation at all: nothing
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
export interface MuseProviderOverrideRefusal {
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
  | { kind: 'aborted'; abortReason: string }
  | {
      kind: 'error';
      error: { message: string; code: string };
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

export function createMuseProcess(
  args: string[],
  cwd?: string,
): MuseSpawnResult {
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
 */
export class MuseAdapter implements ProviderAdapterShape {
  readonly provider = 'muse' as const;
  readonly metadata = {
    displayName: 'Muse Code',
    description:
      'Muse Code runtime over the local muse CLI, one `muse exec` per turn.',
    // Deliberately conservative. `resume`, `approvals`, and `tool-calls` are
    // NOT claimed: nothing in the observed JSONL stream describes a tool call,
    // muse exposes no approval channel, and Station implements no adoption of
    // a pre-existing muse session.
    capabilities: ['agent-runtime', 'session-lifecycle', 'external-process'],
    continuity: { resume: 'none', fork: 'none', rewind: 'none' },
    runtimeId: engineRuntimeId('muse-runtime'),
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
  private readonly turnTimeoutMs: number;
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
    this.processFactory = options.processFactory ?? createMuseProcess;
    this.now = options.now ?? (() => new Date());
    this.newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
    this.terminateProcess = options.terminateProcess ?? terminateMuseProcess;
    this.env = options.env ?? process.env;
    this.credentialFileExists = options.credentialFileExists ?? existsSync;
    this.findBinary = options.findBinary ?? findCliBinary;
    this.turnTimeoutMs = options.turnTimeoutMs ?? MUSE_DEFAULT_TURN_TIMEOUT_MS;
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
    const museSessionId = this.newSessionId();
    const nowIso = this.now().toISOString();
    // What the session REPORTS is what a turn will actually apply, which under
    // `echo` is no model at all — see `appliedModelId`. `record.modelId` below
    // keeps the request itself.
    const appliedModelId = this.appliedModelId(input.modelId);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      // Ready immediately: there is no handshake to wait on, because there is
      // no process until the first turn.
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
    };
    this.sessions.set(input.threadId, record);

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
      },
    });

    providerOps.add(1, {
      operation: 'adapter-session-start',
      provider: this.provider,
    });
    adapterSessionStartDuration.record(Date.now() - startedAt, {
      provider: this.provider,
    });
    return record.session;
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
      throw new Error(`Muse session is stopped: ${input.threadId}`);
    }
    // The slot is held until the child EXITS, not until the turn settles: two
    // `muse exec` processes must never run concurrently against one
    // `--session-id`.
    if (record.activeTurn) {
      throw new Error(
        `Muse session already has an active turn: ${input.threadId}`,
      );
    }
    this.reportProviderNoticeOnce();
    const turnId = crypto.randomUUID();
    const modelId = input.modelId ?? record.modelId;
    const args = buildMuseExecArgs({
      sessionId: record.museSessionId,
      prompt: input.input,
      modelId,
      cwd: record.cwd,
      // Omitted entirely when unset, which is the default: the argv is then
      // byte-identical to the one Station has always built.
      ...(this.providerOverride ? { provider: this.providerOverride } : {}),
    });

    const spawned = this.processFactory(args, record.cwd);
    const turn: MuseActiveTurn = {
      turnId,
      process: spawned.process,
      release: spawned.release,
      startedAt: Date.now(),
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
    this.armTurnDeadline(record, turn);

    // Independent review MEDIUM-1: carries the server-owned
    // `firstTurnInstructionsComposed` marker (reserved metadata, stripped
    // from any caller-supplied value) onto THIS turn's own persisted
    // record — see the constant's doc comment in provider.ts — so the
    // delegate-seam disclosure can derive 'delivered' from this turn
    // having actually composed it, not merely from having started.
    const turnStartedMetadata: Record<string, unknown> = {
      ...(input.recoveryCorrelationId
        ? { recoveryCorrelationId: input.recoveryCorrelationId }
        : {}),
      ...(input.metadata?.[FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]
        ? { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true }
        : {}),
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

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.requireSession(threadId);
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
   * Muse exposes no approval or elicitation channel, so no `request.opened`
   * event is ever published for this provider and there is nothing to resolve
   * against the engine. Publish-only, mirroring the Ollama adapter: a caller
   * that resolves an unknown request still gets a matching `request.resolved`
   * rather than a thrown error.
   */
  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
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
      turn.outputText += effect.delta;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'content.text-delta',
        turnId: turn.turnId,
        itemId: turn.itemId,
        delta: effect.delta,
      });
      return;
    }

    if (effect.kind === 'tool-completed') {
      // Only `tool.completed` — the live stream emits `call_id` exactly once,
      // on the result, so there is no honest id to open a `tool.started` with
      // (see muse-adapter-events.ts). Its own itemId keeps the tool row
      // distinct from the assistant text item.
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.externalThreadId,
        createdAt: this.now().toISOString(),
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${effect.toolCallId}`,
        toolCallId: effect.toolCallId,
        toolName: effect.toolName,
        status: effect.status,
        ...(effect.output === null ? {} : { output: effect.output }),
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
          message: `${outcome.error.message}${this.outputTextDetail(outcome.outputText)}${this.stderrDetail(turn)}`,
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
   * settled. It drops the owned-process registry record, clears the per-turn
   * deadline, and frees the session's single turn slot.
   */
  private finishTurn(record: MuseSessionRecord, turn: MuseActiveTurn): void {
    if (turn.timeoutHandle) {
      clearTimeout(turn.timeoutHandle);
      turn.timeoutHandle = undefined;
    }
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
  }

  /** Drops the owned-process record. Only ever called once the child exited. */
  private releaseOwnedChild(turn: MuseActiveTurn): void {
    turn.release?.();
    turn.release = undefined;
  }

  /**
   * Arms the per-turn deadline. `muse exec` has no timeout of its own, so a
   * child that hangs (or one that emits `run_terminal` and then never exits)
   * is the last remaining way a turn can stay open forever. The turn is
   * settled with a terminal event FIRST — so the reason the user sees is the
   * timeout, not a downstream "exited before reporting a terminal result" —
   * and the child is then terminated and the slot freed.
   */
  private armTurnDeadline(
    record: MuseSessionRecord,
    turn: MuseActiveTurn,
  ): void {
    if (!Number.isFinite(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) return;
    const handle = setTimeout(() => {
      this.settleTurn(record, turn, {
        kind: 'error',
        outputText: turn.outputText.length > 0 ? turn.outputText : undefined,
        error: {
          message: `Muse did not finish the turn within ${this.turnTimeoutMs}ms and was terminated.`,
          code: 'muse-turn-timeout',
        },
      });
      void this.terminateTurn(turn).finally(() => {
        this.finishTurn(record, turn);
      });
    }, this.turnTimeoutMs);
    // A pending backstop must never be the reason the process stays alive.
    handle.unref?.();
    turn.timeoutHandle = handle;
  }

  private terminateTurn(turn: MuseActiveTurn): Promise<boolean> {
    if (turn.terminationPromise) return turn.terminationPromise;
    const operation = this.terminateProcess(turn.process)
      .then(() => true)
      .catch((error: unknown) => {
        this.options.logger?.warn?.(
          `Muse turn process termination was not confirmed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
