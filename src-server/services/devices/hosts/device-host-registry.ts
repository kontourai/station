/**
 * SSH device hosts, composed (#1973, D11, D13).
 *
 * One {@link SshDeviceHub} per stored host, built lazily and torn down when
 * the host is removed, re-targeted or disabled. The registry answers:
 *
 * - `endpoint(hostId)`: the `DeviceHubEndpoint` the device services use, the
 *   same shape the local hub has. `connect()` starts the host's hub on
 *   demand, but only once the operator enabled it there (that consent is
 *   what lets an admin opening a shared device start it, as D12 says for the
 *   local hub).
 * - `check(hostId)`: the step-by-step "Test connection".
 * - `install(hostId)`: sends Station's own verified hub tree to the host.
 * - `listeningPorts()`: every forward and host hub port, for the host
 *   browser's Station-listener deny set.
 * - `resolveAndroidAvd(hostId, serial)`: the AVD an emulator serial runs on
 *   THAT host (D12 shares are keyed by AVD name).
 */
import { createHash } from 'node:crypto';
import type {
  DeviceHostCheckResult,
  DeviceHostCheckStep,
  DeviceHostSummary,
  DeviceSshHost,
  DeviceSshHostFailure,
  DeviceSshHostView,
  DeviceSshInstallState,
} from '@kontourai/station-contracts/mobile-device';
import type {
  DeviceHubConnectResult,
  DeviceHubEndpoint,
} from '../device-hub-endpoint.js';
import { DeviceHostBusyError } from '../device-shares.js';
import type { DeviceHubConnection } from '../toolchain/device-hub-connection.js';
import { DEVICE_TOOL_PINS } from '../toolchain/device-tool-pins.js';
import type { DeviceHostStore } from './device-host-store.js';
import { SshDeviceHub, type SshDeviceHubOptions } from './ssh-device-hub.js';
import {
  createHubBundleCache,
  type HubBundle,
  writeHubBundle,
} from './ssh-device-hub-bundle.js';
import { runSshDeviceScript, type SpawnSsh } from './ssh-device-session.js';
import { parseSshDeviceTarget } from './ssh-device-target.js';

const PROBE_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const AVD_TIMEOUT_MS = 15_000;
const AVD_CACHE_MS = 5_000;
/** Concurrent AVD lookups (each one an ssh process) per host (M1). */
const MAX_AVD_LOOKUPS_PER_HOST = 2;
/** AVD answers kept, all hosts together (M1). */
const MAX_AVD_CACHE = 64;
/**
 * Lookups waiting for a slot on one host (D2), and how long one may wait.
 * Beyond either, the lookup fails TYPED and transient (`DeviceHostBusyError`
 * → 503 `device-host-busy`), never as a refusal.
 */
const MAX_AVD_QUEUE_PER_HOST = 16;
const AVD_QUEUE_WAIT_MS = 20_000;

/** Station's own verified hub install, if there is one. */
export interface LocalHubInstall {
  installDir: string;
  version: string;
}

export interface DeviceHostRegistryOptions {
  stationHome: string;
  store: DeviceHostStore;
  localHub: () => LocalHubInstall | undefined;
  spawn?: SpawnSsh;
  /** Test seam: build a hub from the options the registry derived. */
  createHub?: (options: SshDeviceHubOptions) => SshDeviceHub;
  bundle?: (installDir: string, version: string) => HubBundle;
  now?: () => Date;
  /**
   * Withdraw every device share on this host (M2): a share names a device
   * by UDID or AVD name, which says nothing once the host is another
   * machine (retargeted) or gone (removed).
   */
  dropShares?: (hostId: string) => void;
}

export class DeviceHostError extends Error {
  constructor(readonly code: 'not-found' | 'consent-required') {
    super(`Device host refused: ${code}.`);
    this.name = 'DeviceHostError';
  }
}

