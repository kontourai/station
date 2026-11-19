/**
 * Device-code enrolment: run the engine's OWN login in its device-code mode,
 * relay the verification URL and user code, and let the CLI keep the token.
 *
 * Device code is the flow a phone can finish. The CLI prints a short-lived
 * URL and code, the user approves in whatever browser they are holding, and
 * the CLI writes its own credential store on this host. Station relays two
 * strings and never handles a token — the same delegation
 * `credential-enrolment.ts` already makes, with the one difference that
 * Station starts the process instead of printing a command for a terminal
 * the user may not have.
 *
 * What this module refuses to do:
 *
 *  - Spawn anything a caller did not explicitly ask for. {@link
 *    DeviceCodeLoginManager.start} is the only path to a process.
 *  - Spawn a mechanism the engine has not been observed to support. The
 *    device-code argument comes from `engineLoginCapabilities`'s evidence, so
 *    an engine that no longer advertises it is refused rather than invoked
 *    with a flag it will reject.
 *  - Add a credential to the child's environment. Enrolment sets the engine's
 *    config home and launcher switches. The owned-process launcher adds the
 *    standard Station process-ownership metadata.
 *  - Report completion from an exit code. `credential-enrolment.ts` says why:
 *    a user who closes the browser tab gets a clean exit and no credential.
 *    The engine is asked, and its answer decides.
 *  - Report a half-state. A login whose output never yielded a URL and a code
 *    fails with that as its stated reason; it never sits in `starting`
 *    pretending a code is coming.
 */
import { augmentedSpawnEnv } from '../../providers/auth/cli-auth.js';
import { createLogger } from '../../utils/logger.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../infra/process-utils.js';
import {
  type EnrolmentAuthState,
  type EnrolmentEngine,
  enrolmentChildEnv,
  enrolmentHomeEnv,
  enrolmentLoginArgs,
  verifyEnrolment,
} from './credential-enrolment.js';
import {
  type EngineLoginCapabilities,
  engineLoginCapabilities,
  mechanismEvidence,
} from './engine-login-capabilities.js';

const logger = createLogger({ name: 'device-code-login' });

/**
 * `verifying` is a real state, not a cosmetic one: the process has exited and
 * Station is asking the engine whether an account actually landed. It is the
 * phase in which an exit code would have been mistaken for an answer.
 */
export type DeviceCodeLoginPhase =
  | 'starting'
  | 'awaiting-approval'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DeviceCodeLoginRecord {
  readonly engine: EnrolmentEngine;
  readonly phase: DeviceCodeLoginPhase;
  readonly startedAt: string;
  /** When Station will kill the login if it has not finished. */
  readonly expiresAt: string;
  /** Present from `awaiting-approval` onward. */
  readonly verificationUri?: string;
  readonly userCode?: string;
  /** The engine's own words about the signed-in account, on completion. */
  readonly detail?: string;
  /** Why this login is not going to succeed. Present on `failed` only. */
  readonly reason?: string;
}

export type DeviceCodeStartResult =
  | { readonly kind: 'started'; readonly record: DeviceCodeLoginRecord }
  /** A login was already running for this profile; no second process. */
  | { readonly kind: 'existing'; readonly record: DeviceCodeLoginRecord }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'busy'; readonly reason: string }
  /** Cancelled while Station was still preparing to spawn it; nothing was spawned. */
  | { readonly kind: 'cancelled'; readonly record: DeviceCodeLoginRecord }
  /** Could not be started at all; the record carries the reason. */
  | { readonly kind: 'failed'; readonly record: DeviceCodeLoginRecord }
  /**
   * The profile is already signed in. A login would let whoever approves the
   * code replace that account, and its completion could not be told apart
   * from the credential that was already there.
   */
  | { readonly kind: 'already-signed-in'; readonly reason: string }
  /** The engine could not say whether the profile is signed in, so that risk cannot be ruled out. */
  | { readonly kind: 'sign-in-state-unknown'; readonly reason: string }
  /** The manager was closed for runtime shutdown; nothing was started. */
  | { readonly kind: 'closed'; readonly reason: string };

/** The child-process surface this module uses — narrow so tests can stand it up. */
export interface DeviceCodeChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  stop(): Promise<void>;
}

