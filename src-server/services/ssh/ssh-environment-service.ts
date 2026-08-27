import { createHash } from 'node:crypto';
import {
  sshEnvironmentConnectDuration,
  sshEnvironmentOps,
} from '../../telemetry/metrics.js';
import {
  discoverOpenSshHosts,
  type ResolvedOpenSshHost,
  requireOpenSshAlias,
} from './openssh-config.js';
import {
  OpenSshEnvironmentAdapter,
  type OpenSshTunnel,
  type OpenSshTunnelState,
} from './openssh-environment-adapter.js';
import {
  OpenSshLaunchError,
  type OpenSshLaunchFailureReason,
} from './openssh-launch-bootstrap.js';
import {
  probeSshReachability,
  type SshReachabilityEvidence,
} from './openssh-reachability.js';
import { SSH_WORKER_PROTOCOL_VERSION } from './openssh-worker-probe.js';
import {
  type SshEnvironmentProfile,
  SshEnvironmentProfileStore,
} from './ssh-environment-profile-store.js';

type ErrorReason =
  | 'ssh-not-found'
  | 'config'
  | 'forward'
  | 'timeout'
  | 'worker-unavailable'
  | 'worker-incompatible'
  | 'station-unavailable'
  | 'project-unavailable'
  | 'identity-mismatch'
  | 'host-mismatch'
  | 'project-mismatch'
  // station#1133 R5: typed managed-launch diagnostics, distinct from the
  // worker-probe reasons above (which describe an existing remote worker,
  // not the bootstrap that starts one).
  | 'launch-node-not-found'
  | 'launch-unsupported-node-version'
  | 'launch-project-unavailable'
  | 'launch-port-in-use'
  | 'launch-readiness-timeout'
  // station#1133 live-verification/security-review additions: a launch
  // that would trigger station's own build (never attempted — a build is
  // not a launch) and a launch that lost a real port race against another
  // live Station instance on the host.
  | 'launch-requires-build'
  | 'launch-port-conflict'
  | 'launch-failed';

export type SshEnvironmentState =
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
  | { phase: 'verifying' }
  // station#1133 R3: a distinct, additive phase — the tunnel is up but
  // nothing answered yet, so the managed-launch bootstrap is running before
  // the (re-)probe. Attach-mode profiles never enter this phase.
  | { phase: 'launching' }
  | {
      phase: 'connected';
      localUrl: string;
      instanceId: string;
      sha: string;
      bootId: string;
      connectedAt: string;
      // station#1133 R1/R4: only set for a `launchMode: 'managed'` profile —
      // 'external' when an already-running Station was found (attached
      // directly, or via the bootstrap's own external-detection) and never
      // started or stopped by Station; 'managed' when this connect started
      // or reused a Station this feature owns. Omitted entirely for
      // `attach` profiles (AC4 back-compat).
      serverKind?: 'managed' | 'external';
    }
  | { phase: 'error'; reason: ErrorReason; action: string }
  | {
      phase: 'disconnected';
      reason: 'remote-closed' | 'transport-error' | 'stopped';
    };

export interface SshEnvironmentView {
  profile: SshEnvironmentProfile;
  state: SshEnvironmentState;
}

interface MetricsCounter {
  add(value: number, attributes?: Record<string, string | number>): void;
}

interface MetricsHistogram {
  record(value: number, attributes?: Record<string, string | number>): void;
}

interface SshEnvironmentServiceDependencies {
  adapter?: OpenSshEnvironmentAdapter;
  store?: SshEnvironmentProfileStore;
  discoverHosts?: typeof discoverOpenSshHosts;
  // station#1144: injectable so `add()`'s known-alias gate is testable
  // without touching the real machine's ~/.ssh/config.
  counter?: MetricsCounter;
  duration?: MetricsHistogram;
  now?: () => number;
  /** Injectable so `probe()` is testable without a real SSH client. */
  probeReachability?: typeof probeSshReachability;
}

interface ActiveEnvironment {
  tunnel: OpenSshTunnel;
  connectPromise: Promise<SshEnvironmentView> | null;
}

