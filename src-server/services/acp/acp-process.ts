/**
 * ACPProcess — thin wrapper around a single kiro-cli ACP child process.
 * Handles: spawn, JSON-RPC transport, protocol init, session lifecycle, destroy.
 * Used by ACPConnection for both discovery and per-conversation chat processes.
 */

import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  type AgentCapabilities,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type DisableProviderResponse,
  type ListProvidersResponse,
  type McpServer,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type ProviderInfo,
  type SetProviderRequest,
  type SetProviderResponse,
} from '@agentclientprotocol/sdk';
import type { ExactProcessIdentityProbe } from '@kontourai/station-shared/process-identity';
import {
  lookupProcessBirthFingerprintAsync,
  probeExactProcessIdentityAsync,
} from '@kontourai/station-shared/process-identity';
import {
  augmentedSpawnEnv,
  findCliBinaryAsync,
} from '../../providers/auth/cli-auth.js';
import { forceKillProcess, spawnOwnedChild } from '../infra/process-utils.js';

/**
 * archive#3441 MEDIUM-2: the identity probe `survivesCleanup()` and
 * `forceGroupKill()`'s confirm-before-release wait use. Async, not the
 * `ProcessIdentityProbe` sync shape `process-utils.ts` exports for the
 * startup sweep — that path runs once at boot; this one runs on the server's
 * event loop once per probe cycle per retained process, so it uses
 * `probeExactProcessIdentityAsync` (same three-state result, non-blocking
 * birth-fingerprint lookup) rather than the sweep's synchronous twin.
 */
export type AsyncProcessIdentityProbe = (
  pid: number,
) => Promise<ExactProcessIdentityProbe>;

export interface ACPProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Factory for the Client callbacks — called during connection setup */
  createClient: (agent: any) => Client;
  /**
   * Capabilities Station truthfully offers to this ACP peer. Interactive
   * sessions use the managed filesystem and terminal bridge by default;
   * availability probes override this with an empty object because they own
   * neither surface.
   */
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  logger: any;
  terminateProcess?: (proc: ChildProcess) => Promise<void>;
  resolveCommand?: (command: string) => Promise<string | null>;
  /**
   * archive#3441 test seam: override the identity probe `survivesCleanup()`
   * and `forceGroupKill()`'s confirm wait use to decide whether the pid it
   * holds is still the process it spawned. Defaults to the real
   * {@link probeExactProcessIdentityAsync} -- the same three-state result
   * `process-utils.ts`'s `ownerIsGone`/orphan sweep compares against (its own
   * sync twin), so a mismatch, an EPERM-shaped foreign process, and an
   * unreadable fingerprint are decidable without signalling a real foreign
   * pid in a test.
   */
  probeIdentity?: AsyncProcessIdentityProbe;
}

/**
 * archive#3441 HIGH-1: how long `forceGroupKill()` polls for its SIGKILL to
 * actually take effect before giving up on releasing the owned-process
 * registry record. Matches `terminateProcessTree`'s own `killConfirmMs`
 * default (process-utils.ts) so this escalation's confirm window is not
 * shorter than the ordinary destroy path's it is standing in for.
 */
const FORCE_GROUP_KILL_CONFIRM_MS = 1_000;

/**
 * archive#3441 MEDIUM-3: a cheap, uninstrumented liveness read -- the SAME
 * `kill(pid, 0)` primitive {@link probeExactProcessIdentityAsync} runs
 * INTERNALLY before it ever shells out to `ps` for a birth fingerprint (its
 * `aliveState`, not exported). EPERM is treated as "alive" throughout this
 * codebase (a foreign, unsignalable process still answers signal 0), so this
 * mirrors that convention exactly. Used only as a pre-check gating a slower,
 * test-injectable identity confirmation -- see `waitUntilProcessGone()`.
 */
function quickLivenessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'EPERM';
  }
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version?: string };
  // archive#895 wave B: the SDK's full AgentCapabilities shape (loadSession,
  // promptCapabilities, mcpCapabilities, sessionCapabilities, …) — was a
  // locally-typed subset (loadSession/promptCapabilities only); switched to
  // the SDK type so probe evidence (acp-probe.ts) can cache the whole
  // handshake without a parallel type to keep in sync.
  agentCapabilities?: AgentCapabilities;
  /** Present only when initialize advertised `providers` and list succeeded. */
  providerRouting?: ProviderInfo[];
}

export class ACPProviderRoutingUnsupportedError extends Error {
  constructor() {
    super('This ACP agent did not advertise provider routing support.');
    this.name = 'ACPProviderRoutingUnsupportedError';
  }
}

export class ACPRequiredProviderDisableError extends Error {
  constructor(providerId: string) {
    super(`ACP provider '${providerId}' is required and cannot be disabled.`);
    this.name = 'ACPRequiredProviderDisableError';
  }
}

export class ACPProviderRouteValidationError extends Error {
  constructor(
    readonly code:
      | 'observation_required'
      | 'provider_not_found'
      | 'protocol_unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'ACPProviderRouteValidationError';
  }
}

/** Validate writes against the exact provider catalogue the agent advertised. */
export function assertACPProviderRouteSupported(
  providers: ProviderInfo[] | null | undefined,
  providerId: string,
  apiType: string,
): void {
  if (!providers)
    throw new ACPProviderRouteValidationError(
      'observation_required',
      'Provider routing must be observed before it can be changed.',
    );
  const provider = providers.find((entry) => entry.providerId === providerId);
  if (!provider)
    throw new ACPProviderRouteValidationError(
      'provider_not_found',
      `ACP provider '${providerId}' was not advertised by this agent.`,
    );
  if (!provider.supported.includes(apiType))
    throw new ACPProviderRouteValidationError(
      'protocol_unsupported',
      `ACP provider '${providerId}' did not advertise protocol '${apiType}'.`,
    );
}

/** Capability-gated unstable provider discovery; absence is an ordinary no-op. */
export async function observeACPProviderRouting(
  connection: Pick<ClientSideConnection, 'unstable_listProviders'>,
  initResult: InitializeResult,
): Promise<ProviderInfo[] | undefined> {
  if (initResult.agentCapabilities?.providers == null) return undefined;
  const response = (await connection.unstable_listProviders(
    {},
  )) as ListProvidersResponse;
  return response.providers;
}

/**
 * archive#1089: a `spawn()` failure — the overwhelmingly common cause being a
 * working directory that does not exist — arrives as an asynchronous `'error'`
 * event on the ChildProcess. Nothing listened for it, so it became an
 * `uncaughtException` and took the WHOLE SERVER DOWN. Measured on `origin/main`
 * (1e5b45d2): adding an engine connection whose Working Directory was `~/`
 * killed the process with
 * `Uncaught exception: Error: spawn /Users/…/stub-acp ENOENT` →
 * `Shutting down gracefully (uncaughtException)`. That is reachable from the
 * connection form (free-text field, no existence check) on BOTH the probe path
 * (acp-probe.ts) and the chat path (providers/adapters/acp-adapter.ts).
 *
 * Node's own message names the COMMAND and never the cwd, which is exactly the
 * misdirection archive#1087 called out: the binary is present and executable, and the
 * directory is the thing that is missing. Name the directory.
 *
 * This is the ACP half of archive#791's fail-closed rule for the other engines
 * (`orchestration-service.ts`'s `existsSync(cwd)` throw): refuse loudly, naming
 * the path, instead of landing the agent somewhere the user did not ask for —
 * or, here, instead of killing the server.
 */
function describeSpawnFailure(
  error: unknown,
  command: string,
  cwd: string | undefined,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT' && cwd && !existsSync(cwd)) {
    return new Error(
      `Cannot start '${command}': its working directory does not exist: ${cwd}`,
    );
  }
  return cwd
    ? new Error(
        `Cannot start '${command}' in working directory ${cwd}: ${detail}`,
      )
    : new Error(`Cannot start '${command}': ${detail}`);
}

