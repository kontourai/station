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
 *  - Put anything in the child's environment except the engine's own
 *    config-home override.
 *  - Report completion from an exit code. `credential-enrolment.ts` says why:
 *    a user who closes the browser tab gets a clean exit and no credential.
 *    The engine is asked, and its answer decides.
 *  - Report a half-state. A login whose output never yielded a URL and a code
 *    fails with that as its stated reason; it never sits in `starting`
 *    pretending a code is coming.
 */
import { spawn } from 'node:child_process';
import { augmentedSpawnEnv } from '../../providers/auth/cli-auth.js';
import {
  type EnrolmentAuthState,
  type EnrolmentEngine,
  enrolmentHomeEnv,
  enrolmentLoginArgs,
  verifyEnrolment,
} from './credential-enrolment.js';
import {
  type EngineLoginCapabilities,
  engineLoginCapabilities,
  mechanismEvidence,
} from './engine-login-capabilities.js';

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
  | { readonly kind: 'busy'; readonly reason: string };

/** The child-process surface this module uses — narrow so tests can stand it up. */
export interface DeviceCodeChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DeviceCodeLoginDeps {
  spawnLogin: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
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

export function defaultDeviceCodeLoginDeps(): DeviceCodeLoginDeps {
  return {
    spawnLogin: (command, args, options) =>
      spawn(command, args, {
        env: options.env,
        windowsHide: options.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as unknown as DeviceCodeChildProcess,
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
export const DEVICE_CODE_KILL_GRACE_MS = 5_000;
/** Output kept for parsing. A CLI that writes more than this is not prompting. */
export const DEVICE_CODE_OUTPUT_MAX_CHARS = 64 * 1024;
/** Concurrent live logins across every profile. */
export const DEVICE_CODE_MAX_LIVE_LOGINS = 4;
/** How long a finished record stays readable before it is pruned. */
export const DEVICE_CODE_RECORD_RETENTION_MS = 10 * 60_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are exactly what this strips
const ANSI_PATTERN = /\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]/g;

/**
 * A short, human-transcribable approval code: RFC 8628's user code, as both
 * observed CLIs actually spell it. Uppercase and digits, optionally grouped
 * with hyphens, and never all digits — a bare number on its own line is a
 * version or a count, not a code.
 */
const USER_CODE_PATTERN = /^[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){0,3}$/;
/** Only https. A verification URL offered over plaintext is not one Station relays. */
const HTTPS_URL_PATTERN = /https:\/\/[^\s"'<>)\]]+/;

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
 * The two structural facts it leans on, both observed live rather than
 * assumed (see `device-code-cli-output.ts`): the URL is printed before the
 * code, and the code is printed alone on its line. Requiring the code to
 * follow the URL is what keeps a banner line ("Welcome to Codex") from being
 * read as one.
 */
export function parseDeviceCodePrompt(
  output: string,
): DeviceCodePrompt | undefined {
  const lines = output.replace(ANSI_PATTERN, '').split(/\r?\n/);
  let verificationUri: string | undefined;
  for (const line of lines) {
    if (!verificationUri) {
      const url = HTTPS_URL_PATTERN.exec(line);
      if (url) verificationUri = url[0].replace(/[.,;:]+$/, '');
      continue;
    }
    const candidate = line.trim();
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
  output: string;
  /** Set the moment a terminal phase is decided, so a later exit cannot revise it. */
  settled: boolean;
  cancelTimers: Array<() => void>;
  finishedAtMs?: number;
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
   * SAME record and spawns nothing. The session is registered synchronously,
   * before the spawn, and the one `await` that precedes registration (the
   * capability probe) is re-checked on the far side.
   */
  async start(
    engine: EnrolmentEngine,
    profileDir: string,
  ): Promise<DeviceCodeStartResult> {
    this.#prune();
    const existing = this.#sessions.get(profileDir);
    if (existing && isLive(existing.record)) {
      return { kind: 'existing', record: existing.record };
    }
    const liveCount = [...this.#sessions.values()].filter((session) =>
      isLive(session.record),
    ).length;
    if (liveCount >= DEVICE_CODE_MAX_LIVE_LOGINS) {
      return {
        kind: 'busy',
        reason: `${DEVICE_CODE_MAX_LIVE_LOGINS} device logins are already waiting for approval on this host.`,
      };
    }

    const capabilities = await this.#deps.capabilities(engine);
    const evidence = mechanismEvidence(capabilities, 'device-code');
    if (!evidence) {
      return {
        kind: 'unsupported',
        reason:
          capabilities.unavailableReason ??
          `The installed ${engine} CLI does not offer a device-code login.`,
      };
    }
    // Re-check after the await: a concurrent caller may have registered while
    // the capability probe was in flight.
    const raced = this.#sessions.get(profileDir);
    if (raced && isLive(raced.record)) {
      return { kind: 'existing', record: raced.record };
    }

    const startedAt = this.#deps.now();
    const session: LoginSession = {
      profileDir,
      output: '',
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
    this.#sessions.set(profileDir, session);

    const baseEnv = await this.#deps.baseEnv();
    const args = [
      ...enrolmentLoginArgs(engine),
      ...(evidence.argument ? [evidence.argument] : []),
    ];
    let child: DeviceCodeChildProcess;
    try {
      child = this.#deps.spawnLogin(engine, args, {
        // The engine's own config-home override is the ONLY thing Station
        // adds. `credential-enrolment.ts`'s invariant, at a spawn instead of
        // a printed command.
        env: { ...baseEnv, ...enrolmentHomeEnv(engine, profileDir) },
        windowsHide: true,
      });
    } catch {
      this.#fail(session, `The ${engine} login could not be started.`);
      return { kind: 'started', record: session.record };
    }
    session.child = child;

    const onChunk = (chunk: unknown) => {
      if (session.settled) return;
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString('utf8');
      if (session.output.length < DEVICE_CODE_OUTPUT_MAX_CHARS) {
        session.output = (session.output + text).slice(
          0,
          DEVICE_CODE_OUTPUT_MAX_CHARS,
        );
      }
      if (session.record.phase !== 'starting') return;
      const prompt = parseDeviceCodePrompt(session.output);
      if (!prompt) return;
      session.record = {
        ...session.record,
        phase: 'awaiting-approval',
        verificationUri: prompt.verificationUri,
        userCode: prompt.userCode,
      };
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

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
        this.#kill(session);
        this.#fail(
          session,
          `The ${engine} login did not print a verification code, so there is nothing to approve.`,
        );
      }, DEVICE_CODE_PROMPT_TIMEOUT_MS),
      this.#deps.schedule(() => {
        if (session.settled) return;
        this.#kill(session);
        this.#fail(session, 'The device code expired before it was approved.');
      }, DEVICE_CODE_LOGIN_TIMEOUT_MS),
    );

    return { kind: 'started', record: session.record };
  }

  /** Stop a live login and kill its process. Returns the record it stopped. */
  cancel(profileDir: string): DeviceCodeLoginRecord | undefined {
    const session = this.#sessions.get(profileDir);
    if (!session || !isLive(session.record)) return undefined;
    this.#kill(session);
    this.#settle(session, { ...session.record, phase: 'cancelled' });
    return session.record;
  }

  /** Kill every live login. For runtime shutdown. */
  cancelAll(): void {
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

  #kill(session: LoginSession): void {
    const child = session.child;
    if (!child) return;
    session.child = undefined;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    // The grace timer is registered before `#settle` clears the list only on
    // the cancel path; on the deadline paths `#settle` runs after this, so it
    // would drop the SIGKILL. Keep it on its own handle instead.
    this.#deps.schedule(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process is already gone, which is the outcome this wanted.
      }
    }, DEVICE_CODE_KILL_GRACE_MS);
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