export interface DeviceCodeLoginDeps {
  spawnLogin: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => DeviceCodeChildProcess;
  /** The environment the child starts from, BEFORE the config-home override. */
  baseEnv: () => Promise<NodeJS.ProcessEnv>;
  capabilities: (engine: EnrolmentEngine) => Promise<EngineLoginCapabilities>;
  verify: (
    engine: EnrolmentEngine,
    profileDir: string,
  ) => Promise<{ state: EnrolmentAuthState; detail?: string }>;
  now: () => Date;
  /** Returns a cancel function. Injected so deadline tests need no real clock. */
  schedule: (run: () => void, delayMs: number) => () => void;
}

function defaultDeviceCodeLoginDeps(): DeviceCodeLoginDeps {
  return {
    spawnLogin: (command, args, options) => {
      const { proc, release } = spawnOwnedChild(command, args, {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stopping = false;
      proc.once('close', () => {
        if (!stopping) release();
      });
      return {
        stdout: proc.stdout,
        stderr: proc.stderr,
        on: proc.on.bind(proc),
        stop: () => {
          stopping = true;
          return terminateProcessTree(proc, {
            graceMs: DEVICE_CODE_KILL_GRACE_MS,
          }).then(release);
        },
      };
    },
    baseEnv: () => augmentedSpawnEnv(),
    capabilities: (engine) => engineLoginCapabilities(engine),
    verify: (engine, profileDir) => verifyEnrolment(engine, profileDir),
    now: () => new Date(),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

/**
 * Codex prints "expires in 15 minutes" next to its code, so the host-side
 * process has no reason to outlive that. This is the bound that makes an
 * abandoned login unable to leak a process: nothing else has to go right.
 */
export const DEVICE_CODE_LOGIN_TIMEOUT_MS = 15 * 60_000;
/**
 * How long Station waits for the CLI to print a URL and a code before
 * concluding it is not going to. Long enough for a cold `npx`/mise launcher
 * (observed at ~6s on a dogfood host), short enough that a wrong invocation
 * is reported rather than parked.
 */
export const DEVICE_CODE_PROMPT_TIMEOUT_MS = 90_000;
/** Between SIGTERM and SIGKILL. */
const DEVICE_CODE_KILL_GRACE_MS = 5_000;
/** Output kept for parsing. A CLI that writes more than this is not prompting. */
const DEVICE_CODE_OUTPUT_MAX_CHARS = 64 * 1024;
/** Host slots reserved by active logins and process trees awaiting confirmed exit. */
export const DEVICE_CODE_MAX_LIVE_LOGINS = 4;
/** How long a finished record stays readable before it is pruned. */
const DEVICE_CODE_RECORD_RETENTION_MS = 10 * 60_000;

// OSC sequences first (ESC ] ... BEL or ESC \): an OSC 8 hyperlink wraps a
// URL, and stripping only its first two bytes left the rest inside the URL.
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are exactly what this strips
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/**
 * A short, human-transcribable approval code: RFC 8628's user code, as both
 * observed CLIs actually spell it. Uppercase and digits in hyphen-separated
 * groups, and never all digits — a bare number on its own line is a version
 * or a count, not a code. The hyphen is required: both observed CLIs and
 * RFC 8628's own examples group the code, while an ungrouped capitalised word
 * printed between the URL and the code ("WARNING") is prose.
 */
const USER_CODE_PATTERN = /^[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,3}$/;
/** A candidate only. `relayableVerificationUri` decides whether it is sent anywhere. */
const HTTPS_URL_PATTERN = /https:\/\/[^\s"'<>)\]]+/;
/**
 * Long enough for any real verification URL (Muse embeds its code in the
 * query), short enough that a runaway line is never relayed to a client.
 */
const MAX_VERIFICATION_URI_LENGTH = 2048;
// Control, bidi-override and zero-width characters. A relayed URL is rendered
// on another device, where any of them can disguise where it points.
const UNSAFE_URI_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting these is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

/**
 * The URL Station is willing to relay to a client, or nothing. It must parse,
 * use https, name a host, carry no userinfo (`https://auth.example@evil/`
 * reads as one host and goes to another), stay under a length bound, and hold
 * no control, bidi-override or zero-width characters. What is relayed is the
 * parsed `href`, not the text.
 */
function relayableVerificationUri(candidate: string): string | undefined {
  if (candidate.length > MAX_VERIFICATION_URI_LENGTH) return undefined;
  if (UNSAFE_URI_CHARACTERS.test(candidate)) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !url.hostname) return undefined;
  if (url.username || url.password) return undefined;
  // The parsed form, not the text. A backslash lets a URL read as an
  // openai.com address while a WHATWG parser sends it to a different host;
  // relaying `href` shows the host it will actually reach.
  return url.href;
}

export interface DeviceCodePrompt {
  readonly verificationUri: string;
  readonly userCode: string;
}

/**
 * Read the verification URL and user code out of a CLI's own output.
 *
 * Parsing another program's prose is fragile, which is why this returns
 * `undefined` rather than a guess, and why the caller turns `undefined` into
 * a stated failure instead of a phase that implies a code is on its way.
 *
 * The structural facts it leans on, all observed live rather than assumed
 * (see `device-code-cli-output.ts`): the URL and the code are each printed
 * alone on their own line, and the URL comes first. Requiring the code to
 * follow the URL is what keeps a banner line ("Welcome to Codex") from being
 * read as one.
 */
export function parseDeviceCodePrompt(
  output: string,
): DeviceCodePrompt | undefined {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/);
  let verificationUri: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const url = HTTPS_URL_PATTERN.exec(trimmed);
    if (url && url.index === 0 && url[0].length === trimmed.length) {
      // Only a URL alone on its line is a verification URL; both observed CLIs
      // print theirs that way. A URL inside a sentence -- an update notice
      // ahead of the prompt, a help link between the URL and the code -- is
      // not one, and taking it would relay the wrong page next to a real code.
      const relayable = relayableVerificationUri(
        url[0].replace(/[.,;:]+$/, ''),
      );
      if (relayable) verificationUri = relayable;
      continue;
    }
    if (!verificationUri) continue;
    const candidate = trimmed;
    if (!USER_CODE_PATTERN.test(candidate)) continue;
    const payload = candidate.replace(/-/g, '');
    if (payload.length < 6 || payload.length > 12) continue;
    if (!/[A-Z]/.test(payload)) continue;
    return { verificationUri, userCode: candidate };
  }
  return undefined;
}

interface LoginSession {
  record: DeviceCodeLoginRecord;
  readonly profileDir: string;
  child?: DeviceCodeChildProcess;
  /** Set the moment a terminal phase is decided, so a later exit cannot revise it. */
  settled: boolean;
  cancelTimers: Array<() => void>;
  finishedAtMs?: number;
}

const CLOSED_REASON =
  'Station is shutting down, so no new device login was started.';

/** A start that has passed the fast checks but not yet registered a session. */
interface PendingStart {
  readonly profileDir: string;
  readonly engine: EnrolmentEngine;
  cancelled?: DeviceCodeLoginRecord;
}

function busyReason(): string {
  return `All ${DEVICE_CODE_MAX_LIVE_LOGINS} device sign-in slots on this host are in use. Process cleanup keeps a slot reserved until exit is confirmed.`;
}

function isLive(record: DeviceCodeLoginRecord): boolean {
  return (
    record.phase === 'starting' ||
    record.phase === 'awaiting-approval' ||
    record.phase === 'verifying'
  );
}

export class DeviceCodeLoginManager {
  readonly #deps: DeviceCodeLoginDeps;
  readonly #sessions = new Map<string, LoginSession>();
  readonly #pending = new Set<PendingStart>();
  readonly #stopping = new Map<string, 'stopping' | 'unconfirmed'>();
  #closed = false;

  constructor(deps: DeviceCodeLoginDeps = defaultDeviceCodeLoginDeps()) {
    this.#deps = deps;
  }

  status(profileDir: string): DeviceCodeLoginRecord | undefined {
    this.#prune();
    return this.#sessions.get(profileDir)?.record;
  }

  /**
   * Start the engine's device-code login for this profile.
   *
   * Single-flight per profile: a second start while one is live returns the
   * SAME record and spawns nothing. Two awaits precede registration (the
   * capability probe and the engine's sign-in check), and everything they
   * could change is re-checked afterwards, in the synchronous window before
   * the session enters the map. A cancel or shutdown that arrives during those
   * awaits has no session to act on, so it is recorded against the pending
   * start and honoured at that re-check.
   */
  async start(
    engine: EnrolmentEngine,
    profileDir: string,
    isCurrent: () => boolean = () => true,
  ): Promise<DeviceCodeStartResult> {
    this.#prune();
    if (this.#closed) {
      return { kind: 'closed', reason: CLOSED_REASON };
    }
    const stopRefusal = this.#stopRefusal(profileDir);
    if (stopRefusal) return stopRefusal;
    const existing = this.#sessions.get(profileDir);
    if (existing && isLive(existing.record)) {
      return { kind: 'existing', record: existing.record };
    }
    if (this.#occupiedLoginSlots() >= DEVICE_CODE_MAX_LIVE_LOGINS) {
      return { kind: 'busy', reason: busyReason() };
    }
    const pending: PendingStart = { profileDir, engine };
    this.#pending.add(pending);
    try {
      return await this.#startAfterChecks(
        engine,
        profileDir,
        pending,
        isCurrent,
      );
    } finally {
      this.#pending.delete(pending);
    }
  }

  async #startAfterChecks(
    engine: EnrolmentEngine,
    profileDir: string,
    pending: PendingStart,
    isCurrent: () => boolean,
  ): Promise<DeviceCodeStartResult> {
    const capabilities = await this.#deps.capabilities(engine);
    const interruptedDuringProbe = this.#startInterruption(pending, isCurrent);
    if (interruptedDuringProbe) return interruptedDuringProbe;
    const evidence = mechanismEvidence(capabilities, 'device-code');
    if (!evidence) {
      return {
        kind: 'unsupported',
        reason:
          capabilities.unavailableReason ??
          `The installed ${engine} CLI does not offer a device-code login.`,
      };
    }
    // Refuse a login into a profile that is already signed in, or that the
    // engine cannot vouch for. Starting one would hand the account to whoever
    // approves the code, and a later "authenticated" could not be told apart
    // from the credential that was already there. Refusing here is what lets
    // `#onExit` read `authenticated` as this login's own result.
    const current = await this.#currentAuthState(engine, profileDir);
    const interruptedDuringVerification = this.#startInterruption(
      pending,
      isCurrent,
    );
    if (interruptedDuringVerification) return interruptedDuringVerification;
    if (current === 'authenticated') {
      return {
        kind: 'already-signed-in',
        reason: `This credential profile is already signed in to ${engine}, so Station did not start a login that would replace that account.`,
      };
    }
    if (current !== 'unauthenticated') {
      return {
        kind: 'sign-in-state-unknown',
        reason: `The ${engine} CLI could not report whether this credential profile is already signed in, so Station did not start a login that might replace an account.`,
      };
    }
    // Re-check everything the awaits above could have changed. Registration
    // below is synchronous, so a check made here holds until the session is in
    // the map: this is where single-flight and the cap are actually enforced,
    // and the checks at the top are only a fast path.
    const raced = this.#sessions.get(profileDir);
    if (raced && isLive(raced.record)) {
      return { kind: 'existing', record: raced.record };
    }
    if (this.#occupiedLoginSlots() >= DEVICE_CODE_MAX_LIVE_LOGINS) {
      return { kind: 'busy', reason: busyReason() };
    }

    const startedAt = this.#deps.now();
    const session: LoginSession = {
      profileDir,
      settled: false,
      cancelTimers: [],
      record: {
        engine,
        phase: 'starting',
        startedAt: startedAt.toISOString(),
        expiresAt: new Date(
          startedAt.getTime() + DEVICE_CODE_LOGIN_TIMEOUT_MS,
        ).toISOString(),
      },
    };
    this.#pending.delete(pending);
    this.#sessions.set(profileDir, session);

    let baseEnv: Awaited<ReturnType<DeviceCodeLoginDeps['baseEnv']>>;
    try {
      baseEnv = await this.#deps.baseEnv();
    } catch {
      // A cancel that landed first already decided this login's outcome.
      if (session.settled) {
        return { kind: 'cancelled', record: session.record };
      }
      this.#fail(
        session,
        `The ${engine} login could not be started: Station could not prepare its environment.`,
      );
      return { kind: 'failed', record: session.record };
    }
    // The session was registered before that await, so a cancel can land while
    // the environment is being prepared. It found no child to kill; spawning
    // now would start a process that nothing tracks or bounds.
    if (session.settled) {
      return { kind: 'cancelled', record: session.record };
    }
    if (!isCurrent()) {
      this.cancel(profileDir);
      return { kind: 'cancelled', record: session.record };
    }
    const args = [
      ...enrolmentLoginArgs(engine),
      ...(evidence.argument ? [evidence.argument] : []),
    ];
    let child: DeviceCodeChildProcess;
    try {
      child = this.#deps.spawnLogin(engine, args, {
        env: enrolmentChildEnv(
          engine,
          baseEnv,
          enrolmentHomeEnv(engine, profileDir),
        ),
      });
    } catch {
      this.#fail(session, `The ${engine} login could not be started.`);
      return { kind: 'failed', record: session.record };
    }
    session.child = child;

    const watchPrompt = (stream: NodeJS.ReadableStream | null) => {
      let output = '';
      stream?.on('data', (chunk: Buffer | string) => {
        if (session.settled || session.record.phase !== 'starting') return;
        if (output.length >= DEVICE_CODE_OUTPUT_MAX_CHARS) return;
        output = (output + chunk.toString()).slice(
          0,
          DEVICE_CODE_OUTPUT_MAX_CHARS,
        );
        const prompt = parseDeviceCodePrompt(output);
        if (!prompt) return;
        session.record = {
          ...session.record,
          phase: 'awaiting-approval',
          verificationUri: prompt.verificationUri,
          userCode: prompt.userCode,
        };
      });
    };
    watchPrompt(child.stdout);
    watchPrompt(child.stderr);

    child.on('error', (error) => {
      this.#fail(
        session,
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? `The ${engine} command was not found on this host.`
          : `The ${engine} login could not be started.`,
      );
    });
    child.on('exit', (code) => {
      void this.#onExit(session, engine, profileDir, code);
    });

    session.cancelTimers.push(
      this.#deps.schedule(() => {
        if (session.settled || session.record.phase !== 'starting') return;
        this.#stop(session);
        this.#fail(
          session,
          `The ${engine} login did not print a verification code, so there is nothing to approve.`,
        );
      }, DEVICE_CODE_PROMPT_TIMEOUT_MS),
      this.#deps.schedule(() => {
        // Once the process has exited, the code was either approved or not and
        // the engine is being asked which. That answer outranks the clock.
        if (session.settled || session.record.phase === 'verifying') return;
        this.#stop(session);
        this.#fail(session, 'The device code expired before it was approved.');
      }, DEVICE_CODE_LOGIN_TIMEOUT_MS),
    );

    return { kind: 'started', record: session.record };
  }

  /** Cancel a pending start or stop a live login and its process tree. */
  cancel(profileDir: string): DeviceCodeLoginRecord | undefined {
    let cancelled: DeviceCodeLoginRecord | undefined;
    for (const pending of this.#pending) {
      if (pending.profileDir !== profileDir || pending.cancelled) continue;
      pending.cancelled = this.#cancelledStartRecord(pending.engine);
      cancelled ??= pending.cancelled;
    }
    const session = this.#sessions.get(profileDir);
    if (!session || !isLive(session.record)) return cancelled;
    this.#stop(session);
    this.#settle(session, { ...session.record, phase: 'cancelled' });
    return session.record;
  }

  #cancelledStartRecord(engine: EnrolmentEngine): DeviceCodeLoginRecord {
    const now = this.#deps.now().toISOString();
    return { engine, phase: 'cancelled', startedAt: now, expiresAt: now };
  }

  #startInterruption(
    pending: PendingStart,
    isCurrent: () => boolean,
  ): DeviceCodeStartResult | undefined {
    const record = pending.cancelled;
    if (record) return { kind: 'cancelled', record };
    if (this.#closed || !isCurrent()) {
      return {
        kind: 'cancelled',
        record: this.#cancelledStartRecord(pending.engine),
      };
    }
    return this.#stopRefusal(pending.profileDir);
  }

  #stopRefusal(profileDir: string): DeviceCodeStartResult | undefined {
    const state = this.#stopping.get(profileDir);
    if (!state) return undefined;
    return {
      kind: 'busy',
      reason:
        state === 'stopping'
          ? 'Station is still stopping the previous sign-in process for this profile.'
          : 'Station could not confirm that the previous sign-in process for this profile stopped.',
    };
  }

  /**
   * Kill every live login and refuse new ones. Runtime shutdown reaches this
   * through `cancelSharedDeviceCodeLogins`; afterwards the manager is closed.
   */
  cancelAll(): void {
    this.#closed = true;
    for (const profileDir of [...this.#sessions.keys()]) {
      this.cancel(profileDir);
    }
  }

  async #onExit(
    session: LoginSession,
    engine: EnrolmentEngine,
    profileDir: string,
    code: number | null,
  ): Promise<void> {
    if (session.settled) return;
    if (session.record.phase === 'starting') {
      this.#fail(
        session,
        `The ${engine} login exited${
          code === null ? '' : ` with code ${code}`
        } without printing a verification code.`,
      );
      return;
    }
    session.record = { ...session.record, phase: 'verifying' };
    // The exit code is deliberately not consulted here. A user who closed the
    // browser tab gets a clean exit and no credential; a CLI killed after a
    // successful write gets a non-zero one. Only the engine knows.
    let verification: { state: EnrolmentAuthState; detail?: string };
    try {
      verification = await this.#deps.verify(engine, profileDir);
    } catch {
      verification = { state: 'unknown' };
    }
    if (session.settled) return;
    // `start` only proceeds for a profile the engine reported signed out, so
    // `authenticated` here is this login's own result, not a prior credential.
    if (verification.state === 'authenticated') {
      this.#settle(session, {
        ...session.record,
        phase: 'completed',
        ...(verification.detail ? { detail: verification.detail } : {}),
      });
      return;
    }
    this.#fail(
      session,
      verification.state === 'unauthenticated'
        ? `The ${engine} CLI reports this credential profile is still signed out.`
        : `The ${engine} CLI could not report whether the sign-in succeeded.`,
    );
  }

  #occupiedLoginSlots(): number {
    let count = this.#stopping.size;
    for (const [profileDir, session] of this.#sessions) {
      if (isLive(session.record) && !this.#stopping.has(profileDir)) count += 1;
    }
    return count;
  }

  async #currentAuthState(
    engine: EnrolmentEngine,
    profileDir: string,
  ): Promise<EnrolmentAuthState> {
    try {
      return (await this.#deps.verify(engine, profileDir)).state;
    } catch {
      return 'unknown';
    }
  }

  #fail(session: LoginSession, reason: string): void {
    if (session.settled) return;
    this.#settle(session, { ...session.record, phase: 'failed', reason });
  }

  #settle(session: LoginSession, record: DeviceCodeLoginRecord): void {
    session.settled = true;
    session.record = record;
    session.finishedAtMs = this.#deps.now().getTime();
    for (const cancelTimer of session.cancelTimers) cancelTimer();
    session.cancelTimers = [];
  }

  #stop(session: LoginSession): void {
    const child = session.child;
    if (!child) return;
    session.child = undefined;
    const { profileDir } = session;
    this.#stopping.set(profileDir, 'stopping');
    void child.stop().then(
      () => this.#stopping.delete(profileDir),
      (error: unknown) => {
        this.#stopping.set(profileDir, 'unconfirmed');
        logger.warn('Device login process tree did not confirm exit', {
          engine: session.record.engine,
          error: String(error),
        });
      },
    );
  }

  #prune(): void {
    const nowMs = this.#deps.now().getTime();
    for (const [profileDir, session] of this.#sessions) {
      if (isLive(session.record)) continue;
      const finishedAtMs = session.finishedAtMs ?? nowMs;
      if (nowMs - finishedAtMs >= DEVICE_CODE_RECORD_RETENTION_MS) {
        this.#sessions.delete(profileDir);
      }
    }
  }
}

let shared: DeviceCodeLoginManager | undefined;

/** The runtime's single manager. Tests construct their own instead. */
export function deviceCodeLoginManager(): DeviceCodeLoginManager {
  shared ??= new DeviceCodeLoginManager();
  return shared;
}

/**
 * Kill every live login held by the runtime's manager. A no-op when no login
 * was ever requested: shutdown must not construct a manager to find it empty.
 */
export function cancelSharedDeviceCodeLogins(): void {
  shared?.cancelAll();
}
