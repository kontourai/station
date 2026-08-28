import { spawn } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import {
  createSystemOpenSshRunner,
  type OpenSshCommandRunner,
  type ResolvedOpenSshHost,
  redactOpenSshArgs,
  requireOpenSshAlias,
  resolveOpenSshHost,
} from './openssh-config.js';
import {
  createSystemOpenSshLaunchRunner,
  type OpenSshLaunchResult,
  type OpenSshLaunchRunner,
} from './openssh-launch-bootstrap.js';
import {
  createSystemOpenSshWorkerProbeRunner,
  type OpenSshWorkerProbeResult,
  type OpenSshWorkerProbeRunner,
} from './openssh-worker-probe.js';

export type OpenSshTunnelState =
  | { phase: 'idle' }
  | { phase: 'starting'; attempt: number }
  | {
      phase: 'prompt';
      prompt: 'password' | 'passphrase' | 'security-key';
    }
  | {
      phase: 'host-key';
      reason: 'confirmation-required' | 'changed';
    }
  | { phase: 'agent'; reason: 'unavailable' | 'rejected' }
  | {
      phase: 'connected';
      localUrl: string;
      host: ResolvedOpenSshHost;
    }
  | {
      phase: 'unavailable';
      reason: 'ssh-not-found' | 'config' | 'forward' | 'timeout';
    }
  | {
      phase: 'disconnected';
      reason: 'remote-closed' | 'transport-error' | 'stopped';
    };

export interface OpenSshTunnelOptions {
  alias: string;
  remotePort: number;
  onStateChange?: (state: OpenSshTunnelState) => void;
  connectTimeoutMs?: number;
  maxForwardAttempts?: number;
}

interface OpenSshProcess {
  readonly stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

type SpawnOpenSsh = (args: readonly string[]) => OpenSshProcess;
type ReserveLoopbackPort = () => Promise<number>;
type CreateControlDirectory = () => Promise<string>;

interface OpenSshAdapterDependencies {
  run?: OpenSshCommandRunner;
  spawn?: SpawnOpenSsh;
  reservePort?: ReserveLoopbackPort;
  createControlDirectory?: CreateControlDirectory;
  removeControlDirectory?: (directory: string) => Promise<void>;
  probeWorker?: OpenSshWorkerProbeRunner;
  runLaunchBootstrap?: OpenSshLaunchRunner;
  pollIntervalMs?: number;
}

type DiagnosticState = Exclude<
  OpenSshTunnelState,
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'connected' }
  | { phase: 'disconnected' }
>;

function safeRemotePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Remote Station port must be between 1 and 65535');
  }
  return value;
}

export function buildOpenSshMasterArgs(input: {
  alias: string;
  controlPath: string;
}): string[] {
  const alias = requireOpenSshAlias(input.alias);
  return [
    '-M',
    '-S',
    input.controlPath,
    '-N',
    '-T',
    '-o',
    'ControlMaster=yes',
    '-o',
    'ControlPersist=no',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'PermitLocalCommand=no',
    // Station is never a trust writer. Without these two, the master
    // connection inherits the operator's ambient policy — and under the
    // common `StrictHostKeyChecking=accept-new` (or `no`) OpenSSH silently
    // accepts and RECORDS the key of a host nobody confirmed. The probe has
    // pinned this since the host-key fix; the master session is the one that
    // actually opens a shell, so it has to fail closed on the same terms.
    // The known_hosts LOCATION is deliberately not overridden: an operator's
    // configured `UserKnownHostsFile` is their trust store, and replacing it
    // here would reject hosts they legitimately confirmed.
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'RemoteCommand=none',
    '-o',
    'SessionType=none',
    '-o',
    'Tunnel=no',
    '-o',
    'ClearAllForwardings=yes',
    '--',
    alias,
  ];
}

export function buildOpenSshForwardArgs(input: {
  alias: string;
  controlPath: string;
  localPort: number;
  remotePort: number;
}): string[] {
  const alias = requireOpenSshAlias(input.alias);
  const localPort = safeRemotePort(input.localPort);
  const remotePort = safeRemotePort(input.remotePort);
  return [
    '-S',
    input.controlPath,
    '-O',
    'forward',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ClearAllForwardings=no',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    alias,
  ];
}

