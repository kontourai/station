import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { readInstanceRegistry } from '@kontourai/station-shared/instance-registry';
import {
  inspectLock,
  lockOwnerAlive,
} from '@kontourai/station-shared/lifecycle-events';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import {
  isSupportedNodeVersion,
  SUPPORTED_NODE_MAJOR,
} from '@kontourai/station-shared/node-runtime';
import { redactDeep } from '@kontourai/station-shared/redaction';
import {
  describeTerminalPtyLoadFailure,
  type TerminalCapability,
  terminalPtyUnavailableReason,
} from '@kontourai/station-shared/terminal-capability';
import {
  formatKontourDependencyState,
  inspectExactKontourDependencyPins,
  type KontourDependencyState,
} from '../lib/kontour-dependency-drift.js';
import { loadInstalledManagedPolicyChecked } from './app-config-schema.js';
import {
  confinementDoctorChecks,
  type DoctorConfinement,
  describeConfinementTarget,
} from './doctor-confinement.js';
import { CWD, LIFECYCLE_CODE_ROOT, PROJECT_HOME } from './helpers.js';
import {
  collectInstanceStatus,
  inspectTerminalShellHosts,
  type TerminalShellHostReport,
} from './lifecycle.js';
import {
  type LifecycleCodeRoot,
  resolveLifecycleStateLocation,
} from './lifecycle-code-root.js';
import { effectiveAppConfigOffline } from './managed-settings-guard.js';

type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorFixCommand {
  label: string;
  command: string;
  reason: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  recommendation: string;
  chatReady: boolean;
  runtimeReady: boolean;
  providerState: {
    configured: string[];
    detected: string[];
    effective: string | null;
  };
  runtimeState: {
    configured: string[];
    detected: string[];
    effective: string | null;
  };
  dependencyState: KontourDependencyState;
  fixCommands: DoctorFixCommand[];
  /**
   * #4774: the selected Station's confinement preflight, or why it was not
   * obtained. Absent when the caller supplied no `inspectConfinement` (the
   * server's own diagnostics callers do not).
   */
  confinement?: DoctorConfinement;
}

export interface DoctorDeps {
  exec: (command: string) => string | null;
  checkOllama: () => Promise<boolean>;
  readJson: <T>(path: string, fallback: T) => T;
  exists: (path: string) => boolean;
  env: NodeJS.ProcessEnv;
  projectHome: string;
  repoRoot: string;
  inspectKontourDependencies: (repoRoot: string) => KontourDependencyState;
  inspectSupervisorWedges: (
    projectHome: string,
  ) => Promise<ReadonlyArray<string>>;
  /** The checkout's terminal PTY backend — see `probeTerminalPtyModule`. */
  probeTerminalPty: (repoRoot: string) => TerminalCapability;
  /** Each running instance's terminal shell host (#3994). */
  inspectShellHosts: (projectHome: string) => TerminalShellHostReport[];
  /** What this CLI runs from (#2675): a source tree or a prebuilt archive. */
  codeRoot: LifecycleCodeRoot;
  /** The Node.js executing this CLI: an archive runs its bundled one. */
  processRuntime: { version: string; execPath: string };
  /** The installed managed policy, as server startup accepts it (#4517). */
  loadManagedPolicy: () => LoadedManagedPolicy | null;
  /**
   * #4774: asks the selected Station for its confinement preflight. Without
   * it, the report has no confinement rows and no `confinement` field.
   */
  inspectConfinement?: () => Promise<DoctorConfinement>;
}

export interface DoctorJsonDocument {
  schemaVersion: 1;
  generatedAt: string;
  report: DoctorReport;
  exitReady: {
    chatReady: boolean;
    runtimeReady: boolean;
  };
}

export interface DoctorJsonDeps {
  collectReport: () => Promise<DoctorReport>;
  now: () => Date;
  write: (document: string) => void;
  setExitCode: (code: number) => void;
}

