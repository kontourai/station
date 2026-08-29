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
  /** True once a terminal event (`run_terminal` or child exit) closed the turn. */
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
   * Per-turn deadline. Cleared only when the slot is freed, so a child that
   * emits `run_terminal` and then wedges is still killed and reaped.
   */
  timeoutHandle?: ReturnType<typeof setTimeout>;
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
