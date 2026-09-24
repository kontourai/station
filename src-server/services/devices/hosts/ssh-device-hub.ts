/**
 * The device hub on an SSH device host, supervised from this Station
 * (#1973, D11).
 *
 * Adapted from t3code's `apps/server/src/device/SshDeviceHost.ts` (MIT,
 * © 2026 T3 Tools Inc.): a remote start over ssh, then an `ssh -N -L`
 * forward with ServerAlive and ExitOnForwardFailure, a readiness probe
 * through the forward, and a reconnect loop with doubling backoff.
 *
 * Two ssh processes per running hub:
 *
 * 1. The SESSION runs the device-host program in `start` mode
 *    (`ssh-device-remote-script.ts`). It starts the pinned hub on the
 *    host's loopback under the SAME guard as the local hub, with a fresh
 *    per-launch secret sent on stdin, and reports the port the hub bound.
 *    The hub lives as long as this session: closing its stdin stops it.
 * 2. The FORWARD maps a local ephemeral loopback port to the host's hub
 *    port. Both ends are numeric loopback.
 *
 * `running` is claimed only after `/readyz` answered THROUGH the forward
 * with the secret. The connection this hands out is the same
 * `DeviceHubConnection` the local hub uses — the same allowlists, the secret
 * header on every request — carrying this host's id; sessions, the pane and
 * the live producer use it unchanged.
 *
 * Either process exiting ends the hub instance (its connection reports the
 * exit, so every device session on it ends) and schedules a restart with
 * backoff. Failures a retry cannot fix — an unconfirmed host key, a refused
 * key, no Node, no install, the operator never enabled the hub — stop at
 * `failed` at once, until a person starts it again.
 *
 * Both local ports (the forward) and the host's hub port are reported to
 * the host browser's Station-listener deny set (`listeningPorts`), read live,
 * and stay there until the ssh children that use them have exited.
 *
 * The per-launch secret (security review H1): the local port is reserved
 * then released before ssh binds it, and ssh binds only after it
 * authenticates, so another local process could take the port in between.
 * Nothing is sent to the port until ssh ITSELF reports it holds the
 * listener ("Local forwarding listening on 127.0.0.1 port <p>.", DEBUG1 on
 * the forward only). If the forward fails for any reason, the whole start
 * is torn down and the next try is a NEW session with a NEW secret: a
 * secret is never offered to a second port.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type {
  DeviceSshHostFailure,
  DeviceSshHubState,
} from '@kontourai/station-contracts/mobile-device';
import {
  createDeviceHubConnection,
  type DeviceHubConnection,
  HUB_SECRET_HEADER,
} from '../toolchain/device-hub-connection.js';
import {
  buildHubGuardSource,
  HUB_GUARD_SECRET_ENV,
  HUB_GUARD_VERIFIED_VERSIONS,
} from '../toolchain/device-hub-guard.js';
import {
  HUB_ENV_ALLOWLIST,
  HUB_EXTRA_ENV,
  HUB_LAUNCH_ARGS,
} from '../toolchain/device-hub-supervisor.js';
import { DEVICE_TOOL_PINS } from '../toolchain/device-tool-pins.js';
import {
  createEventReader,
  remoteFailure,
  remoteHeader,
  type SpawnSsh,
  type SshChild,
  SshDeviceHostError,
  spawnSystemSsh,
} from './ssh-device-session.js';
import {
  buildSshDeviceCommandArgs,
  buildSshDeviceForwardArgs,
  classifySshDeviceFailure,
  forwardListeningPort,
  type SshDeviceTarget,
} from './ssh-device-target.js';

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const MAX_ATTEMPTS = 5;
const START_TIMEOUT_MS = 60_000;
const REMOTE_READY_TIMEOUT_MS = 30_000;
const FORWARD_READY_TIMEOUT_MS = 15_000;
const FORWARD_ATTEMPTS = 3;
const STOP_GRACE_MS = 3_000;

/** Failures a retry cannot change: stop and wait for a person. */
const TERMINAL_FAILURES: ReadonlySet<DeviceSshHostFailure> = new Set([
  'ssh-unavailable',
  'host-key-unverified',
  'host-key-changed',
  'auth-failed',
  'node-missing',
  'unsupported-node',
  'hub-not-installed',
  'hub-not-enabled',
  'local-hub-not-installed',
  'protocol',
  // ssh never said it holds the listener (another OpenSSH wording?): a
  // retry would only relaunch the same unconfirmable forward (L-c).
  'forward-unconfirmed',
]);