export function classifyOpenSshDiagnostic(
  diagnostic: string,
): DiagnosticState | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) {
    return { phase: 'host-key', reason: 'changed' };
  }
  if (
    /authenticity of host .* can't be established|are you sure you want to continue connecting|host key verification failed/i.test(
      diagnostic,
    )
  ) {
    return { phase: 'host-key', reason: 'confirmation-required' };
  }
  if (/enter passphrase for key/i.test(diagnostic)) {
    return { phase: 'prompt', prompt: 'passphrase' };
  }
  if (/password:\s*$/im.test(diagnostic)) {
    return { phase: 'prompt', prompt: 'password' };
  }
  if (
    /confirm user presence|touch your authenticator|security key/i.test(
      diagnostic,
    )
  ) {
    return { phase: 'prompt', prompt: 'security-key' };
  }
  if (
    /could not open a connection to your authentication agent|agent not present|communication with agent failed|authentication agent.*(?:no such file|unavailable)/i.test(
      diagnostic,
    )
  ) {
    return { phase: 'agent', reason: 'unavailable' };
  }
  if (/agent refused operation|signing failed.*agent/i.test(diagnostic)) {
    return { phase: 'agent', reason: 'rejected' };
  }
  if (/address already in use|cannot listen to port/i.test(diagnostic)) {
    return { phase: 'unavailable', reason: 'forward' };
  }
  return null;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('Could not reserve a loopback port'));
        return;
      }
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(address.port);
      });
    });
  });
}

async function createPrivateControlDirectory(): Promise<string> {
  const uid = process.getuid?.();
  const directory = await createStationTempDir(`ssh-${uid ?? 'user'}`);
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o77) !== 0
  ) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Could not create a private OpenSSH control directory');
  }
  return directory;
}