export class DeviceHostRegistry {
  readonly #o: DeviceHostRegistryOptions;
  readonly #hubs = new Map<string, { hub: SshDeviceHub; sshTarget: string }>();
  readonly #installs = new Map<string, DeviceSshInstallState>();
  readonly #installing = new Map<string, Promise<void>>();
  /**
   * Bumped whenever a host's install can no longer apply (retarget,
   * removal, disable): a late completion from an older generation is
   * ignored, and its ssh child is killed (M3).
   */
  readonly #generations = new Map<string, number>();
  readonly #installAbort = new Map<string, AbortController>();
  readonly #avdInflight = new Map<string, Promise<string | undefined>>();
  readonly #avdActive = new Map<string, number>();
  /**
   * Per-host FIFO of lookups waiting for a slot (D2). A waiter is granted
   * (`true`) or flushed (`false`: the host changed or Station is shutting
   * down, N1) — never left to run against a host that is no longer it.
   */
  readonly #avdQueue = new Map<string, Array<(granted: boolean) => void>>();
  /** In-flight AVD lookups' cancel handles, by host (L-e, N1). */
  readonly #avdAbort = new Map<AbortController, string>();
  /** Set by shutdown(): no new hub, install or lookup starts after it (N2). */
  #closed = false;
  /**
   * Hubs being stopped after a retarget or removal (L-a): their ports stay
   * in the deny set until `stop()` resolves, i.e. until the children exit.
   */
  readonly #retiringHubs = new Set<SshDeviceHub>();
  readonly #avdCache = new Map<
    string,
    { at: number; avd: string | undefined }
  >();
  readonly #bundle: (installDir: string, version: string) => HubBundle;
  readonly #exitListeners = new Map<string, Set<(reason: string) => void>>();
  /** Connections whose exit is already relayed to the endpoint's listeners. */
  readonly #watched = new WeakSet<object>();

  constructor(options: DeviceHostRegistryOptions) {
    this.#o = options;
    this.#bundle = options.bundle ?? createHubBundleCache();
  }

  get store(): DeviceHostStore {
    return this.#o.store;
  }

  /** 24 hex, stable per Station home and host: this Station's state on the host. */
  ownerKey(hostId: string): string {
    return createHash('sha256')
      .update(`${this.#o.stationHome}\0${hostId}`)
      .digest('hex')
      .slice(0, 24);
  }