export interface SshHubLaunch {
  version: string;
  /** The verified tree's manifest digest the host must have installed. */
  digest: string;
}

export interface SshDeviceHubOptions {
  hostId: string;
  /** Read on every start: an edited host is reached at its new target. */
  target: () => SshDeviceTarget;
  /** 24 hex: namespaces this Station's state on the host. */
  owner: string;
  /** The operator enabled the hub on this host (the consent). */
  enabled: () => boolean;
  /** The local verified install to match, or undefined when there is none. */
  resolveLaunch: () => SshHubLaunch | undefined;
  spawn?: SpawnSsh;
  reservePort?: () => Promise<number>;
  probeReady?: (
    baseUrl: string,
    signal: AbortSignal,
    headers: Record<string, string>,
  ) => Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  startTimeoutMs?: number;
  forwardReadyTimeoutMs?: number;
  /**
   * Re-send the verified hub (the operator's consent stands) after the host
   * reported `hub-not-installed` — e.g. this Station's pinned version or
   * digest changed. Resolves true when the host now has it. Tried at most
   * once per start.
   */
  reinstall?: () => Promise<boolean>;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function defaultProbeReady(
  baseUrl: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<boolean> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, {
        redirect: 'error',
        signal,
        headers,
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return true;
    } catch {
      // The forward is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * A usable port for the hub on the HOST: unprivileged. (3000/3141 are this
 * machine's ports, not the host's; the local forward port is chosen here.)
 */
function usablePort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 1024 &&
    value <= 65_535
  );
}

interface Running {
  session: SshChild;
  forward: SshChild;
  connection: ReturnType<typeof createDeviceHubConnection>;
  localPort: number;
  remotePort: number;
  startedAtMs: number;
}

/** One start in flight, or one being torn down. */
interface Attempt {
  session?: SshChild;
  forward?: SshChild;
  /** Denied until the children above have exited. */
  ports: Set<number>;
}

const failureOf = (error: unknown): DeviceSshHostFailure =>
  error instanceof SshDeviceHostError ? error.failure : 'start-failed';

export class SshDeviceHub {
  readonly hostId: string;
  readonly #o: Required<
    Omit<
      SshDeviceHubOptions,
      'hostId' | 'target' | 'owner' | 'enabled' | 'resolveLaunch' | 'reinstall'
    >
  > &
    Pick<
      SshDeviceHubOptions,
      'target' | 'owner' | 'enabled' | 'resolveLaunch' | 'reinstall'
    >;
  #state: DeviceSshHubState = { state: 'stopped' };
  #running: Running | undefined;
  #starting: Promise<DeviceHubConnection> | undefined;
  /** The start in flight (its children are killed by stop()). */
  #inflight: Attempt | undefined;
  /** Attempts being torn down: their ports stay denied until exit. */
  readonly #retiring = new Set<Attempt>();
  #timer: unknown;
  #attempts = 0;
  #stopped = true;
  #generation = 0;
  /** Children that already exited: nothing to wait for on teardown. */
  readonly #exited = new WeakSet<SshChild>();