function spawnSystemOpenSsh(args: readonly string[]): OpenSshProcess {
  return spawn('ssh', [...args], {
    // OpenSSH owns authentication. In terminal-launched Station instances this
    // preserves normal password, key, and host confirmation behavior; desktop
    // hosts can provide SSH_ASKPASS without Station ever handling key material.
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

interface TunnelOperation {
  cancelled: boolean;
  process: OpenSshProcess | null;
  controlDirectory: string | null;
  controlPath: string | null;
  diagnostic: string;
  closed: boolean;
  closeCode: number | null;
  spawnError: Error | null;
  host: ResolvedOpenSshHost | null;
}

function createTunnelOperation(): TunnelOperation {
  return {
    cancelled: false,
    process: null,
    controlDirectory: null,
    controlPath: null,
    diagnostic: '',
    closed: false,
    closeCode: null,
    spawnError: null,
    host: null,
  };
}

export class OpenSshTunnel {
  private stateValue: OpenSshTunnelState = { phase: 'idle' };
  private operation: TunnelOperation | null = null;
  private startPromise: Promise<OpenSshTunnelState> | null = null;
  /**
   * archive#1133 live-verification finding (BLOCKER): the port the worker
   * probe should check ON THE REMOTE HOST. Starts as `options.remotePort`
   * and is updated by `retarget()` — a managed launch's `-L` forward moving
   * to a new local port is only half of "point at the launched port";
   * `probeWorker` independently tells the REMOTE probe script which port to
   * self-check, and an earlier revision left that argument permanently
   * pinned to the tunnel's original construction-time `options.remotePort`,
   * so a retargeted connect kept probing the profile's configured port
   * (where nothing was listening) even after `station start` had genuinely
   * launched Station on a different port. `runLaunchBootstrap`'s
   * `targetPort` is a distinct concept (the fixed port to check for an
   * already-running *unmanaged* Station) and deliberately still reads
   * `options.remotePort` directly, never this field.
   */
  private activeRemotePort: number;

  constructor(
    private readonly options: OpenSshTunnelOptions,
    private readonly dependencies: Required<OpenSshAdapterDependencies>,
  ) {
    this.activeRemotePort = options.remotePort;
  }

  get state(): OpenSshTunnelState {
    return this.stateValue;
  }

  private transition(state: OpenSshTunnelState): void {
    this.stateValue = state;
    this.options.onStateChange?.(state);
  }

  start(): Promise<OpenSshTunnelState> {
    if (this.startPromise) return this.startPromise;
    if (this.operation) return Promise.resolve(this.state);
    const operation = createTunnelOperation();
    this.operation = operation;
    const promise = this.startOperation(operation).finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    this.startPromise = promise;
    return promise;
  }

  async probeWorker(
    remoteProjectPath: string,
  ): Promise<OpenSshWorkerProbeResult> {
    const operation = this.operation;
    if (
      !operation ||
      !this.isMasterRunning(operation) ||
      !operation.controlPath ||
      this.state.phase !== 'connected'
    ) {
      throw new Error('SSH environment is not connected');
    }
    const result = await this.dependencies.probeWorker({
      alias: this.options.alias,
      controlPath: operation.controlPath,
      remoteProjectPath,
      remotePort: this.activeRemotePort,
    });
    if (!this.isMasterRunning(operation)) {
      throw new Error(
        'SSH environment disconnected during worker verification',
      );
    }
    return result;
  }

  /**
   * archive#1133 R1/R3: runs the managed-launch bootstrap over the same
   * multiplexed control master used for the worker probe — no separate
   * authentication round trip. Only meaningful once `state.phase ===
   * 'connected'` (an initial forward already succeeded); the caller decides
   * whether to invoke this at all (only on a `station-unavailable` probe
   * failure for a `launchMode: 'managed'` profile).
   */
  async runLaunchBootstrap(input: {
    remoteProjectPath: string;
    launchKey: string;
  }): Promise<OpenSshLaunchResult> {
    const operation = this.operation;
    if (
      !operation ||
      !this.isMasterRunning(operation) ||
      !operation.controlPath ||
      this.state.phase !== 'connected'
    ) {
      throw new Error('SSH environment is not connected');
    }
    const result = await this.dependencies.runLaunchBootstrap({
      alias: this.options.alias,
      controlPath: operation.controlPath,
      remoteProjectPath: input.remoteProjectPath,
      launchKey: input.launchKey,
      targetPort: this.options.remotePort,
    });
    if (!this.isMasterRunning(operation)) {
      throw new Error('SSH environment disconnected during managed launch');
    }
    return result;
  }

  /**
   * archive#1133 R3: re-points the loopback forward at a different remote
   * port than the tunnel was originally created with — needed when a
   * managed launch picks its own free port rather than the profile's
   * configured `remotePort`. Adds a second `-L` binding on the same control
   * master (`ClearAllForwardings=no`, same as the initial forward) rather
   * than tearing anything down, and updates the published `connected`
   * state's `localUrl` in place. A no-op when the launched port already
   * matches the current forward.
   */
  async retarget(remotePort: number): Promise<OpenSshTunnelState> {
    safeRemotePort(remotePort);
    const operation = this.operation;
    if (
      !operation ||
      !this.isMasterRunning(operation) ||
      !operation.controlPath ||
      !operation.host ||
      this.state.phase !== 'connected'
    ) {
      throw new Error('SSH environment is not connected');
    }
    const maxAttempts = this.options.maxForwardAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this.isMasterRunning(operation)) {
        throw new Error('SSH environment disconnected during re-forwarding');
      }
      try {
        const localPort = await this.dependencies.reservePort();
        if (!this.isMasterRunning(operation)) {
          throw new Error('SSH environment disconnected during re-forwarding');
        }
        const forward = await this.dependencies.run(
          buildOpenSshForwardArgs({
            alias: this.options.alias,
            controlPath: operation.controlPath,
            localPort,
            remotePort,
          }),
        );
        if (!this.isMasterRunning(operation)) {
          throw new Error('SSH environment disconnected during re-forwarding');
        }
        if (forward.exitCode !== 0) continue;
        const localUrl = `http://127.0.0.1:${localPort}`;
        const current = this.state;
        if (current.phase === 'connected') {
          this.transition({ ...current, localUrl });
        }
        // The forward now reaches `remotePort`; probeWorker must ask the
        // remote script to check that same port, not the tunnel's original
        // construction-time options.remotePort (archive#1133 live-verified
        // blocker — see the activeRemotePort field doc comment).
        this.activeRemotePort = remotePort;
        return this.state;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Could not forward the launched remote Station port');
  }

  private async startOperation(
    operation: TunnelOperation,
  ): Promise<OpenSshTunnelState> {
    const host = await this.resolveHost(operation);
    if (!host) return this.state;
    if (!(await this.prepareControlDirectory(operation))) return this.state;
    if (!this.spawnMaster(operation)) return this.state;
    if (!(await this.waitForMaster(operation))) return this.state;
    return await this.establishForward(operation, host);
  }

  private isActive(operation: TunnelOperation): boolean {
    return this.operation === operation && !operation.cancelled;
  }

  private isMasterRunning(operation: TunnelOperation): boolean {
    return (
      this.isActive(operation) &&
      !operation.closed &&
      !operation.spawnError &&
      operation.process?.exitCode === null
    );
  }

  private async resolveHost(
    operation: TunnelOperation,
  ): Promise<ResolvedOpenSshHost | null> {
    try {
      const host = await resolveOpenSshHost(
        this.options.alias,
        this.dependencies.run,
      );
      if (!this.isActive(operation)) return null;
      return host;
    } catch (error) {
      if (!this.isActive(operation)) return null;
      this.transition({
        phase: 'unavailable',
        reason:
          error instanceof Error &&
          /unavailable|ENOENT|not found/i.test(error.message)
            ? 'ssh-not-found'
            : 'config',
      });
      await this.cleanupOperation(operation, false);
      return null;
    }
  }

  private async prepareControlDirectory(
    operation: TunnelOperation,
  ): Promise<boolean> {
    try {
      operation.controlDirectory =
        await this.dependencies.createControlDirectory();
      operation.controlPath = join(operation.controlDirectory, 'control.sock');
    } catch {
      if (!this.isActive(operation)) return false;
      this.transition({ phase: 'unavailable', reason: 'forward' });
      await this.cleanupOperation(operation, false);
      return false;
    }
    if (!this.isActive(operation)) {
      await this.cleanupOperation(operation, true);
      return false;
    }
    return true;
  }

  private spawnMaster(operation: TunnelOperation): boolean {
    this.transition({ phase: 'starting', attempt: 1 });
    try {
      operation.process = this.dependencies.spawn(
        buildOpenSshMasterArgs({
          alias: this.options.alias,
          controlPath: operation.controlPath ?? '',
        }),
      );
    } catch (error) {
      this.transition({
        phase: 'unavailable',
        reason:
          error instanceof Error && /ENOENT|not found/i.test(error.message)
            ? 'ssh-not-found'
            : 'forward',
      });
      void this.cleanupOperation(operation, false);
      return false;
    }
    operation.process.stderr.on('data', (chunk) =>
      this.captureDiagnostic(operation, chunk),
    );
    operation.process.once('error', (error) => {
      operation.spawnError = error;
    });
    operation.process.once('close', (code) => {
      operation.closed = true;
      operation.closeCode = code;
    });
    return true;
  }

  private async waitForMaster(operation: TunnelOperation): Promise<boolean> {
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 120_000);
    while (this.isMasterRunning(operation) && Date.now() < deadline) {
      try {
        const check = await this.dependencies.run([
          '-S',
          operation.controlPath ?? '',
          '-O',
          'check',
          '--',
          requireOpenSshAlias(this.options.alias),
        ]);
        if (!this.isMasterRunning(operation)) break;
        if (check.exitCode === 0) return true;
      } catch {
        // The control socket is not ready yet.
      }
      if (!this.isMasterRunning(operation)) break;
      await delay(this.dependencies.pollIntervalMs);
    }
    if (!this.isActive(operation)) {
      await this.cleanupOperation(operation, true);
      return false;
    }
    this.transition(this.masterFailureState(operation, deadline));
    await this.cleanupOperation(operation, true);
    return false;
  }

  private masterFailureState(
    operation: TunnelOperation,
    deadline: number,
  ): OpenSshTunnelState {
    const classified = classifyOpenSshDiagnostic(operation.diagnostic);
    if (classified) return classified;
    if (
      operation.spawnError &&
      /ENOENT|not found/i.test(operation.spawnError.message)
    ) {
      return { phase: 'unavailable', reason: 'ssh-not-found' };
    }
    return {
      phase: 'unavailable',
      reason: Date.now() >= deadline ? 'timeout' : 'forward',
    };
  }

  private async establishForward(
    operation: TunnelOperation,
    host: ResolvedOpenSshHost,
  ): Promise<OpenSshTunnelState> {
    const maxAttempts = this.options.maxForwardAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this.isMasterRunning(operation)) break;
      this.transition({ phase: 'starting', attempt });
      try {
        const localPort = await this.dependencies.reservePort();
        if (!this.isMasterRunning(operation)) break;
        const forward = await this.dependencies.run(
          buildOpenSshForwardArgs({
            alias: this.options.alias,
            controlPath: operation.controlPath ?? '',
            localPort,
            remotePort: this.options.remotePort,
          }),
        );
        if (!this.isMasterRunning(operation)) break;
        if (forward.exitCode !== 0) continue;
        this.connectOperation(operation, localPort, host);
        return this.state;
      } catch {
        // The ephemeral port may have been claimed after reservation. Retry.
      }
    }
    if (!this.isActive(operation)) {
      await this.cleanupOperation(operation, true);
      return this.state;
    }
    if (!this.isMasterRunning(operation)) {
      this.transition({
        phase: 'disconnected',
        reason:
          operation.closeCode === 255 ? 'transport-error' : 'remote-closed',
      });
      await this.cleanupOperation(operation, true);
      return this.state;
    }
    this.transition({ phase: 'unavailable', reason: 'forward' });
    await this.cleanupOperation(operation, true);
    return this.state;
  }

  private connectOperation(
    operation: TunnelOperation,
    localPort: number,
    host: ResolvedOpenSshHost,
  ): void {
    operation.host = host;
    operation.process?.once('close', (code) => {
      if (!this.isActive(operation)) return;
      this.transition({
        phase: 'disconnected',
        reason: code === 255 ? 'transport-error' : 'remote-closed',
      });
      void this.cleanupOperation(operation, false);
    });
    this.transition({
      phase: 'connected',
      localUrl: `http://127.0.0.1:${localPort}`,
      host,
    });
  }

  async stop(): Promise<void> {
    const operation = this.operation;
    if (!operation) {
      this.transition({ phase: 'disconnected', reason: 'stopped' });
      return;
    }
    const wasConnected = this.state.phase === 'connected';
    operation.cancelled = true;
    this.transition({ phase: 'disconnected', reason: 'stopped' });
    if (wasConnected && operation.controlPath) {
      try {
        await this.dependencies.run([
          '-S',
          operation.controlPath,
          '-O',
          'exit',
          '--',
          requireOpenSshAlias(this.options.alias),
        ]);
      } catch {
        // The owned process is terminated below if the control exit failed.
      }
    }
    operation.process?.kill('SIGTERM');
    await this.startPromise;
    await this.cleanupOperation(operation, true);
  }

  private captureDiagnostic(
    operation: TunnelOperation,
    chunk: Buffer | string,
  ): void {
    operation.diagnostic = `${operation.diagnostic}${chunk.toString()}`.slice(
      -16_384,
    );
    const state = classifyOpenSshDiagnostic(operation.diagnostic);
    if (state && this.isActive(operation)) this.transition(state);
  }

  private async cleanupOperation(
    operation: TunnelOperation,
    terminate: boolean,
  ): Promise<void> {
    const child = operation.process;
    operation.process = null;
    if (terminate && child?.exitCode === null) child.kill('SIGTERM');
    const directory = operation.controlDirectory;
    operation.controlDirectory = null;
    operation.controlPath = null;
    if (this.operation === operation) this.operation = null;
    if (directory) {
      try {
        await this.dependencies.removeControlDirectory(directory);
      } catch {
        // Cleanup is best effort after the owned process has been terminated.
        // Keep the already-redacted lifecycle state instead of leaking a path.
      }
    }
  }
}