const ACTIONS: Record<ErrorReason, string> = {
  'ssh-not-found': 'Install the system OpenSSH client and retry.',
  config: 'Check this host alias with ssh -G and retry.',
  forward: 'Retry the connection or inspect local SSH forwarding policy.',
  timeout: 'Complete the SSH prompt or retry from an interactive terminal.',
  'worker-unavailable':
    'Install Node.js 24 or newer on the remote host and retry.',
  'worker-incompatible':
    'Update Station and Node.js on the remote host before reconnecting.',
  'station-unavailable':
    'Start Station on the configured remote port and retry.',
  'project-unavailable':
    'Confirm the remote project directory exists and is accessible.',
  'identity-mismatch':
    'Pair this as a separate environment or restore the expected remote Station home.',
  'host-mismatch':
    'Review the OpenSSH alias target before explicitly replacing this environment.',
  'project-mismatch':
    'Restore the verified project root or add it as a separate environment.',
  'launch-node-not-found':
    'Install Node.js 24.x on the remote host (nvm, volta, asdf, mise, fnm, or nodenv) and retry.',
  'launch-unsupported-node-version':
    'Switch the remote host to Node.js 24.x with your version manager and retry.',
  'launch-project-unavailable':
    'Confirm the remote project directory exists and contains a Station checkout.',
  'launch-port-in-use':
    'The remote port was claimed by another process while starting. Retry the connection.',
  'launch-readiness-timeout':
    'Station did not become ready on the remote host in time. Check the remote launch log and retry.',
  'launch-requires-build':
    'Build Station on the remote host (or point at a pre-built checkout) before enabling managed launch.',
  'launch-port-conflict':
    'Another Station instance on the remote host is using the ports this launch needed. Check the remote launch log and retry.',
  'launch-failed':
    'Starting Station on the remote host failed. Check the remote launch log and retry.',
};

const LAUNCH_FAILURE_REASON_MAP: Record<
  OpenSshLaunchFailureReason,
  ErrorReason
> = {
  'node-not-found': 'launch-node-not-found',
  'unsupported-node-version': 'launch-unsupported-node-version',
  'project-unavailable': 'launch-project-unavailable',
  'port-in-use': 'launch-port-in-use',
  'readiness-timeout': 'launch-readiness-timeout',
  'requires-build': 'launch-requires-build',
  'port-conflict': 'launch-port-conflict',
  'protocol-violation': 'launch-failed',
  'launch-failed': 'launch-failed',
};

function classifyLaunchFailure(error: unknown): ErrorReason {
  if (error instanceof OpenSshLaunchError) {
    return LAUNCH_FAILURE_REASON_MAP[error.reason];
  }
  return 'launch-failed';
}

function deriveHostIdentity(host: ResolvedOpenSshHost): string {
  return `ssh:${createHash('sha256')
    .update(JSON.stringify([host.hostname, host.user, host.port]))
    .digest('base64url')}`;
}

function nodeMajor(version: string): number {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
  return Number.isInteger(major) ? major : 0;
}

function errorState(
  reason: ErrorReason,
): Extract<SshEnvironmentState, { phase: 'error' }> {
  return { phase: 'error', reason, action: ACTIONS[reason] };
}

function mapTunnelState(state: OpenSshTunnelState): SshEnvironmentState {
  switch (state.phase) {
    case 'idle':
    case 'starting':
    case 'prompt':
    case 'host-key':
    case 'agent':
    case 'disconnected':
      return state;
    case 'connected':
      return { phase: 'verifying' };
    case 'unavailable':
      return errorState(state.reason);
  }
}

function classifyWorkerFailure(error: unknown): ErrorReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/identity-mismatch/.test(message)) return 'identity-mismatch';
  if (/host-mismatch/.test(message)) return 'host-mismatch';
  if (/project-mismatch/.test(message)) return 'project-mismatch';
  if (/project-(?:unavailable|not-directory)|project path/i.test(message)) {
    return 'project-unavailable';
  }
  if (
    /station-unavailable|build identity|environment identity/i.test(message)
  ) {
    return 'station-unavailable';
  }
  if (/incompatible|unsupported-probe-protocol/i.test(message)) {
    return 'worker-incompatible';
  }
  return 'worker-unavailable';
}

export class SshEnvironmentService {
  readonly #adapter: OpenSshEnvironmentAdapter;
  readonly #store: SshEnvironmentProfileStore;
  readonly #discoverHosts: typeof discoverOpenSshHosts;
  readonly #counter: MetricsCounter;
  readonly #duration: MetricsHistogram;
  readonly #now: () => number;
  readonly #probeReachability: typeof probeSshReachability;
  readonly #states = new Map<string, SshEnvironmentState>();
  readonly #active = new Map<string, ActiveEnvironment>();