  constructor(options: SshDeviceHubOptions) {
    this.hostId = options.hostId;
    this.#o = {
      target: options.target,
      owner: options.owner,
      enabled: options.enabled,
      resolveLaunch: options.resolveLaunch,
      reinstall: options.reinstall,
      spawn: options.spawn ?? spawnSystemSsh,
      reservePort: options.reservePort ?? reserveLoopbackPort,
      probeReady: options.probeReady ?? defaultProbeReady,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer:
        options.clearTimer ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      startTimeoutMs: options.startTimeoutMs ?? START_TIMEOUT_MS,
      forwardReadyTimeoutMs:
        options.forwardReadyTimeoutMs ?? FORWARD_READY_TIMEOUT_MS,
    };
  }

  state(): DeviceSshHubState {
    return this.#state;
  }

  /** The live connection, only while the hub answered through the forward. */
  connection(): DeviceHubConnection | undefined {
    return this.#running?.connection.ready
      ? this.#running.connection
      : undefined;
  }

  /**
   * The local forward port and the host's hub port, read live: the host
   * browser must reach neither (on an `ssh localhost` host the hub port IS
   * a local port). Ports of a start in flight or being torn down count
   * until their ssh children have exited.
   */
  listeningPorts(): number[] {
    const ports = new Set<number>();
    for (const attempt of [this.#inflight, ...this.#retiring])
      for (const port of attempt?.ports ?? []) ports.add(port);
    if (this.#running) {
      ports.add(this.#running.localPort);
      ports.add(this.#running.remotePort);
    }
    return [...ports].sort((a, b) => a - b);
  }

  ensureStarted(): Promise<DeviceHubConnection> {
    const live = this.connection();
    if (live) return Promise.resolve(live);
    if (this.#starting) return this.#starting;
    this.#stopped = false;
    if (this.#state.state === 'failed' || this.#state.state === 'stopped')
      this.#attempts = 0;
    if (this.#timer !== undefined) {
      this.#o.clearTimer(this.#timer);
      this.#timer = undefined;
    }
    return this.#start();
  }

  /** Stop the hub, and cancel a start in flight (its children are killed). */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== undefined) {
      this.#o.clearTimer(this.#timer);
      this.#timer = undefined;
    }
    const running = this.#running;
    this.#running = undefined;
    this.#starting = undefined;
    this.#state = { state: 'stopped' };
    const inflight = this.#inflight;
    this.#inflight = undefined;
    const done: Promise<void>[] = [];
    if (inflight) done.push(this.#retire(inflight));
    if (running) {
      running.connection.markExited('stopped');
      done.push(
        this.#retire({
          session: running.session,
          forward: running.forward,
          ports: new Set([running.localPort, running.remotePort]),
        }),
      );
    }
    await Promise.all(done);
  }

  #start(): Promise<DeviceHubConnection> {
    const generation = this.#generation;
    this.#state = { state: 'starting' };
    const attempt = this.#run(generation);
    this.#starting = attempt;
    attempt.then(
      () => {
        if (this.#starting === attempt) this.#starting = undefined;
      },
      (error: unknown) => {
        if (this.#starting === attempt) this.#starting = undefined;
        if (generation !== this.#generation) return;
        this.#scheduleRestart(failureOf(error));
      },
    );
    return attempt;
  }

  /**
   * One start: a forward failure retries with a FRESH session and secret; a
   * host that no longer has this Station's verified hub gets it re-sent once
   * (M4), then the start is tried again.
   */
  async #run(generation: number): Promise<DeviceHubConnection> {
    let reinstalled = false;
    for (let forwardTries = 1; ; ) {
      try {
        return await this.#spawnOnce(generation);
      } catch (error) {
        if (generation !== this.#generation) throw error;
        const failure = failureOf(error);
        if (
          failure === 'hub-not-installed' &&
          !reinstalled &&
          this.#o.reinstall &&
          this.#o.enabled()
        ) {
          reinstalled = true;
          const ok = await this.#o.reinstall().catch(() => false);
          if (generation !== this.#generation) throw error;
          if (ok) continue;
          throw error;
        }
        if (failure === 'forward-failed' && forwardTries < FORWARD_ATTEMPTS) {
          forwardTries += 1;
          continue;
        }
        throw error;
      }
    }
  }

  async #spawnOnce(generation: number): Promise<DeviceHubConnection> {
    if (!this.#o.enabled()) throw new SshDeviceHostError('hub-not-enabled');
    const launch = this.#o.resolveLaunch();
    if (!launch) throw new SshDeviceHostError('local-hub-not-installed');
    if (!HUB_GUARD_VERIFIED_VERSIONS.includes(launch.version))
      throw new SshDeviceHostError('start-failed');
    const cancelled = () => generation !== this.#generation;
    const target = this.#o.target();
    // A new secret for every session: never re-offered after a failure.
    const secret = randomBytes(32).toString('hex');
    const attempt: Attempt = { ports: new Set() };
    this.#inflight = attempt;
    try {
      attempt.session = this.#track(
        this.#o.spawn(buildSshDeviceCommandArgs(target)),
      );
      const remotePort = await this.#awaitRemoteReady(
        attempt.session,
        launch,
        secret,
      );
      attempt.ports.add(remotePort);
      if (cancelled()) throw new SshDeviceHostError('start-failed');
      const localPort = await this.#o.reservePort();
      attempt.ports.add(localPort);
      if (cancelled()) throw new SshDeviceHostError('start-failed');
      attempt.forward = this.#track(
        this.#o.spawn(buildSshDeviceForwardArgs(target, localPort, remotePort)),
      );
      const outcome = await this.#awaitForward(
        attempt.forward,
        localPort,
        secret,
      );
      if (outcome !== true) throw new SshDeviceHostError(outcome);
      if (cancelled()) throw new SshDeviceHostError('start-failed');
      const connection = createDeviceHubConnection({
        hostId: this.hostId,
        port: localPort,
        version: launch.version,
        secret,
      });
      const running: Running = {
        session: attempt.session,
        forward: attempt.forward,
        connection,
        localPort,
        remotePort,
        startedAtMs: this.#o.now(),
      };
      this.#inflight = undefined;
      this.#running = running;
      this.#state = {
        state: 'running',
        startedAt: new Date(running.startedAtMs).toISOString(),
      };
      const onExit = () => this.#onUnexpectedExit(running);
      running.session.onExit(onExit);
      running.forward.onExit(onExit);
      return connection;
    } catch (error) {
      if (this.#inflight === attempt) this.#inflight = undefined;
      // Not awaited: a failed start reports at once. The children are
      // still ended, and their ports stay denied until they have.
      void this.#retire(attempt);
      throw error;
    }
  }

  /** Send the start request and wait for the host to report its hub port. */
  #awaitRemoteReady(
    session: SshChild,
    launch: SshHubLaunch,
    secret: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.#o.clearTimer(timer);
        fn();
      };
      const timer = this.#o.setTimer(
        () => settle(() => reject(new SshDeviceHostError('timeout'))),
        this.#o.startTimeoutMs,
      );
      session.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      session.stdout?.on(
        'data',
        createEventReader((event) => {
          if (event.event === 'ready') {
            const port = event.port;
            settle(() =>
              usablePort(port)
                ? resolve(port)
                : reject(new SshDeviceHostError('protocol')),
            );
            return;
          }
          const failure = remoteFailure(event);
          if (failure) settle(() => reject(new SshDeviceHostError(failure)));
        }),
      );
      session.onError(() =>
        settle(() => reject(new SshDeviceHostError('ssh-unavailable'))),
      );
      session.onExit((code) =>
        setImmediate(() =>
          settle(() =>
            reject(
              new SshDeviceHostError(
                classifySshDeviceFailure({ stderr, exitCode: code }),
              ),
            ),
          ),
        ),
      );
      const stdin = session.stdin;
      if (!stdin) {
        settle(() => reject(new SshDeviceHostError('ssh-unavailable')));
        return;
      }
      stdin.on('error', () => {});
      const pin = DEVICE_TOOL_PINS['expo-device-hub'];
      stdin.write(
        remoteHeader({
          mode: 'start',
          owner: this.#o.owner,
          version: launch.version,
          digest: launch.digest,
          secret,
          guardSource: buildHubGuardSource(),
          guardSecretEnv: HUB_GUARD_SECRET_ENV,
          envAllowlist: HUB_ENV_ALLOWLIST,
          extraEnv: { ...HUB_EXTRA_ENV },
          args: HUB_LAUNCH_ARGS,
          entry: pin.entry,
          readyTimeoutMs: REMOTE_READY_TIMEOUT_MS,
        }),
      );
      // stdin stays OPEN: it is the hub's lifetime on the host.
    });
  }

  /**
   * true once `/readyz` answered through the forward; else why not. The
   * secret is sent ONLY after ssh reported that it holds the listener on
   * exactly `localPort` (H1): until then another process may own the port.
   */
  #awaitForward(
    forward: SshChild,
    localPort: number,
    secret: string,
  ): Promise<true | DeviceSshHostFailure> {
    return new Promise((resolve) => {
      const abort = new AbortController();
      let stderr = '';
      let partial = '';
      let listening = false;
      let settled = false;
      const settle = (value: true | DeviceSshHostFailure) => {
        if (settled) return;
        settled = true;
        this.#o.clearTimer(timer);
        abort.abort();
        resolve(value);
      };
      const timer = this.#o.setTimer(
        // Never confirmed (L-c) is a different failure from a forward that
        // was confirmed but whose hub did not answer.
        () => settle(listening ? 'forward-failed' : 'forward-unconfirmed'),
        this.#o.forwardReadyTimeoutMs,
      );
      const probe = () => {
        this.#o
          .probeReady(`http://127.0.0.1:${localPort}`, abort.signal, {
            [HUB_SECRET_HEADER]: secret,
          })
          .then(
            (ready) => settle(ready ? true : 'forward-failed'),
            () => settle('forward-failed'),
          );
      };
      forward.stderr?.on('data', (chunk: Buffer) => {
        // Bounded: the tail for classification, one partial line for parsing.
        const text = chunk.toString();
        stderr = (stderr + text).slice(-8192);
        if (settled || listening) return;
        const lines = (partial + text).split('\n');
        partial = (lines.pop() ?? '').slice(-512);
        for (const line of lines)
          if (forwardListeningPort(line) === localPort) {
            listening = true;
            probe();
            return;
          }
      });
      forward.onError(() => settle('ssh-unavailable'));
      forward.onExit((code) =>
        setImmediate(() => {
          const failure = classifySshDeviceFailure({ stderr, exitCode: code });
          settle(failure === 'protocol' ? 'forward-failed' : failure);
        }),
      );
    });
  }

  #track(child: SshChild): SshChild {
    child.onExit(() => this.#exited.add(child));
    child.onError(() => this.#exited.add(child));
    return child;
  }

  #onUnexpectedExit(running: Running): void {
    if (this.#running !== running) return;
    this.#running = undefined;
    running.connection.markExited('ssh-closed');
    void this.#retire({
      session: running.session,
      forward: running.forward,
      ports: new Set([running.localPort, running.remotePort]),
    });
    if (this.#stopped) return;
    if (this.#o.now() - running.startedAtMs >= STABLE_UPTIME_MS)
      this.#attempts = 0;
    this.#scheduleRestart('start-failed');
  }

  #scheduleRestart(failure: DeviceSshHostFailure): void {
    if (this.#stopped) return;
    this.#attempts += 1;
    if (TERMINAL_FAILURES.has(failure) || this.#attempts >= MAX_ATTEMPTS) {
      this.#state = { state: 'failed', failure, attempts: this.#attempts };
      return;
    }
    const delay = Math.min(
      INITIAL_DELAY_MS * 2 ** (this.#attempts - 1),
      MAX_DELAY_MS,
    );
    this.#state = {
      state: 'restarting',
      attempt: this.#attempts,
      retryAt: new Date(this.#o.now() + delay).toISOString(),
    };
    this.#timer = this.#o.setTimer(() => {
      this.#timer = undefined;
      if (this.#stopped || this.#starting || this.#running) return;
      this.#start().catch(() => {});
    }, delay);
  }

  /**
   * End an attempt: its ports stay in the deny set until both children
   * have exited (or been SIGKILLed after the grace).
   */
  async #retire(attempt: Attempt): Promise<void> {
    this.#retiring.add(attempt);
    try {
      await this.#teardown(attempt.session, attempt.forward);
    } finally {
      this.#retiring.delete(attempt);
    }
  }

  /** Resolves true once `child` has exited, false after `ms`. */
  #waitExit(child: SshChild, ms: number): Promise<boolean> {
    if (this.#exited.has(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const handle = this.#o.setTimer(() => {
        if (done) return;
        done = true;
        resolve(this.#exited.has(child));
      }, ms);
      child.onExit(() => {
        if (done) return;
        done = true;
        this.#o.clearTimer(handle);
        resolve(true);
      });
    });
  }

  /**
   * End the session by closing its stdin (the host program then stops the
   * hub), kill the forward, and wait for both: SIGTERM, then SIGKILL.
   */
  async #teardown(
    session: SshChild | undefined,
    forward: SshChild | undefined,
  ): Promise<void> {
    const end = async (child: SshChild, gentle: () => void) => {
      if (!this.#exited.has(child)) {
        gentle();
        if (!(await this.#waitExit(child, STOP_GRACE_MS))) {
          child.kill('SIGTERM');
          if (!(await this.#waitExit(child, STOP_GRACE_MS))) {
            child.kill('SIGKILL');
            await this.#waitExit(child, STOP_GRACE_MS);
          }
        }
      }
      child.release();
    };
    await Promise.all([
      forward ? end(forward, () => forward.kill('SIGTERM')) : undefined,
      session
        ? end(session, () => {
            try {
              session.stdin?.end();
            } catch {
              // Already closed.
            }
          })
        : undefined,
    ]);
  }
}