export class OpenSshEnvironmentAdapter {
  private readonly dependencies: Required<OpenSshAdapterDependencies>;

  constructor(dependencies: OpenSshAdapterDependencies = {}) {
    this.dependencies = {
      run: dependencies.run ?? createSystemOpenSshRunner(),
      spawn: dependencies.spawn ?? spawnSystemOpenSsh,
      reservePort: dependencies.reservePort ?? reserveLoopbackPort,
      createControlDirectory:
        dependencies.createControlDirectory ?? createPrivateControlDirectory,
      removeControlDirectory:
        dependencies.removeControlDirectory ??
        (async (directory) => {
          await rm(directory, { recursive: true, force: true });
        }),
      probeWorker:
        dependencies.probeWorker ?? createSystemOpenSshWorkerProbeRunner(),
      runLaunchBootstrap:
        dependencies.runLaunchBootstrap ?? createSystemOpenSshLaunchRunner(),
      pollIntervalMs: dependencies.pollIntervalMs ?? 100,
    };
  }

  createTunnel(options: OpenSshTunnelOptions): OpenSshTunnel {
    requireOpenSshAlias(options.alias);
    safeRemotePort(options.remotePort);
    return new OpenSshTunnel(options, this.dependencies);
  }

  describeCommand(args: readonly string[]): string[] {
    return redactOpenSshArgs(args);
  }
}