  constructor(
    homeDir: string,
    dependencies: SshEnvironmentServiceDependencies = {},
  ) {
    this.#adapter = dependencies.adapter ?? new OpenSshEnvironmentAdapter();
    this.#store = dependencies.store ?? new SshEnvironmentProfileStore(homeDir);
    this.#discoverHosts = dependencies.discoverHosts ?? discoverOpenSshHosts;
    this.#counter = dependencies.counter ?? sshEnvironmentOps;
    this.#duration = dependencies.duration ?? sshEnvironmentConnectDuration;
    this.#now = dependencies.now ?? Date.now;
    this.#probeReachability =
      dependencies.probeReachability ?? probeSshReachability;
  }

  /**
   * "Test connection" for a computer that may not exist here yet (audit
   * CI-R1/CI-R14). Read-only: it writes no profile and accepts no host key,
   * so a caller can run it before deciding to save — and the failure it
   * returns names a cause and a next step rather than a bare error.
   */
  async probe(input: { hostAlias: string }): Promise<SshReachabilityEvidence> {
    const alias = requireOpenSshAlias(input.hostAlias);
    const evidence = await this.#probeReachability({ hostAlias: alias });
    this.#record('probe', evidence.reachable ? 'success' : 'error');
    return evidence;
  }

  async initialize(): Promise<void> {
    await this.#store.initialize();
  }