function execVersion(command: string): string | null {
  try {
    return execSync(command, { encoding: 'utf-8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/**
 * `tsx --version` prints two lines on stdout (`tsx vX.Y.Z` then
 * `node vA.B.C`). Collapse that into a single well-formed detail line so the
 * doctor output never emits a stray unlabeled `node v...` line, while keeping
 * the embedded Node version visible instead of silently dropping it.
 */
function parseTsxVersion(raw: string | null): string | null {
  if (!raw) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const tsxLine = lines.find((line) => line.startsWith('tsx ')) ?? lines[0];
  const nodeLine = lines.find((line) => line.startsWith('node '));
  return nodeLine ? `${tsxLine} (${nodeLine})` : tsxLine;
}

async function detectOllama(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the checkout's node-pty native module actually loads (#1244).
 * node-pty is Station's only install-time compile on Linux, and a host
 * without a C++ toolchain installs with the terminal surface degraded — a
 * product state this doctor line must report loudly, with the remediation,
 * instead of leaving a dead terminal pane as the first symptom. Resolution
 * is anchored at the checkout (`repoRoot`), the same root the dependency
 * checks above inspect, so the answer is about the Station being diagnosed
 * rather than about the doctor's own package.
 */
export function probeTerminalPtyModule(repoRoot: string): TerminalCapability {
  try {
    createRequire(join(repoRoot, 'package.json'))('node-pty');
    return { state: 'available' };
  } catch (error) {
    return {
      state: 'unavailable',
      reason: terminalPtyUnavailableReason(
        describeTerminalPtyLoadFailure(error),
      ),
    };
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

const OLLAMA_PULL_MODEL_HINT = 'pull a model with: ollama pull llama3.2';

function doctorStatusSymbol(status: DoctorCheckStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'warn') return '⚠';
  return '✗';
}

/**
 * Read-only correlation for the service-install wedge: the reconciler lock
 * exists while a managed child has a non-OK identity probe. We intentionally
 * do not reclaim or alter the lock here; `service start` is the recovery
 * command because its platform adapter owns that lifecycle transition.
 */
async function inspectSupervisorWedges(
  projectHome: string,
): Promise<ReadonlyArray<string>> {
  const instances = readInstanceRegistry(projectHome).instances;
  const wedges: string[] = [];
  for (const instanceId of Object.keys(instances)) {
    const reconcileLock = join(
      projectHome,
      'service',
      `${instanceId}.reconcile`,
    );
    if (!existsSync(reconcileLock)) continue;
    // Lock-file EXISTENCE is not tenure: an orphaned lock (dead owner)
    // means a different remedy than a live holder, and a live holder can be
    // ordinary reconciliation in progress (sol review of #2669, finding 2).
    const observed = inspectLock(`${reconcileLock}.lock`);
    const heldByLiveProcess =
      observed !== null && lockOwnerAlive(observed.owner);
    // station#2745: the doctor reports on the host, so it must not mutate the
    // instance registry while doing so. Reclaiming a stale record takes a
    // SYNCHRONOUS file-mutation lock per record, and this report is reachable
    // over HTTP through the diagnostics bundle — so the endpoint an operator
    // hits to investigate a freeze could block the loop it is diagnosing.
    const status = await collectInstanceStatus(instanceId, {
      probeTimeoutMs: 1_000,
      reclaimStale: false,
      projectHome,
    });
    if (
      status.found &&
      (status.server.probe !== 'ok' || status.ui.probe !== 'ok')
    ) {
      wedges.push(
        heldByLiveProcess
          ? instanceId
          : `${instanceId} (orphaned lock — dead owner; safe to reclaim via service start)`,
      );
    }
  }
  return wedges;
}

/**
 * #3994: which host runs each running instance's shells. Supervisor
 * workloads survive a core restart; a shell in the core ends with it, and
 * Station reopens it after the restart instead. A missing PTY host bundle
 * keeps shells in the core.
 */
export function shellHostChecks(
  reports: readonly TerminalShellHostReport[],
): DoctorCheck[] {
  if (reports.length === 0)
    return [
      {
        label: 'Terminal shell host',
        status: 'pass',
        detail:
          'No instance is running; the shell host is chosen when one starts.',
      },
    ];
  return reports.flatMap((report): DoctorCheck[] => [
    {
      label: `Terminal shell host (${report.instanceId})`,
      status: report.workloads === 'granted' ? 'pass' : 'warn',
      detail:
        report.workloads === 'granted'
          ? 'Supervisor workloads: shells survive a core restart.'
          : `In the core server (${report.detail}): shells end when it restarts and reopen after it.`,
    },
    {
      label: `Terminal PTY host bundle (${report.instanceId})`,
      status: report.hostBundle ? 'pass' : 'warn',
      detail: report.hostBundle
        ? 'station-pty-host.js is beside the server bundle.'
        : 'station-pty-host.js is missing beside the server bundle; rebuild Station so shells can run as supervisor workloads.',
    },
  ]);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

function providerLabel(provider: Record<string, unknown>): string {
  const id = stringField(provider, 'id');
  const type = stringField(provider, 'type');
  return [id, type ? `(${type})` : ''].filter(Boolean).join(' ');
}

function buildFixCommands(input: {
  chatReady: boolean;
  configuredChatProviderCount: number;
  runtimeReady: boolean;
  ollamaReachable: boolean;
  awsConfigured: boolean;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
  tsxVersion: string | null;
  dependencyMismatchCount: number;
  terminalPtyAvailable: boolean;
  /**
   * #2675: the toolchain fixes (nvm, npm install, the PTY rebuild) act on a
   * source checkout. An archive has none of those scripts, and its runtime
   * and dependencies are replaced only by installing another archive.
   */
  prebuiltArchive: boolean;
}): DoctorFixCommand[] {
  const fixes: DoctorFixCommand[] = [];
  const source = !input.prebuiltArchive;

  if (source && !isSupportedNodeVersion(input.nodeVersion)) {
    fixes.push({
      label: `Install Node.js ${SUPPORTED_NODE_MAJOR}.x`,
      command: `nvm install ${SUPPORTED_NODE_MAJOR} && nvm use ${SUPPORTED_NODE_MAJOR}`,
      reason: `Station supports Node.js ${SUPPORTED_NODE_MAJOR}.x; found ${input.nodeVersion ?? 'no Node.js runtime'}.`,
    });
  }
  if (source && !input.npmVersion) {
    fixes.push({
      label: 'Install npm dependencies',
      command: 'npm install',
      reason: 'npm was not found on PATH.',
    });
  }
  if (!input.gitVersion) {
    fixes.push({
      label: 'Install git',
      command: 'git --version',
      reason: 'git is required for repo-backed workflows and updates.',
    });
  }
  if (source && !input.tsxVersion) {
    fixes.push({
      label: 'Install project dependencies',
      command: 'npm install',
      reason: 'tsx is provided by the project dependency set.',
    });
  }
  if (source && input.dependencyMismatchCount > 0) {
    fixes.push({
      label: 'Synchronize project dependencies',
      command: 'npm install',
      reason: `${input.dependencyMismatchCount} exact-pinned @kontourai package(s) do not match the installed versions.`,
    });
  }
  if (source && !input.terminalPtyAvailable) {
    fixes.push({
      label: 'Rebuild the terminal PTY backend',
      command: 'npm run dependencies:install',
      reason:
        'node-pty failed to load, so interactive terminal panes are disabled. The rebuild needs a C++ toolchain (g++, make, python3); agent execution is unaffected either way.',
    });
  }

  if (input.configuredChatProviderCount === 0) {
    if (input.ollamaReachable) {
      fixes.push({
        label: 'Save detected Ollama as a model connection',
        command:
          'station connections create --data \'{"id":"ollama-local","kind":"model","type":"ollama","name":"Ollama","enabled":true,"capabilities":["llm"],"config":{"baseUrl":"http://127.0.0.1:11434"}}\'',
        reason:
          'Ollama is reachable, but no enabled chat-capable connection is saved.',
      });
    } else if (input.awsConfigured) {
      fixes.push({
        label: 'Save Bedrock as a model connection',
        command:
          'station connections create --data \'{"id":"bedrock-default","kind":"model","type":"bedrock","name":"Amazon Bedrock","enabled":true,"capabilities":["llm"],"config":{}}\'',
        reason:
          'AWS credentials are present, but no enabled Bedrock chat connection is saved.',
      });
    } else if (!input.chatReady) {
      fixes.push({
        label: 'Start a local Ollama runtime',
        command: 'ollama serve',
        reason:
          'No chat-capable model connection or local engine was detected.',
      });
    }
  }

  if (!input.runtimeReady) {
    fixes.push({
      label: 'Review connected runtimes',
      command: 'station connections runtimes',
      reason:
        'No connected runtime, ACP connection, Claude CLI, Codex CLI, or Bedrock credential source was detected.',
    });
  }

  return fixes;
}

/** Checks that concern only a tree that builds itself from source. */
const SOURCE_TOOLCHAIN_CHECKS = new Set([
  'npm',
  'tsx',
  'Kontour package pins',
  'Rust',
]);

/**
 * #2675: from a prebuilt archive, report the runtime it ships and its release
 * instead of the source toolchain. A prebuilt archive cannot build itself, so
 * npm, tsx, Rust and the source manifest's exact pins are neither required
 * nor inspectable there (git stays: agent workflows on repositories still
 * need it).
 */
export function prebuiltArchiveChecks(
  sourceChecks: readonly DoctorCheck[],
  archive: Extract<LifecycleCodeRoot, { kind: 'prebuilt-archive' }>,
  runtime: { version: string; execPath: string },
  stateDir: string,
): DoctorCheck[] {
  const { release } = archive;
  return sourceChecks.flatMap((check): DoctorCheck[] => {
    if (SOURCE_TOOLCHAIN_CHECKS.has(check.label)) return [];
    if (check.label !== 'Node.js') return [check];
    const relation = relative(archive.root, runtime.execPath);
    const bundled =
      relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
    return [
      bundled
        ? { ...check, detail: `${check.detail} (bundled: ${runtime.execPath})` }
        : {
            label: check.label,
            status: check.status === 'fail' ? 'fail' : 'warn',
            detail: `${check.detail} from ${runtime.execPath}, not this archive's bundled runtime; run Station through ${join(archive.root, 'bin', 'station')}`,
          },
      {
        label: 'Prebuilt archive',
        status: 'pass',
        detail: `${release.ref} (${release.sha.slice(0, 12)}, ${release.releaseChannel} ring, ${release.channel} channel) at ${archive.root}; lifecycle state in ${stateDir}`,
      },
    ];
  });
}

/**
 * A detected CLI's row: `pass` only when its connection may run it, so the
 * row agrees with `runtimeReady` and `runtimeState.detected` (#4517).
 */
function cliCheck(
  label: string,
  version: string | null,
  allowed: boolean,
): DoctorCheck {
  if (!version) return { label, status: 'warn', detail: 'Not found' };
  if (!allowed)
    return {
      label,
      status: 'warn',
      detail: `${version}, but its connection is disabled by configuration or the managed policy cannot be used.`,
    };
  return { label, status: 'pass', detail: version };
}

export async function collectDoctorReport(
  deps: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
  const runtimeDeps: DoctorDeps = {
    exec: (command) => execVersion(command),
    checkOllama: detectOllama,
    readJson: readJsonFile,
    exists: existsSync,
    env: process.env,
    projectHome: PROJECT_HOME,
    repoRoot: CWD,
    inspectKontourDependencies: inspectExactKontourDependencyPins,
    inspectSupervisorWedges,
    probeTerminalPty: probeTerminalPtyModule,
    inspectShellHosts: inspectTerminalShellHosts,
    codeRoot: LIFECYCLE_CODE_ROOT,
    processRuntime: { version: process.version, execPath: process.execPath },
    loadManagedPolicy: loadInstalledManagedPolicyChecked,
    ...deps,
  };
  const archive =
    runtimeDeps.codeRoot.kind === 'prebuilt-archive'
      ? runtimeDeps.codeRoot
      : null;

  const appConfigPath = join(runtimeDeps.projectHome, 'config', 'app.json');
  const providersPath = join(
    runtimeDeps.projectHome,
    'config',
    'providers.json',
  );
  const acpConfigPath = join(runtimeDeps.projectHome, 'config', 'acp.json');
  const awsCredentialsPath = join(homedir(), '.aws', 'credentials');
  const awsConfigPath = join(homedir(), '.aws', 'config');

  // #2675: an archive runs the Node.js it ships (bin/station never consults
  // PATH), so the host's `node` -- often absent -- says nothing about it.
  // Nor are the source toolchain probes run there: their checks are dropped
  // (`prebuiltArchiveChecks`), and the archive has no package.json whose
  // exact pins could be compared.
  const nodeVersion = archive
    ? runtimeDeps.processRuntime.version
    : runtimeDeps.exec('node -v');
  const npmVersion = archive ? null : runtimeDeps.exec('npm -v');
  const gitVersion = runtimeDeps.exec('git --version');
  const tsxVersion = archive
    ? null
    : parseTsxVersion(runtimeDeps.exec('tsx --version'));
  const rustVersion = archive ? null : runtimeDeps.exec('rustc --version');
  const codexVersion = runtimeDeps.exec('codex --version');
  const claudeVersion = runtimeDeps.exec('claude --version');
  const kiroVersion = runtimeDeps.exec('kiro-cli --version');
  const ollamaReachable = await runtimeDeps.checkOllama();
  const dependencyState: KontourDependencyState = archive
    ? { exactPins: [], mismatches: [] }
    : runtimeDeps.inspectKontourDependencies(runtimeDeps.repoRoot);
  const supervisorWedges = await runtimeDeps.inspectSupervisorWedges(
    runtimeDeps.projectHome,
  );
  const terminalCapability = runtimeDeps.probeTerminalPty(runtimeDeps.repoRoot);
  const shellHosts = runtimeDeps.inspectShellHosts(runtimeDeps.projectHome);
  const confinement = await runtimeDeps.inspectConfinement?.();

  // #4517: readiness is derived from the settings in effect, with the
  // managed policy's locks and defaults applied the way the server applies
  // them, so a connection the policy disables is not reported as ready. A
  // policy server startup would refuse is a failing check: nothing the
  // stored file configures runs until it is fixed.
  const storedAppConfig = runtimeDeps.readJson<Record<string, unknown>>(
    appConfigPath,
    {},
  );
  let managedPolicyProblem: string | null = null;
  let appConfig: Record<string, unknown>;
  try {
    appConfig = effectiveAppConfigOffline(
      storedAppConfig,
      runtimeDeps.loadManagedPolicy,
    );
  } catch (error) {
    managedPolicyProblem =
      error instanceof Error ? error.message : String(error);
    appConfig = {};
  }
  const providers = runtimeDeps.readJson<Array<Record<string, unknown>>>(
    providersPath,
    [],
  );
  const enabledLlmProviders = providers.filter(
    (provider) =>
      provider.enabled !== false &&
      Array.isArray(provider.capabilities) &&
      provider.capabilities.includes('llm'),
  );
  const agentConnections = (appConfig.agentConnections ?? {}) as Record<
    string,
    { enabled?: boolean }
  >;
  const enabledRuntimeConnections = Object.entries(agentConnections).filter(
    ([, settings]) => settings?.enabled !== false,
  );
  // A detected CLI is a usable runtime only while its connection is not
  // disabled in the effective configuration (a managed policy can disable
  // it, #4517).
  // Under a policy startup would refuse, nothing runs: the server does not
  // start, so no detected CLI is usable either.
  const runtimeAllowed = (connectionId: string): boolean =>
    managedPolicyProblem === null &&
    agentConnections[connectionId]?.enabled !== false;
  // Kiro is an ACP registry engine, not an `agentConnections` key, so only
  // an unusable policy gates it here.
  const kiroUsable = Boolean(kiroVersion) && managedPolicyProblem === null;
  // ACP engine connections (OpenCode, Kiro, a custom command, …) are saved
  // in `config/acp.json`, the file the server's ACP adapter reads, each with
  // its own `enabled` flag; `agentConnections` has no entry for them.
  const acpConfig = runtimeDeps.readJson<{ connections?: unknown }>(
    acpConfigPath,
    {},
  );
  const enabledAcpConnections = (
    Array.isArray(acpConfig?.connections) ? acpConfig.connections : []
  ).filter(
    (connection): connection is { id: string; name?: unknown } =>
      Boolean(connection) &&
      typeof connection === 'object' &&
      typeof (connection as { id?: unknown }).id === 'string' &&
      (connection as { enabled?: unknown }).enabled === true,
  );
  const acpConnectionsUsable =
    managedPolicyProblem === null && enabledAcpConnections.length > 0;
  const acpConnectionNames = enabledAcpConnections.map((connection) =>
    typeof connection.name === 'string' && connection.name.trim()
      ? connection.name.trim()
      : connection.id,
  );
  const awsConfigured = Boolean(
    runtimeDeps.env.AWS_ACCESS_KEY_ID ||
      runtimeDeps.env.AWS_PROFILE ||
      runtimeDeps.exists(awsCredentialsPath) ||
      runtimeDeps.exists(awsConfigPath),
  );

  const sourceChecks: DoctorCheck[] = [
    ...(managedPolicyProblem
      ? [
          {
            label: 'Managed policy',
            status: 'fail' as const,
            detail: managedPolicyProblem,
          },
        ]
      : []),
    {
      label: 'Node.js',
      status: isSupportedNodeVersion(nodeVersion) ? 'pass' : 'fail',
      detail: isSupportedNodeVersion(nodeVersion)
        ? (nodeVersion ?? 'Not found')
        : `${nodeVersion ?? 'Not found'} — Node.js ${SUPPORTED_NODE_MAJOR}.x required`,
    },
    {
      label: 'npm',
      status: npmVersion ? 'pass' : 'fail',
      detail: npmVersion ?? 'Not found',
    },
    {
      label: 'git',
      status: gitVersion ? 'pass' : 'fail',
      detail: gitVersion ?? 'Not found',
    },
    {
      label: 'tsx',
      status: tsxVersion ? 'pass' : 'fail',
      detail: tsxVersion ?? 'Not found',
    },
    {
      label: 'Kontour package pins',
      status: dependencyState.mismatches.length === 0 ? 'pass' : 'fail',
      detail: formatKontourDependencyState(dependencyState),
    },
    {
      label: 'Rust',
      status: rustVersion ? 'pass' : 'warn',
      detail:
        rustVersion?.split(' ')[1] ??
        'Not installed (desktop builds unavailable)',
    },
    {
      // #1244: a Station without a working node-pty runs with terminal
      // panes disabled — a supported, deliberately LOUD degraded state, so
      // this is a warn (install stays usable), never a silent omission.
      label: 'Terminal PTY (node-pty)',
      status: terminalCapability.state === 'available' ? 'pass' : 'warn',
      detail:
        terminalCapability.state === 'available'
          ? 'Native module loads; interactive terminal panes are available.'
          : terminalCapability.reason,
    },
    ...shellHostChecks(shellHosts),
    {
      label: 'App config',
      status: runtimeDeps.exists(appConfigPath) ? 'pass' : 'warn',
      detail: runtimeDeps.exists(appConfigPath)
        ? appConfigPath
        : 'No app config yet; it will be created on first start.',
    },
    {
      label: 'Supervisor probe wedge',
      status: supervisorWedges.length === 0 ? 'pass' : 'fail',
      detail:
        supervisorWedges.length === 0
          ? 'No failing managed identity probe is holding a service lifecycle lock.'
          : `Managed identity probe failing with a lifecycle lock present for: ${supervisorWedges.join('; ')}. Remedy per instance: station service start --instance=<id> (kickstart).`,
    },
    {
      label: 'Configured chat model connections',
      status: enabledLlmProviders.length > 0 ? 'pass' : 'warn',
      detail:
        enabledLlmProviders.length > 0
          ? `${enabledLlmProviders.length} enabled chat-capable connection(s)`
          : 'No enabled chat-capable model connection saved yet.',
    },
    {
      label: 'Ollama',
      status: ollamaReachable ? 'pass' : 'warn',
      detail: ollamaReachable
        ? enabledLlmProviders.length === 0 && !awsConfigured
          ? `Reachable at http://127.0.0.1:11434 — ${OLLAMA_PULL_MODEL_HINT}`
          : 'Reachable at http://127.0.0.1:11434'
        : 'Local Ollama server not detected.',
    },
    {
      label: 'Bedrock credentials',
      status: awsConfigured ? 'pass' : 'warn',
      detail: awsConfigured
        ? 'AWS credential sources detected.'
        : 'No AWS credential source detected.',
    },
    cliCheck('Codex CLI', codexVersion, runtimeAllowed('codex')),
    cliCheck('Claude CLI', claudeVersion, runtimeAllowed('claude')),
    {
      label: 'ACP / external runtime',
      status:
        kiroUsable ||
        acpConnectionsUsable ||
        enabledRuntimeConnections.some(([id]) => id === 'acp')
          ? 'pass'
          : 'warn',
      detail: acpConnectionsUsable
        ? `${enabledAcpConnections.length} enabled ACP connection(s): ${acpConnectionNames.join(', ')}`
        : kiroUsable
          ? (kiroVersion as string)
          : kiroVersion
            ? `${kiroVersion}, but the managed policy cannot be used.`
            : enabledAcpConnections.length > 0
              ? 'ACP connections are saved, but the managed policy cannot be used.'
              : enabledRuntimeConnections.some(([id]) => id === 'acp')
                ? 'ACP runtime connection configured.'
                : 'No ACP runtime detected.',
    },
    ...(confinement ? confinementDoctorChecks(confinement) : []),
  ];
  const checks = archive
    ? prebuiltArchiveChecks(
        sourceChecks,
        archive,
        runtimeDeps.processRuntime,
        // The doctor's home, so this is the directory `station stop` reads.
        resolveLifecycleStateLocation(archive, runtimeDeps.projectHome)
          .stateDir,
      )
    : sourceChecks;

  const codexUsable = Boolean(codexVersion) && runtimeAllowed('codex');
  const claudeUsable = Boolean(claudeVersion) && runtimeAllowed('claude');
  // A chat can run on a usable engine with no model connection, the same
  // rule as the server's `chat.ready` (system-status-routes.ts), so an
  // installed CLI or an enabled ACP connection makes chat ready here too.
  const engineChatReady =
    codexUsable || claudeUsable || kiroUsable || acpConnectionsUsable;
  // A policy server startup would refuse leaves nothing ready: the server
  // does not start.
  const chatReady =
    managedPolicyProblem === null &&
    (enabledLlmProviders.length > 0 ||
      ollamaReachable ||
      awsConfigured ||
      engineChatReady);
  const runtimeReady =
    managedPolicyProblem === null &&
    (awsConfigured ||
      codexUsable ||
      claudeUsable ||
      acpConnectionsUsable ||
      enabledRuntimeConnections.length > 0);
  const configuredProviderLabels = enabledLlmProviders
    .map(providerLabel)
    .filter(Boolean);
  const detectedProviders = [
    ollamaReachable ? 'ollama' : null,
    awsConfigured ? 'bedrock' : null,
  ].filter((value): value is string => Boolean(value));
  const configuredRuntimes = [
    ...enabledRuntimeConnections.map(([id]) => id),
    ...(acpConnectionsUsable
      ? enabledAcpConnections.map((connection) => `acp:${connection.id}`)
      : []),
  ];
  const detectedRuntimes = [
    codexUsable ? 'codex-cli' : null,
    claudeUsable ? 'claude-cli' : null,
    kiroUsable ? 'kiro-cli' : null,
  ].filter((value): value is string => Boolean(value));
  const fixCommands = buildFixCommands({
    chatReady,
    configuredChatProviderCount: enabledLlmProviders.length,
    runtimeReady,
    ollamaReachable,
    awsConfigured,
    nodeVersion,
    npmVersion,
    gitVersion,
    tsxVersion,
    dependencyMismatchCount: dependencyState.mismatches.length,
    terminalPtyAvailable: terminalCapability.state === 'available',
    prebuiltArchive: archive !== null,
  });
  const recommendation =
    enabledLlmProviders.length > 0
      ? 'Chat looks reachable. Review Connections if you want to change the default path.'
      : ollamaReachable
        ? 'Ollama is reachable, but no saved model connection exists yet. Add an Ollama connection in Connections.'
        : awsConfigured
          ? 'AWS credentials are available. Add or enable a Bedrock model connection in Connections.'
          : engineChatReady
            ? 'Chat can run on a connected engine. Add a model connection in Connections if you also want Station-managed models.'
            : 'No chat-capable path is ready yet. Start Ollama locally or add a model connection first.';

  return {
    checks,
    recommendation,
    chatReady,
    runtimeReady,
    providerState: {
      configured: configuredProviderLabels,
      detected: detectedProviders,
      effective:
        configuredProviderLabels[0] ??
        (ollamaReachable ? 'ollama (detected)' : null) ??
        (awsConfigured ? 'bedrock (detected)' : null),
    },
    runtimeState: {
      configured: configuredRuntimes,
      detected: detectedRuntimes,
      effective:
        managedPolicyProblem !== null
          ? null
          : (configuredRuntimes[0] ??
            detectedRuntimes[0] ??
            (awsConfigured ? 'bedrock-credentials' : null)),
    },
    dependencyState,
    fixCommands,
    ...(confinement ? { confinement } : {}),
  };
}

export async function doctor(
  reportDeps: Partial<DoctorDeps> = {},
): Promise<void> {
  console.log('Checking prerequisites and runtime readiness...\n');
  const report = await collectDoctorReport(reportDeps);

  for (const check of report.checks) {
    console.log(
      `  ${doctorStatusSymbol(check.status)} ${check.label} — ${check.detail}`,
    );
  }

  const chatReadyRestsOnOllama =
    report.chatReady &&
    report.providerState.configured.length === 0 &&
    report.providerState.detected.includes('ollama') &&
    !report.providerState.detected.includes('bedrock');
  console.log(
    `\n  Chat readiness: ${
      report.chatReady
        ? chatReadyRestsOnOllama
          ? `ready (Ollama reachable — ${OLLAMA_PULL_MODEL_HINT})`
          : 'ready'
        : 'setup needed'
    }`,
  );
  console.log(
    `  Runtime readiness: ${report.runtimeReady ? 'ready' : 'setup needed'}`,
  );
  console.log(
    `  Effective model connection: ${report.providerState.effective ?? 'none'}`,
  );
  console.log(
    `  Configured model connections: ${
      report.providerState.configured.length > 0
        ? report.providerState.configured.join(', ')
        : 'none'
    }`,
  );
  console.log(
    `  Detected model connections: ${
      report.providerState.detected.length > 0
        ? report.providerState.detected.join(', ')
        : 'none'
    }`,
  );
  console.log(
    `  Effective runtime: ${report.runtimeState.effective ?? 'none'}`,
  );
  console.log(
    `  Configured runtimes: ${
      report.runtimeState.configured.length > 0
        ? report.runtimeState.configured.join(', ')
        : 'none'
    }`,
  );
  console.log(
    `  Detected runtimes: ${
      report.runtimeState.detected.length > 0
        ? report.runtimeState.detected.join(', ')
        : 'none'
    }`,
  );
  if (report.confinement?.checked)
    console.log(
      `  Confinement: host facts from ${describeConfinementTarget(report.confinement.target)}; ${report.confinement.preflight.decidedAtStart.join(', ')} depend on the workspace or conversation and are decided when a Session starts.`,
    );
  console.log(`\n  Next: ${report.recommendation}`);

  if (report.fixCommands.length > 0) {
    console.log('\n  Fix commands:');
    for (const fix of report.fixCommands) {
      console.log(`  - ${fix.label}: ${fix.command}`);
      console.log(`    ${fix.reason}`);
    }
  }

  if (report.checks.some((check) => check.status === 'fail')) {
    console.log('\nMissing required prerequisites.');
    process.exit(1);
  }

  if (!report.chatReady || !report.runtimeReady) {
    console.log(
      '\nEnvironment is usable but not fully ready for first-run AI workflows.',
    );
    process.exit(1);
  }

  console.log('\n  All good!');
}

export async function doctorJson(
  deps: Partial<DoctorJsonDeps> = {},
  reportDeps: Partial<DoctorDeps> = {},
): Promise<void> {
  const runtimeDeps: DoctorJsonDeps = {
    collectReport: () => collectDoctorReport(reportDeps),
    now: () => new Date(),
    write: (document) => process.stdout.write(`${document}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    ...deps,
  };
  const report = redactDeep(await runtimeDeps.collectReport());
  const document: DoctorJsonDocument = {
    schemaVersion: 1,
    generatedAt: runtimeDeps.now().toISOString(),
    report,
    exitReady: {
      chatReady: report.chatReady,
      runtimeReady: report.runtimeReady,
    },
  };

  runtimeDeps.write(JSON.stringify(document));

  if (
    report.checks.some((check) => check.status === 'fail') ||
    !report.chatReady ||
    !report.runtimeReady
  ) {
    runtimeDeps.setExitCode(1);
  }
}