interface SessionResult {
  sessionId: string;
  modes?: {
    availableModes: Array<{ id: string; name: string; description?: string }>;
    currentModeId?: string;
  };
  configOptions?: any[];
}

export class ACPProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  /** The pid this object spawned. Never cleared -- see survivesCleanup(). */
  private spawnedPid: number | null = null;
  /**
   * The birth fingerprint of `spawnedPid`, recorded in the same breath as the
   * pid itself and never cleared. See survivesCleanup() (archive#3441): this
   * is what lets a recycled pid be told apart from the process actually
   * spawned here, instead of a bare `kill(pid, 0)` treating anything alive
   * (or unsignalable) at that pid as "surviving".
   */
  private spawnedBirth: string | null = null;
  private readonly probeIdentity: AsyncProcessIdentityProbe;
  private releaseOwnedChild: (() => void) | null = null;
  private connection: ClientSideConnection | null = null;
  private _sessionId: string | null = null;
  private _initResult: InitializeResult | null = null;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;

  get sessionId(): string | null {
    return this._sessionId;
  }
  get initResult(): InitializeResult | null {
    return this._initResult;
  }
  get isAlive(): boolean {
    return (
      this.proc !== null &&
      (this.proc.exitCode ?? null) === null &&
      (this.proc.signalCode ?? null) === null &&
      !this.destroyed
    );
  }

  /**
   * Whether the OS process this object spawned is STILL THERE, asked of the
   * kernel rather than of this object's own state.
   *
   * `isAlive` cannot answer it after a destroy: it goes false as soon as
   * `destroyed` is set, whether or not the child actually died. Neither can
   * `this.proc`, which destroy() nulls on the same path -- reading the pid
   * from there would inherit the identical blindness and answer `false`
   * without ever asking. It reads `spawnedPid`, recorded at spawn and never
   * cleared, so the probe below reaches the real process.
   *
   * archive#3441: a bare `kill(pid, 0)` answers "is SOME process alive at
   * this pid", not "is it the process I spawned" -- and `EPERM ⇒ surviving`
   * meant a pid recycled by an unrelated (unsignalable) process was retained
   * forever, re-destroyed every cycle, on identity Station never actually
   * checked. `probeIdentity` (the shared three-state {@link
   * probeExactProcessIdentityAsync} -- the same three-state result
   * `process-utils.ts`'s `ownerIsGone`/orphan sweep compares against via its
   * own sync twin, not a second identity notion) compares the pid's CURRENT
   * birth fingerprint against `spawnedBirth`, recorded once at spawn:
   *   - `dead` ⇒ not surviving.
   *   - `exact` with a fingerprint match ⇒ surviving -- the same process.
   *   - `exact` with a mismatch ⇒ NOT surviving -- pid reuse, including the
   *     EPERM-forever case (a foreign, unsignalable process usually still
   *     has a readable birth time, so this is exactly what catches it).
   *   - `unavailable` (alive, fingerprint unreadable), or no `spawnedBirth`
   *     to compare against ⇒ surviving. Identity cannot be ruled out, so
   *     this retains rather than guesses -- the same "a missed reclaim is
   *     acceptable; a wrong reap is not" rule `ownerIsGone` follows, and it
   *     is no longer unbounded: `ACPProbe`'s retry cap (archive#3441) is
   *     what stops this case from being retained forever.
   *
   * POSIX semantics throughout (the alive check, and `lookupProcessBirth
   * Fingerprint`'s `ps`/procfs read). On Windows a `true` here is unproven,
   * not evidence: `kill(pid, 0)` does not carry the same meaning, and the
   * destroy path itself (`sendTreeSignal`) can report success for a SIGKILL
   * without verifying the process actually exited, so a destroy can resolve
   * without reaping. The retention path is therefore untested on Windows,
   * the same disclosed limit `forceGroupKill` carries -- this is disclosure,
   * not an implementation Station cannot verify.
   *
   * archive#3441 MEDIUM-2: async, not a bare boolean return. `probeIdentity`
   * defaults to `probeExactProcessIdentityAsync`, whose birth-fingerprint half
   * runs through the callback-`execFile` probe instead of `execFileSync`, so
   * this no longer blocks the server's event loop for the ~5-20ms a `ps`
   * shellout measures at (the sync twin remains process-utils.ts's own
   * default, for its startup-only sweep).
   */
  async survivesCleanup(): Promise<boolean> {
    const pid = this.spawnedPid;
    if (!pid) return false;
    let probe: ExactProcessIdentityProbe;
    try {
      probe = await this.probeIdentity(pid);
    } catch {
      // archive#3441 LOW-3: an identity probe that cannot answer must never
      // be read as "gone" -- the same fail-safe the 'unavailable' state
      // below already encodes for a probe that answered but could not read a
      // fingerprint. Without this, a rejecting `probeIdentity` (never the
      // default, but a legitimate test/future seam) would propagate through
      // `attemptCleanup` and `retryPendingCleanup` and falsify
      // `retryPendingCleanup`'s own docblock claim that cleanup "does not
      // throw" -- `dispose()`'s second, unguarded
      // `await this.retryPendingCleanup()` call would then throw out of
      // dispose() itself.
      return true;
    }
    if (probe.state === 'dead') return false;
    if (probe.state === 'unavailable') return true;
    if (!this.spawnedBirth) return true;
    return probe.identity.start === this.spawnedBirth;
  }

  constructor(private opts: ACPProcessOptions) {
    super();
    this.probeIdentity = opts.probeIdentity ?? probeExactProcessIdentityAsync;
  }

  /** Spawn the child process, set up transport, initialize ACP protocol. */
  async start(): Promise<InitializeResult> {
    if (this.destroyed) throw new Error('ACPProcess already destroyed');
    if (this.proc) throw new Error('ACPProcess already started');

    const bin = await this.findCommand();
    if (this.destroyed) throw new Error('ACPProcess already destroyed');
    if (!bin) throw new Error(`${this.opts.command} not found on PATH`);

    // archive#977: layer the login-shell-resolved PATH onto the spawned
    // process's own env too, not just Station's own binary lookup above --
    // otherwise a service-launched Station can resolve the binary but the
    // engine subprocess itself still cannot find nix/mise/homebrew-managed
    // tools it shells out to internally.
    const env = await augmentedSpawnEnv();
    // archive#1863: spawn through the owned-process primitive so the child is
    // tagged with this Station's identity and recorded in the host-wide
    // registry. `detached: true` is preserved deliberately — a group kill reaps
    // the grandchild (`kiro-cli` re-execs `kiro-cli-chat`) through it — but the
    // registration is what lets a later startup sweep reclaim this engine when
    // THIS Station dies without ever running its own cleanup (SIGKILL, crash,
    // ENOSPC). The graceful destroy path below calls `release()` to drop the
    // record; the sweep is the fallback for the case where destroy never runs.
    const { proc, release } = spawnOwnedChild(bin, this.opts.args || [], {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc = proc;
    // Kept independently of `proc`, which destroy() nulls: this is the only
    // thing left to ask the kernel about afterwards (archive#3422).
    this.spawnedPid = proc.pid ?? null;
    this.releaseOwnedChild = release;

    proc.on('exit', (code) => this.handleProcessExit(proc, code));

    // archive#1089: see describeSpawnFailure. Two listeners, both required:
    //  - `spawnFailed` converts the async `'error'` event into a rejection the
    //    `initialize()` race below can surface to the caller, so a bad working
    //    directory fails THIS connection instead of the process.
    //  - the second `on('error')` keeps a listener attached for the rest of the
    //    child's life, so a late error (post-initialize) still cannot become an
    //    uncaughtException.
    // The `.catch()` on `spawnFailed` is what stops the losing side of the race
    // from becoming an unhandled rejection.
    const spawnFailed = new Promise<never>((_, reject) => {
      proc.once('error', (error) => {
        reject(describeSpawnFailure(error, this.opts.command, this.opts.cwd));
      });
    });
    spawnFailed.catch(() => undefined);
    proc.on('error', (error) => {
      this.opts.logger?.warn?.(
        { err: error, command: this.opts.command, cwd: this.opts.cwd },
        'ACP child process error',
      );
    });
    // A failed spawn leaves stdio pipes that reject on first write (EPIPE).
    // Those emit on the STREAM, not the child, so they need their own
    // listeners or they are a second route to an uncaughtException.
    proc.stdin?.on('error', () => undefined);
    proc.stdout?.on('error', () => undefined);

    // archive#3441: resolved from the SAME pid recorded above -- `spawnedPid`
    // is never reassigned after this point (see its own comment), so a
    // concurrent caller observing `spawnedBirth` still null just sees the
    // safe fallback (survivesCleanup()'s "no birth to compare against ->
    // retain"), never a wrong pid's birth. archive#3441 MEDIUM-2: the async
    // twin, not `execFileSync`'s `ps` shellout blocking the caller's event
    // loop for it -- `start()` is already awaited by every caller.
    //
    // archive#3441 LOW-4: deliberately AFTER every safety listener above, not
    // before. This is an `await`, and every listener above it used to sit on
    // the far side of that await -- a child that spawned with a pid (so
    // `spawnedPid` is set) and then exited or errored during this lookup's
    // ~6ms window would have missed `handleProcessExit` entirely, or become
    // an `uncaughtException` for a window archive#1089 exists to close.
    this.spawnedBirth = this.spawnedPid
      ? await lookupProcessBirthFingerprintAsync(this.spawnedPid)
      : null;

    const input = Writable.toWeb(this.proc.stdin!);
    const output = Readable.toWeb(
      this.proc.stdout!,
    ) as ReadableStream<Uint8Array>;
    const acpStream = ndJsonStream(input, output);

    this.connection = new ClientSideConnection(
      (agent) => this.opts.createClient(agent),
      acpStream,
    );

    this._initResult = (await Promise.race([
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: this.opts.clientCapabilities ?? {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'station', version: '1.0.0' },
      }),
      spawnFailed,
    ])) as InitializeResult;

    // UNSTABLE ACP capability: omitted and null both mean unsupported, while
    // an advertised empty object means supported. Never probe the method on
    // an agent that did not explicitly advertise it.
    const providerRouting = await observeACPProviderRouting(
      this.connection,
      this._initResult,
    );
    if (providerRouting !== undefined)
      this._initResult.providerRouting = providerRouting;

    return this._initResult;
  }

  /** Replace one agent-owned provider route. Capability-gated at the seam. */
  async setProvider(params: SetProviderRequest): Promise<SetProviderResponse> {
    if (!this.connection || !this._initResult)
      throw new Error('ACPProcess not started');
    if (this._initResult.agentCapabilities?.providers == null)
      throw new ACPProviderRoutingUnsupportedError();
    assertACPProviderRouteSupported(
      this._initResult.providerRouting,
      params.providerId,
      params.apiType,
    );
    return this.connection.unstable_setProvider(params);
  }

  /** Disable one optional agent-owned provider route. */
  async disableProvider(providerId: string): Promise<DisableProviderResponse> {
    if (!this.connection || !this._initResult)
      throw new Error('ACPProcess not started');
    if (this._initResult.agentCapabilities?.providers == null)
      throw new ACPProviderRoutingUnsupportedError();
    if (
      this._initResult.providerRouting?.some(
        (provider) => provider.providerId === providerId && provider.required,
      )
    )
      throw new ACPRequiredProviderDisableError(providerId);
    return this.connection.unstable_disableProvider({ providerId });
  }

  /** Create a new ACP session. */
  async newSession(
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<SessionResult> {
    if (!this.connection) throw new Error('ACPProcess not started');
    const result = (await this.connection.newSession({
      cwd,
      mcpServers,
    })) as SessionResult;
    this._sessionId = result.sessionId;
    return result;
  }

  /** Load an existing session by ID. */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[] = [],
  ): Promise<void> {
    if (!this.connection) throw new Error('ACPProcess not started');
    await this.connection.loadSession({ sessionId, cwd, mcpServers });
    this._sessionId = sessionId;
  }

  /** Set the active mode for the current session. */
  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this._sessionId)
      throw new Error('No active session');
    await this.connection.setSessionMode({
      sessionId: this._sessionId,
      modeId,
    });
  }

  /** Set a config option (e.g., model) for the current session. */
  async setConfigOption(configId: string, value: string): Promise<any> {
    if (!this.connection || !this._sessionId)
      throw new Error('No active session');
    return this.connection.setSessionConfigOption({
      sessionId: this._sessionId,
      configId,
      value,
    });
  }

  /** Send a prompt to the current session. */
  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (!this.connection || !this._sessionId)
      throw new Error('No active session');
    return (await this.connection.prompt({
      sessionId: this._sessionId,
      prompt: content,
    })) as PromptResponse;
  }

  /** Cancel the current prompt. */
  async cancel(): Promise<void> {
    if (!this.connection || !this._sessionId) return;
    await this.connection.cancel({ sessionId: this._sessionId });
  }

  /** Call an extension method on the connection. */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    if (!this.connection) throw new Error('ACPProcess not started');
    return (this.connection as any).extMethod(method, params);
  }

  /** Send an extension notification on the connection (fire-and-forget). */
  async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) throw new Error('ACPProcess not started');
    return (this.connection as any).extNotification(method, params);
  }

  /** Destroy the process: SIGTERM → 1s → SIGKILL. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.destroyPromise) return this.destroyPromise;

    const proc = this.proc;
    const operation = (async () => {
      if (proc) {
        await (this.opts.terminateProcess ?? forceKillProcess)(proc);
      }
      this.destroyed = true;
      if (this.proc === proc) this.proc = null;
      this.connection = null;
      this._sessionId = null;
      // A successful graceful destroy removes the registry record so a later
      // startup sweep does not need to consider this child. Best-effort: a
      // sweep would also find the child already dead and drop the record.
      this.releaseOwnedChild?.();
      this.releaseOwnedChild = null;
    })();
    this.destroyPromise = operation;
    try {
      await operation;
    } finally {
      if (this.destroyPromise === operation) this.destroyPromise = null;
    }
  }

  /**
   * archive#1863: unconditional escalation. Deliver a group SIGKILL to the
   * child's process group regardless of destroy()'s state, used when a probe
   * deadline fires BEFORE the graceful SIGTERM → 1s → SIGKILL escalation can
   * complete. The negative pid signals the whole group, reaping a re-execed
   * grandchild too. When this object never spawned a child it declines to act
   * and says so, rather than reporting a no-op that reads like a successful
   * reap.
   *
   * archive#3463: the pid comes from `spawnedPid`, NOT from `this.proc`, for
   * the same reason {@link survivesCleanup} reads it — `destroy()` nulls
   * `this.proc` on its own success path (see below), so reading the pid from
   * there made this escalation decline for exactly the population it exists
   * for: a child that outlived its destroy. `spawnedPid` is recorded at spawn
   * and never cleared, and `spawnOwnedChild` spawns detached, so the child is
   * its own group leader and `-spawnedPid` remains a valid group id after
   * destroy has forgotten the handle. A group that has genuinely exited
   * answers ESRCH, which the catch below already reads as "already gone".
   *
   * archive#3441 HIGH-1: the registry record is released ONLY once the group
   * is CONFIRMED gone, never on signal delivery alone. `process.kill()`
   * returning without throwing means the OS accepted the SIGKILL, not that
   * the group has exited -- the previous version released unconditionally
   * here, so `acp-probe.ts`'s claim that "the sweep remains the backstop" was
   * false the moment this ran: a survivor whose destroy() rejected reached
   * this method, got its record deleted regardless of whether the SIGKILL
   * actually took effect, and a live, still-running engine was left with no
   * record for the sweep to ever find. Confirmation reuses `probeIdentity` --
   * the same identity probe `survivesCleanup()` reads -- as the final,
   * authoritative answer:
   *   - `ESRCH` on the signal itself derives "already gone" synchronously --
   *     the group was not there to signal, so no wait is needed.
   *   - the signal delivers without error: NOT yet confirmed. Poll
   *     `probeIdentity` for up to {@link FORCE_GROUP_KILL_CONFIRM_MS} for the
   *     pid to read `dead`.
   *   - any other signal error (EPERM on a pid since recycled by another
   *     user, or whatever a platform raises for a group signal it cannot
   *     deliver): the escalation did NOT happen -- never release.
   *   - the poll times out without observing `dead`: never release. The
   *     record stays in place for the next probe cycle's retry (bounded by
   *     `MAX_CLEANUP_RETRY_ATTEMPTS`) and, if every retry is exhausted, for
   *     the host-wide sweep once this Station's own owner record is gone --
   *     which is now an accurate description of what happens, not a claim
   *     nothing computes.
   *
   * archive#3441 MEDIUM-3: `waitUntilProcessGone` only ever reads
   * `probe.state === 'dead'`, never the birth-fingerprint identity `probe`
   * also carries -- so a bare `kill(pid, 0)` liveness read agrees with
   * `probeIdentity` on every real answer this call site uses (both derive
   * `'dead'` from the SAME kernel liveness check; the fingerprint only
   * distinguishes `'exact'` from `'unavailable'`, and both are "not dead"
   * here -- so the earlier claim that this confirmation is what tells a
   * foreign process apart from the one signalled was not derived: nothing
   * here ever reads the fingerprint). The poll therefore gates the (possibly
   * test-injected, and on the default path `ps`-shelling-out) `probeIdentity`
   * call behind a cheap liveness pre-check: while the pid is plainly still
   * alive, `probeIdentity` is never called at all, so a ~6ms `ps` spawn per
   * 10ms poll tick -- measured at up to 89 ticks per unconfirmed escalation
   * -- is no longer paid on every tick the process hasn't died yet.
   * `probeIdentity` still runs, and still has the final word, the moment the
   * cheap check first suggests death -- a test that rigs `probeIdentity` to
   * never report `'dead'` therefore still prevents confirmation forever, it
   * just no longer pays for a fingerprint lookup to prove it.
   *
   * POSIX-only (archive#1863 M1 disclosure): the negative-pid group signal is
   * a POSIX mechanism. On Windows `process.kill(-pid, …)` does not target a
   * process group, so this escalation is silently inert there — a Windows
   * engine whose graceful destroy hung will NOT be reaped by this path. The
   * sweep in `process-utils.ts` has the same POSIX limit. Routing the
   * escalation through `terminateProcessTree`'s `taskkill /t` branch would
   * close the Windows gap but changes what confirmation means there too
   * (`sendTreeSignal`'s taskkill branch reports success on the helper's exit
   * code, not on independently observed process death); filed as a follow-up
   * rather than silently half-fixed.
   */
  async forceGroupKill(): Promise<void> {
    const pid = this.spawnedPid;
    if (!pid) {
      // Not "nothing to do": this is the escalation of last resort, and it is
      // declining to act. A child spawned moments ago whose pid this object
      // has not recorded is exactly the one nobody will reap afterwards, so
      // say so rather than returning as if the group were already gone.
      this.opts.logger?.warn?.(
        '[ACPProcess] group kill skipped: no pid recorded for this child',
        { command: this.opts.command },
      );
      return;
    }
    let confirmedGone = false;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      // ESRCH is the one code that DERIVES "already gone" -- the group is not
      // there to signal. Anything else (EPERM on a pid since recycled by
      // another user, and whatever a platform raises for a group signal it
      // cannot deliver) means the escalation did NOT happen, and swallowing it
      // is how an engine survives its own reaping unnoticed (archive#3422:
      // orphans accumulate under a live owner, which never sweeps its own).
      //
      // spawnOwnedChild spawns detached, so the child is always its own group
      // leader and -pid is always a real pgid; ESRCH here therefore means the
      // group exited, not that it never existed.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') {
        confirmedGone = true;
      } else {
        this.opts.logger?.warn?.(
          '[ACPProcess] group kill failed; the engine may still be running',
          { pid, code: code ?? 'unknown', command: this.opts.command },
        );
        // Not confirmed, and nothing was actually delivered -- no reason to
        // poll for a death this call did not cause. Leave the record alone.
        return;
      }
    }
    if (!confirmedGone) {
      confirmedGone = await this.waitUntilProcessGone(
        pid,
        FORCE_GROUP_KILL_CONFIRM_MS,
      );
    }
    if (!confirmedGone) return;
    this.releaseOwnedChild?.();
    this.releaseOwnedChild = null;
  }

  /**
   * archive#3441 LOW-1: release the owned-process registry record without
   * attempting any further destroy/kill of it. The caller must have ALREADY
   * independently confirmed the process is gone -- this does not itself
   * check anything, it only performs the same idempotent release `destroy()`
   * and `forceGroupKill()` do on their own success.
   *
   * Exists for `ACPProbe.attemptCleanup`'s 'reaped' branches (acp-probe.ts):
   * a survivor whose own `forceGroupKill()` timed out without confirming
   * (correctly leaving the record in place, per HIGH-1) can still be found
   * dead by a LATER cycle's `survivesCleanup()` check -- the earlier SIGKILL
   * caught up after the confirm window closed. Before this method existed,
   * that discovery had nowhere to route a release: `attemptCleanup` could
   * only drop its own bookkeeping entry, leaving the registry record behind
   * for the process's entire remaining lifetime as a dead pid, reclaimed
   * only by this Station's own eventual restart sweep. `survivesCleanup()`
   * returning false is exactly the same class of confirmation
   * `forceGroupKill()` requires before it releases, just observed on a
   * different cycle.
   */
  releaseIfConfirmedGone(): void {
    this.releaseOwnedChild?.();
    this.releaseOwnedChild = null;
  }

  /**
   * Poll for `pid` to be gone, or `timeoutMs` to elapse. archive#3441 HIGH-1:
   * the only thing that may follow a `true` here is releasing the
   * owned-process registry record -- see `forceGroupKill()`.
   *
   * archive#3441 MEDIUM-3: gates the (test-injectable, `ps`-shelling-out by
   * default) `probeIdentity` confirmation behind a cheap `kill(pid, 0)`
   * liveness pre-check -- see `forceGroupKill()`'s own docblock for why that
   * pre-check answers identically to `probeIdentity`'s `'dead'` state on
   * every real invocation, and why an injected `probeIdentity` still governs
   * the actual verdict once the pre-check fires.
   */
  private async waitUntilProcessGone(
    pid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (quickLivenessGone(pid) && (await this.confirmProcessDead(pid))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    return this.confirmProcessDead(pid);
  }

  /**
   * archive#3441 LOW-3: `probeIdentity` is not guaranteed non-throwing --
   * the default {@link probeExactProcessIdentityAsync} never rejects, but a
   * test or future caller's injected probe can. A rejection here must never
   * be read as confirmation of death (the same fail-safe `survivesCleanup()`
   * applies to its own `probeIdentity` call), or `destroyProcessWithEscalation`
   * (acp-probe.ts) would stop being the non-throwing method its own docblock
   * claims.
   */
  private async confirmProcessDead(pid: number): Promise<boolean> {
    try {
      return (await this.probeIdentity(pid)).state === 'dead';
    } catch {
      return false;
    }
  }

  private handleProcessExit(proc: ChildProcess, code: number | null): void {
    if (this.proc !== proc) return;
    this.opts.logger.debug('[ACPProcess] exited', { code });
    this.connection = null;
    this._sessionId = null;
    this.emit('exit', code);
  }

  // archive#977: resolve through the shared PATH-scanning helper (which
  // searches process.env.PATH first, then the users login-shell PATH and
  // well-known install dirs) instead of shelling out to which/where -- a
  // service-launched Station's minimal PATH previously made this report a
  // false negative for an engine the user has installed and can run
  // interactively.
  private async findCommand(): Promise<string | null> {
    if (this.opts.resolveCommand) {
      return this.opts.resolveCommand(this.opts.command);
    }
    return findCliBinaryAsync(this.opts.command);
  }
}