  async discover(): Promise<Awaited<ReturnType<typeof discoverOpenSshHosts>>> {
    const started = this.#now();
    try {
      const result = await this.#discoverHosts();
      this.#record('discover', 'success');
      this.#duration.record(this.#now() - started, {
        operation: 'discover',
        outcome: 'success',
      });
      return result;
    } catch (error) {
      this.#record('discover', 'error');
      throw error;
    }
  }

  list(): SshEnvironmentView[] {
    this.#record('list', 'success');
    return this.#store.list().map((profile) => this.#view(profile));
  }

  get(id: string): SshEnvironmentView | null {
    const profile = this.#store.get(id);
    return profile ? this.#view(profile) : null;
  }

  async add(input: {
    name?: string;
    hostAlias: string;
    remoteProjectPath: string;
    remotePort?: number;
    launchMode?: SshEnvironmentProfile['launchMode'];
  }): Promise<SshEnvironmentView> {
    // The character-class guard against flag-like/metacharacter-ish input,
    // which every stored alias has always had to pass.
    requireOpenSshAlias(input.hostAlias);
    const profile = await this.#store.add(input);
    this.#record('add', 'success');
    return this.#view(profile);
  }

  async connect(id: string): Promise<SshEnvironmentView> {
    const profile = this.#requireProfile(id);
    const current = this.#active.get(id);
    if (current?.connectPromise) return current.connectPromise;
    if (this.#states.get(id)?.phase === 'connected') return this.#view(profile);
    if (current) await current.tunnel.stop();

    const tunnel = this.#adapter.createTunnel({
      alias: profile.hostAlias,
      remotePort: profile.remotePort,
      onStateChange: (state) => this.#states.set(id, mapTunnelState(state)),
    });
    const active: ActiveEnvironment = { tunnel, connectPromise: null };
    const promise = this.#connect(profile, tunnel).finally(() => {
      if (active.connectPromise === promise) active.connectPromise = null;
    });
    active.connectPromise = promise;
    this.#active.set(id, active);
    return promise;
  }

  async disconnect(id: string): Promise<SshEnvironmentView> {
    const profile = this.#requireProfile(id);
    const active = this.#active.get(id);
    if (active) await active.tunnel.stop();
    this.#active.delete(id);
    this.#states.set(id, { phase: 'disconnected', reason: 'stopped' });
    this.#record('disconnect', 'success');
    return this.#view(profile);
  }

  async remove(id: string): Promise<boolean> {
    const active = this.#active.get(id);
    if (active) await active.tunnel.stop();
    this.#active.delete(id);
    this.#states.delete(id);
    const removed = await this.#store.remove(id);
    this.#record('remove', removed ? 'success' : 'not_found');
    return removed;
  }

  async shutdown(): Promise<void> {
    const active = [...this.#active.values()];
    this.#active.clear();
    await Promise.allSettled(active.map(({ tunnel }) => tunnel.stop()));
  }

  async #connect(
    profile: SshEnvironmentProfile,
    tunnel: OpenSshTunnel,
  ): Promise<SshEnvironmentView> {
    const started = this.#now();
    try {
      let tunnelState = await tunnel.start();
      if (tunnelState.phase !== 'connected') {
        this.#record('connect', tunnelState.phase);
        return this.#view(profile);
      }
      this.#states.set(profile.id, { phase: 'verifying' });
      let serverKind: 'managed' | 'external' | undefined;
      let worker: Awaited<ReturnType<OpenSshTunnel['probeWorker']>>;
      try {
        worker = await tunnel.probeWorker(profile.remoteProjectPath);
        if (profile.launchMode === 'managed') serverKind = 'external';
      } catch (probeError) {
        if (
          profile.launchMode !== 'managed' ||
          classifyWorkerFailure(probeError) !== 'station-unavailable'
        ) {
          // station#1133 R3: the launch bootstrap only ever runs for this
          // exact trigger — every other probe failure (identity mismatch,
          // incompatible worker, unreachable project, ...) is unaffected
          // and, for `attach` profiles, this branch never runs at all
          // (AC4).
          throw probeError;
        }
        this.#states.set(profile.id, { phase: 'launching' });
        const launch = await tunnel.runLaunchBootstrap({
          remoteProjectPath: profile.remoteProjectPath,
          launchKey: profile.id,
        });
        serverKind = launch.serverKind;
        if (launch.remotePort !== profile.remotePort) {
          const retargeted = await tunnel.retarget(launch.remotePort);
          if (retargeted.phase !== 'connected') {
            throw new Error('SSH environment disconnected while re-forwarding');
          }
          tunnelState = retargeted;
        }
        this.#states.set(profile.id, { phase: 'verifying' });
        worker = await tunnel.probeWorker(profile.remoteProjectPath);
      }
      if (tunnelState.phase !== 'connected') {
        throw new Error('SSH environment disconnected before verification');
      }
      this.#assertCompatible(profile, tunnelState.host, worker);
      const verified = await this.#store.recordVerified(profile.id, {
        environmentId: worker.environmentId,
        hostIdentity: deriveHostIdentity(tunnelState.host),
        remoteHome: worker.remoteHome,
        verifiedProjectPath: worker.remoteProjectPath,
        workerProtocolVersion: worker.protocolVersion,
      });
      this.#states.set(profile.id, {
        phase: 'connected',
        localUrl: tunnelState.localUrl,
        instanceId: worker.instanceId,
        sha: worker.sha,
        bootId: worker.bootId,
        connectedAt: new Date(this.#now()).toISOString(),
        ...(serverKind ? { serverKind } : {}),
      });
      this.#record('connect', 'success');
      this.#duration.record(this.#now() - started, {
        operation: 'connect',
        outcome: 'success',
      });
      return this.#view(verified);
    } catch (error) {
      const reason =
        error instanceof OpenSshLaunchError
          ? classifyLaunchFailure(error)
          : classifyWorkerFailure(error);
      this.#states.set(profile.id, errorState(reason));
      this.#record('connect', 'error', reason);
      this.#duration.record(this.#now() - started, {
        operation: 'connect',
        outcome: 'error',
        reason,
      });
      await tunnel.stop();
      this.#states.set(profile.id, errorState(reason));
      return this.#view(profile);
    }
  }

  #assertCompatible(
    profile: SshEnvironmentProfile,
    host: ResolvedOpenSshHost,
    worker: Awaited<ReturnType<OpenSshTunnel['probeWorker']>>,
  ): void {
    if (
      worker.protocolVersion !== SSH_WORKER_PROTOCOL_VERSION ||
      nodeMajor(worker.nodeVersion) < 24
    ) {
      throw new Error('worker-incompatible');
    }
    if (
      profile.environmentId &&
      profile.environmentId !== worker.environmentId
    ) {
      throw new Error('identity-mismatch');
    }
    if (
      profile.hostIdentity &&
      profile.hostIdentity !== deriveHostIdentity(host)
    ) {
      throw new Error('host-mismatch');
    }
    if (
      profile.verifiedProjectPath &&
      profile.verifiedProjectPath !== worker.remoteProjectPath
    ) {
      throw new Error('project-mismatch');
    }
  }

  #requireProfile(id: string): SshEnvironmentProfile {
    const profile = this.#store.get(id);
    if (!profile) throw new Error('SSH environment not found');
    return profile;
  }

  #view(profile: SshEnvironmentProfile): SshEnvironmentView {
    return {
      profile,
      state: this.#states.get(profile.id) ?? { phase: 'idle' },
    };
  }

  #record(operation: string, outcome: string, reason?: string): void {
    this.#counter.add(1, {
      operation,
      outcome,
      ...(reason ? { reason } : {}),
    });
  }
}