  /** The verified local tree, as the host must have it; undefined without one. */
  #launch(): { version: string; digest: string } | undefined {
    const local = this.#o.localHub();
    if (!local) return undefined;
    try {
      const bundle = this.#bundle(local.installDir, local.version);
      return { version: bundle.version, digest: bundle.digest };
    } catch {
      return undefined;
    }
  }

  /** The hub for a stored host (built on first use), or undefined. */
  hub(hostId: string): SshDeviceHub | undefined {
    if (this.#closed) return undefined;
    const host = this.#o.store.get(hostId);
    if (!host) return undefined;
    const existing = this.#hubs.get(hostId);
    if (existing && existing.sshTarget === host.sshTarget) return existing.hub;
    if (existing) void this.#retire(existing.hub);
    const options: SshDeviceHubOptions = {
      hostId,
      owner: this.ownerKey(hostId),
      target: () =>
        parseSshDeviceTarget(
          this.#o.store.get(hostId)?.sshTarget ?? host.sshTarget,
        ),
      enabled: () => this.#o.store.get(hostId)?.hubEnabled === true,
      resolveLaunch: () => this.#launch(),
      // M4: the host lost (or never had) THIS Station's verified hub, e.g.
      // the pinned version or digest changed: send it again (consent stands).
      reinstall: async () => {
        await this.install(hostId);
        return this.#install(hostId).state === 'installed';
      },
      ...(this.#o.spawn ? { spawn: this.#o.spawn } : {}),
    };
    const hub = this.#o.createHub?.(options) ?? new SshDeviceHub(options);
    this.#hubs.set(hostId, { hub, sshTarget: host.sshTarget });
    return hub;
  }

  /** Every port an SSH device host's hub uses on or through this machine. */
  listeningPorts(): number[] {
    const ports = new Set<number>();
    for (const hub of [
      ...[...this.#hubs.values()].map((entry) => entry.hub),
      ...this.#retiringHubs,
    ])
      for (const port of hub.listeningPorts()) ports.add(port);
    return [...ports].sort((a, b) => a - b);
  }

  #install(hostId: string): DeviceSshInstallState {
    return this.#installs.get(hostId) ?? { state: 'unknown' };
  }

  views(): DeviceSshHostView[] {
    return this.#o.store.list().map((host) => this.#view(host));
  }

  view(hostId: string): DeviceSshHostView | undefined {
    const host = this.#o.store.get(hostId);
    return host ? this.#view(host) : undefined;
  }

  #view(host: DeviceSshHost): DeviceSshHostView {
    const hub = this.#hubs.get(host.hostId)?.hub;
    return {
      ...host,
      hub: hub?.state() ?? { state: 'stopped' },
      install: this.#install(host.hostId),
    };
  }

  /** The Device pane's host picker: labels only, never an ssh target. */
  summaries(): DeviceHostSummary[] {
    return this.#o.store.list().map((host) => ({
      hostId: host.hostId,
      label: host.label,
      kind: 'ssh' as const,
      hub: this.#hubs.get(host.hostId)?.hub.state() ?? { state: 'stopped' },
    }));
  }

  add(input: { label: unknown; sshTarget: unknown }): DeviceSshHostView {
    return this.#view(this.#o.store.add(input));
  }

  async update(
    hostId: string,
    input: { label?: unknown; sshTarget?: unknown },
  ): Promise<DeviceSshHostView> {
    const before = this.#o.store.get(hostId);
    const after = this.#o.store.update(hostId, input);
    if (before && before.sshTarget !== after.sshTarget)
      await this.#drop(hostId);
    return this.#view(after);
  }

  async remove(hostId: string): Promise<void> {
    this.#o.store.remove(hostId);
    await this.#drop(hostId);
  }

  #generation(hostId: string): number {
    return this.#generations.get(hostId) ?? 0;
  }

  /**
   * Invalidate the host's install in flight: ignore it, kill its ssh, and
   * stop reporting it as `installing` (L-d).
   */
  #bump(hostId: string): void {
    this.#generations.set(hostId, this.#generation(hostId) + 1);
    this.#installAbort.get(hostId)?.abort();
    this.#installAbort.delete(hostId);
    this.#installing.delete(hostId);
    if (this.#installs.get(hostId)?.state === 'installing')
      this.#installs.delete(hostId);
    // N1: AVD lookups for what this host WAS: queued ones are flushed
    // unrun, running ones killed, and none may be joined or cached.
    for (const waiter of this.#avdQueue.get(hostId)?.splice(0) ?? [])
      waiter(false);
    this.#avdQueue.delete(hostId);
    for (const [abort, owner] of [...this.#avdAbort])
      if (owner === hostId) {
        abort.abort();
        this.#avdAbort.delete(abort);
      }
    for (const key of [...this.#avdInflight.keys()])
      if (key.startsWith(`${hostId}\0`)) this.#avdInflight.delete(key);
  }

  /** Stop a hub whose ports stay denied until it has stopped (L-a). */
  async #retire(hub: SshDeviceHub): Promise<void> {
    this.#retiringHubs.add(hub);
    try {
      await hub.stop();
    } finally {
      this.#retiringHubs.delete(hub);
    }
  }

  /**
   * The host is now another machine, or gone: its hub stops, its install
   * and consent-bearing state are forgotten, and its device shares are
   * withdrawn (M2 — in the same place consent is withdrawn).
   */
  async #drop(hostId: string): Promise<void> {
    this.#bump(hostId);
    this.#o.dropShares?.(hostId);
    const entry = this.#hubs.get(hostId);
    this.#hubs.delete(hostId);
    this.#installs.delete(hostId);
    for (const key of this.#avdCache.keys())
      if (key.startsWith(`${hostId}\0`)) this.#avdCache.delete(key);
    if (entry) await this.#retire(entry.hub);
  }

  /**
   * Enable (consent `true` required: installs onto and runs a process on the
   * host) or disable the hub there. Enabling starts the install in the
   * background; disabling stops a running hub.
   */
  async setHubEnabled(
    hostId: string,
    request: { enabled: boolean; consent?: unknown },
  ): Promise<DeviceSshHostView> {
    if (!this.#o.store.get(hostId)) throw new DeviceHostError('not-found');
    if (!request.enabled) {
      this.#o.store.setHubEnabled(hostId, false);
      this.#bump(hostId);
      await this.#hubs.get(hostId)?.hub.stop();
      return this.#view(this.#o.store.get(hostId)!);
    }
    if (request.consent !== true) throw new DeviceHostError('consent-required');
    this.#o.store.setHubEnabled(hostId, true);
    void this.install(hostId);
    return this.#view(this.#o.store.get(hostId)!);
  }

  /** Send the verified hub to the host. Resolves when it ends either way. */
  install(hostId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const pending = this.#installing.get(hostId);
    if (pending) return pending;
    const run = this.#runInstall(hostId).finally(() => {
      if (this.#installing.get(hostId) === run) this.#installing.delete(hostId);
    });
    this.#installing.set(hostId, run);
    return run;
  }

  async #runInstall(hostId: string): Promise<void> {
    const generation = this.#generation(hostId);
    const host = this.#o.store.get(hostId);
    if (!host?.hubEnabled) {
      this.#installs.set(hostId, {
        state: 'failed',
        failure: 'hub-not-enabled',
      });
      return;
    }
    const local = this.#o.localHub();
    let bundle: HubBundle | undefined;
    try {
      bundle = local
        ? this.#bundle(local.installDir, local.version)
        : undefined;
    } catch {
      bundle = undefined;
    }
    if (!bundle) {
      this.#installs.set(hostId, {
        state: 'failed',
        failure: 'local-hub-not-installed',
      });
      return;
    }
    const verified = bundle;
    const abort = new AbortController();
    this.#installAbort.set(hostId, abort);
    this.#installs.set(hostId, { state: 'installing' });
    const result = await runSshDeviceScript({
      signal: abort.signal,
      target: parseSshDeviceTarget(host.sshTarget),
      params: {
        mode: 'install',
        version: bundle.version,
        digest: bundle.digest,
        files: bundle.files,
      },
      payload: (stdin) => writeHubBundle(verified, stdin),
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(this.#o.spawn ? { spawn: this.#o.spawn } : {}),
    });
    if (this.#installAbort.get(hostId) === abort)
      this.#installAbort.delete(hostId);
    // M3: a completion for a machine this host no longer is, or for an
    // install that was cancelled, says nothing about the host now.
    if (
      this.#generation(hostId) !== generation ||
      this.#o.store.get(hostId)?.sshTarget !== host.sshTarget
    )
      return;
    const installed = result.events.some(
      (event) => event.event === 'installed',
    );
    this.#installs.set(
      hostId,
      installed && !result.failure
        ? { state: 'installed' }
        : { state: 'failed', failure: result.failure ?? 'install-failed' },
    );
  }

  has(hostId: string): boolean {
    return this.#o.store.get(hostId) !== undefined;
  }

  readonly #endpoints = new Map<string, DeviceHubEndpoint>();

  /** The device-host endpoint for an SSH host (see the module docblock). */
  endpoint(hostId: string): DeviceHubEndpoint {
    let endpoint = this.#endpoints.get(hostId);
    if (!endpoint) {
      endpoint = this.#createEndpoint(hostId);
      this.#endpoints.set(hostId, endpoint);
    }
    return endpoint;
  }

  #createEndpoint(hostId: string): DeviceHubEndpoint {
    return {
      connect: async (): Promise<DeviceHubConnectResult> => {
        const host = this.#o.store.get(hostId);
        if (!host) return { ok: false, failure: 'not-configured' };
        if (!host.hubEnabled) return { ok: false, failure: 'not-configured' };
        const hub = this.hub(hostId);
        if (!hub) return { ok: false, failure: 'not-configured' };
        try {
          const connection = await hub.ensureStarted();
          if (!this.#watched.has(connection)) {
            this.#watched.add(connection);
            connection.onExit((reason) => {
              for (const listener of [
                ...(this.#exitListeners.get(hostId) ?? []),
              ])
                listener(reason);
            });
          }
          return { ok: true, connection };
        } catch {
          return { ok: false, failure: 'hub-unavailable' };
        }
      },
      onExit: (listener) => {
        const set = this.#exitListeners.get(hostId) ?? new Set();
        set.add(listener);
        this.#exitListeners.set(hostId, set);
        return () => set.delete(listener);
      },
    };
  }

  /**
   * The host's running hub connection for the proxy, started on demand once
   * the operator enabled it there; undefined otherwise.
   */
  async ensureHub(hostId: string): Promise<DeviceHubConnection | undefined> {
    if (this.#o.store.get(hostId)?.hubEnabled !== true) return undefined;
    return this.hub(hostId)
      ?.ensureStarted()
      .catch(() => undefined);
  }

  /** The operator's "Start" / "Retry" for a host's hub. */
  async startHub(hostId: string): Promise<DeviceSshHostView> {
    const hub = this.hub(hostId);
    if (!hub) throw new DeviceHostError('not-found');
    await hub.ensureStarted().catch(() => undefined);
    return this.#view(this.#o.store.get(hostId)!);
  }

  /** The step-by-step "Test connection". Starts nothing; installs nothing. */
  async check(hostId: string): Promise<DeviceHostCheckResult> {
    if (this.#closed) throw new DeviceHostError('not-found');
    const host = this.#o.store.get(hostId);
    if (!host) throw new DeviceHostError('not-found');
    const checkedAt = (this.#o.now?.() ?? new Date()).toISOString();
    const launch = this.#launch();
    const run = await runSshDeviceScript({
      target: parseSshDeviceTarget(host.sshTarget),
      params: {
        mode: 'probe',
        owner: this.ownerKey(hostId),
        version: launch?.version ?? DEVICE_TOOL_PINS['expo-device-hub'].version,
        digest: launch?.digest ?? null,
      },
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(this.#o.spawn ? { spawn: this.#o.spawn } : {}),
    });
    const probe = run.events.find((event) => event.event === 'probe');
    return checkResult(hostId, checkedAt, run.failure, probe, {
      hubRunning: this.#hubs.get(hostId)?.hub.state().state === 'running',
      localInstalled: launch !== undefined,
    });
  }

  /** The AVD running on `serial` on this host, or undefined (refuse). */
  async resolveAndroidAvd(
    hostId: string,
    serial: string,
  ): Promise<string | undefined> {
    if (!/^emulator-[0-9]{1,5}$/.test(serial)) return undefined;
    if (this.#closed) return undefined;
    const host = this.#o.store.get(hostId);
    // M1: no ssh at all on a host the operator has not enabled — an admin's
    // request must not be what first opens a connection to a machine.
    if (host?.hubEnabled !== true) return undefined;
    const key = `${hostId}\0${serial}`;
    const hit = this.#avdCache.get(key);
    if (hit && Date.now() - hit.at < AVD_CACHE_MS) return hit.avd;
    // Concurrent lookups of one serial share one ssh run…
    const pending = this.#avdInflight.get(key);
    if (pending) return pending;
    // …and a host runs at most a few at once; the rest wait their turn in a
    // bounded queue (D2). A share must not read as "not shared" because the
    // host was briefly busy.
    const sshTarget = host.sshTarget;
    const generation = this.#generation(hostId);
    /** The host is still the one this lookup was asked about (N1). */
    const stillSame = () =>
      !this.#closed &&
      this.#generation(hostId) === generation &&
      this.#o.store.get(hostId)?.hubEnabled === true &&
      this.#o.store.get(hostId)?.sshTarget === sshTarget;
    const lookup = (async () => {
      if (!(await this.#avdSlot(hostId))) return undefined;
      try {
        // Re-checked AFTER the wait: consent, target or Station may have
        // changed while this lookup was queued.
        if (!stillSame()) return undefined;
        return await this.#lookupAvd(hostId, sshTarget, serial);
      } finally {
        this.#releaseAvdSlot(hostId);
      }
    })().finally(() => {
      if (this.#avdInflight.get(key) === lookup) this.#avdInflight.delete(key);
    });
    this.#avdInflight.set(key, lookup);
    const avd = await lookup;
    // An answer about a machine this host no longer is is never cached.
    if (!stillSame()) return undefined;
    this.#avdCache.delete(key);
    this.#avdCache.set(key, { at: Date.now(), avd });
    // Bounded: drop the oldest answers first.
    while (this.#avdCache.size > MAX_AVD_CACHE) {
      const oldest = this.#avdCache.keys().next().value;
      if (oldest === undefined) break;
      this.#avdCache.delete(oldest);
    }
    return avd;
  }

  /**
   * Wait for one of the host's lookup slots (D2): bounded queue and wait.
   * Resolves true with a slot held, or false (no slot) when flushed (N1).
   */
  #avdSlot(hostId: string): Promise<boolean> {
    const active = this.#avdActive.get(hostId) ?? 0;
    if (active < MAX_AVD_LOOKUPS_PER_HOST) {
      this.#avdActive.set(hostId, active + 1);
      return Promise.resolve(true);
    }
    const queue = this.#avdQueue.get(hostId) ?? [];
    if (queue.length >= MAX_AVD_QUEUE_PER_HOST)
      return Promise.reject(new DeviceHostBusyError());
    this.#avdQueue.set(hostId, queue);
    return new Promise((resolve, reject) => {
      const waiter = (granted: boolean) => {
        clearTimeout(timer);
        resolve(granted);
      };
      const timer = setTimeout(() => {
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        reject(new DeviceHostBusyError());
      }, AVD_QUEUE_WAIT_MS);
      timer.unref?.();
      queue.push(waiter);
    });
  }

  /** Hand the slot to the next waiter, or free it. */
  #releaseAvdSlot(hostId: string): void {
    const next = this.#avdQueue.get(hostId)?.shift();
    if (next) {
      next(true);
      return;
    }
    this.#avdQueue.delete(hostId);
    const left = (this.#avdActive.get(hostId) ?? 1) - 1;
    if (left > 0) this.#avdActive.set(hostId, left);
    else this.#avdActive.delete(hostId);
  }

  async #lookupAvd(
    hostId: string,
    sshTarget: string,
    serial: string,
  ): Promise<string | undefined> {
    const abort = new AbortController();
    this.#avdAbort.set(abort, hostId);
    const run = await runSshDeviceScript({
      target: parseSshDeviceTarget(sshTarget),
      params: { mode: 'avd', serial },
      timeoutMs: AVD_TIMEOUT_MS,
      signal: abort.signal,
      ...(this.#o.spawn ? { spawn: this.#o.spawn } : {}),
    }).finally(() => this.#avdAbort.delete(abort));
    const event = run.events.find((candidate) => candidate.event === 'avd');
    const avd =
      !run.failure &&
      typeof event?.avd === 'string' &&
      /^[A-Za-z0-9._-]{1,128}$/.test(event.avd)
        ? event.avd
        : undefined;
    return avd;
  }

  /**
   * Stop everything (L-e): hubs, installs in flight (their ssh killed, via
   * the generation bump) and AVD lookups, so no child and no timer outlives
   * the server.
   */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const hostId of new Set([
      ...this.#avdQueue.keys(),
      ...this.#avdAbort.values(),
      ...this.#generations.keys(),
      ...this.#installAbort.keys(),
      ...this.#o.store.list().map((host) => host.hostId),
    ]))
      this.#bump(hostId);
    for (const abort of [...this.#avdAbort.keys()]) abort.abort();
    this.#avdAbort.clear();
    await Promise.allSettled([
      ...[...this.#hubs.values()].map(({ hub }) => hub.stop()),
      ...[...this.#retiringHubs].map((hub) => hub.stop()),
    ]);
    this.#hubs.clear();
  }
}

const HOST_KEY_FAILURES: ReadonlySet<DeviceSshHostFailure> = new Set([
  'host-key-unverified',
  'host-key-changed',
]);

/** Map a probe run onto the ordered steps the Settings check shows. */
function checkResult(
  hostId: string,
  checkedAt: string,
  failure: DeviceSshHostFailure | undefined,
  probe: Record<string, unknown> | undefined,
  local: { hubRunning: boolean; localInstalled: boolean },
): DeviceHostCheckResult {
  const skipped = (id: DeviceHostCheckStep['id']): DeviceHostCheckStep => ({
    id,
    state: 'skipped',
  });
  const rest = (from: DeviceHostCheckStep['id'][]) => from.map(skipped);
  const after = [
    'node',
    'ios',
    'android',
    'hub-installed',
    'hub-running',
  ] as const;
  if (!probe || failure) {
    const why = failure ?? 'protocol';
    if (HOST_KEY_FAILURES.has(why))
      return {
        hostId,
        checkedAt,
        ok: false,
        failure: why,
        steps: [
          { id: 'ssh', state: 'pass', detail: 'The host answered.' },
          { id: 'host-key', state: 'fail' },
          ...rest([...after]),
        ],
      };
    if (why === 'node-missing' || why === 'unsupported-node')
      return {
        hostId,
        checkedAt,
        ok: false,
        failure: why,
        steps: [
          { id: 'ssh', state: 'pass' },
          { id: 'host-key', state: 'pass' },
          { id: 'node', state: 'fail' },
          ...rest(['ios', 'android', 'hub-installed', 'hub-running']),
        ],
      };
    return {
      hostId,
      checkedAt,
      ok: false,
      failure: why,
      steps: [
        { id: 'ssh', state: 'fail' },
        why === 'auth-failed'
          ? { id: 'host-key', state: 'pass' }
          : skipped('host-key'),
        ...rest([...after]),
      ],
    };
  }
  const node = typeof probe.node === 'string' ? probe.node.slice(0, 32) : '';
  const nodeOk = probe.nodeOk === true;
  const ios = probe.ios === true;
  const android = probe.android === true;
  const hubInstalled = probe.hubInstalled === true;
  const steps: DeviceHostCheckStep[] = [
    { id: 'ssh', state: 'pass' },
    { id: 'host-key', state: 'pass' },
    nodeOk
      ? {
          id: 'node',
          state: 'pass',
          detail: /^[0-9.]+$/.test(node) ? `Node ${node}` : undefined,
        }
      : {
          id: 'node',
          state: 'fail',
          detail: 'Node.js 22 or newer is required.',
        },
    ios
      ? { id: 'ios', state: 'pass' }
      : {
          id: 'ios',
          state: 'warn',
          detail: 'Xcode simulators were not found (macOS only).',
        },
    android
      ? { id: 'android', state: 'pass' }
      : {
          id: 'android',
          state: 'warn',
          detail: 'adb was not found on the ssh PATH.',
        },
    hubInstalled
      ? { id: 'hub-installed', state: 'pass' }
      : {
          id: 'hub-installed',
          state: 'warn',
          detail: local.localInstalled
            ? 'Not installed yet. Enable the hub to install it.'
            : 'Set up devices on this Station first.',
        },
    local.hubRunning
      ? { id: 'hub-running', state: 'pass' }
      : { id: 'hub-running', state: 'warn', detail: 'Not running.' },
  ].map((step) =>
    step.detail === undefined ? { id: step.id, state: step.state } : step,
  ) as DeviceHostCheckStep[];
  const ok = nodeOk && (ios || android);
  return {
    hostId,
    checkedAt,
    ok,
    ...(!nodeOk ? { failure: 'unsupported-node' as const } : {}),
    steps,
  };
}
