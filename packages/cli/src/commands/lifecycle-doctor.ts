import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInstanceRegistry } from '@kontourai/station-shared/instance-registry';
import {
  inspectLock,
  lockOwnerAlive,
} from '@kontourai/station-shared/lifecycle-events';
import {
  isSupportedNodeVersion,
  SUPPORTED_NODE_MAJOR,
} from '@kontourai/station-shared/node-runtime';
import { redactDeep } from '@kontourai/station-shared/redaction';
import {
  formatKontourDependencyState,
  inspectExactKontourDependencyPins,
  type KontourDependencyState,
} from '../lib/kontour-dependency-drift.js';
import { CWD, PROJECT_HOME } from './helpers.js';
import { collectInstanceStatus } from './lifecycle.js';

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
export function parseTsxVersion(raw: string | null): string | null {
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
}): DoctorFixCommand[] {
  const fixes: DoctorFixCommand[] = [];

  if (!isSupportedNodeVersion(input.nodeVersion)) {
    fixes.push({
      label: `Install Node.js ${SUPPORTED_NODE_MAJOR}.x`,
      command: `nvm install ${SUPPORTED_NODE_MAJOR} && nvm use ${SUPPORTED_NODE_MAJOR}`,
      reason: `Station supports Node.js ${SUPPORTED_NODE_MAJOR}.x; found ${input.nodeVersion ?? 'no Node.js runtime'}.`,
    });
  }
  if (!input.npmVersion) {
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
  if (!input.tsxVersion) {
    fixes.push({
      label: 'Install project dependencies',
      command: 'npm install',
      reason: 'tsx is provided by the project dependency set.',
    });
  }
  if (input.dependencyMismatchCount > 0) {
    fixes.push({
      label: 'Synchronize project dependencies',
      command: 'npm install',
      reason: `${input.dependencyMismatchCount} exact-pinned @kontourai package(s) do not match the installed versions.`,
    });
  }

  if (input.configuredChatProviderCount === 0) {
    if (input.ollamaReachable) {
      fixes.push({
        label: 'Save detected Ollama as a model connection',
        command:
          'station connections create --data \'{"id":"ollama-local","type":"ollama","enabled":true,"capabilities":["llm"],"config":{"baseUrl":"http://127.0.0.1:11434"}}\'',
        reason:
          'Ollama is reachable, but no enabled chat-capable connection is saved.',
      });
    } else if (input.awsConfigured) {
      fixes.push({
        label: 'Save Bedrock as a model connection',
        command:
          'station connections create --data \'{"id":"bedrock-default","type":"bedrock","enabled":true,"capabilities":["llm"],"config":{}}\'',
        reason:
          'AWS credentials are present, but no enabled Bedrock chat connection is saved.',
      });
    } else if (!input.chatReady) {
      fixes.push({
        label: 'Start a local Ollama runtime',
        command: 'ollama serve',
        reason: 'No chat-capable provider or local model runtime was detected.',
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
    ...deps,
  };

  const appConfigPath = join(runtimeDeps.projectHome, 'config', 'app.json');
  const providersPath = join(
    runtimeDeps.projectHome,
    'config',
    'providers.json',
  );
  const awsCredentialsPath = join(homedir(), '.aws', 'credentials');
  const awsConfigPath = join(homedir(), '.aws', 'config');

  const nodeVersion = runtimeDeps.exec('node -v');
  const npmVersion = runtimeDeps.exec('npm -v');
  const gitVersion = runtimeDeps.exec('git --version');
  const tsxVersion = parseTsxVersion(runtimeDeps.exec('tsx --version'));
  const rustVersion = runtimeDeps.exec('rustc --version');
  const codexVersion = runtimeDeps.exec('codex --version');
  const claudeVersion = runtimeDeps.exec('claude --version');
  const kiroVersion = runtimeDeps.exec('kiro-cli --version');
  const ollamaReachable = await runtimeDeps.checkOllama();
  const dependencyState = runtimeDeps.inspectKontourDependencies(
    runtimeDeps.repoRoot,
  );
  const supervisorWedges = await runtimeDeps.inspectSupervisorWedges(
    runtimeDeps.projectHome,
  );

  const appConfig = runtimeDeps.readJson<Record<string, unknown>>(
    appConfigPath,
    {},
  );
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
  const awsConfigured = Boolean(
    runtimeDeps.env.AWS_ACCESS_KEY_ID ||
      runtimeDeps.env.AWS_PROFILE ||
      runtimeDeps.exists(awsCredentialsPath) ||
      runtimeDeps.exists(awsConfigPath),
  );

  const checks: DoctorCheck[] = [
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
      label: 'Configured chat providers',
      status: enabledLlmProviders.length > 0 ? 'pass' : 'warn',
      detail:
        enabledLlmProviders.length > 0
          ? `${enabledLlmProviders.length} enabled chat-capable connection(s)`
          : 'No enabled chat-capable provider connection saved yet.',
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
    {
      label: 'Codex CLI',
      status: codexVersion ? 'pass' : 'warn',
      detail: codexVersion ?? 'Not found',
    },
    {
      label: 'Claude CLI',
      status: claudeVersion ? 'pass' : 'warn',
      detail: claudeVersion ?? 'Not found',
    },
    {
      label: 'ACP / external runtime',
      status:
        kiroVersion || enabledRuntimeConnections.some(([id]) => id === 'acp')
          ? 'pass'
          : 'warn',
      detail:
        kiroVersion ??
        (enabledRuntimeConnections.some(([id]) => id === 'acp')
          ? 'ACP runtime connection configured.'
          : 'No ACP runtime detected.'),
    },
  ];

  const chatReady =
    enabledLlmProviders.length > 0 || ollamaReachable || awsConfigured;
  const runtimeReady =
    awsConfigured ||
    Boolean(codexVersion) ||
    Boolean(claudeVersion) ||
    enabledRuntimeConnections.length > 0;
  const configuredProviderLabels = enabledLlmProviders
    .map(providerLabel)
    .filter(Boolean);
  const detectedProviders = [
    ollamaReachable ? 'ollama' : null,
    awsConfigured ? 'bedrock' : null,
  ].filter((value): value is string => Boolean(value));
  const configuredRuntimes = enabledRuntimeConnections.map(([id]) => id);
  const detectedRuntimes = [
    codexVersion ? 'codex-cli' : null,
    claudeVersion ? 'claude-cli' : null,
    kiroVersion ? 'kiro-cli' : null,
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
  });
  const recommendation =
    enabledLlmProviders.length > 0
      ? 'Chat looks reachable. Review Connections if you want to change the default path.'
      : ollamaReachable
        ? 'Ollama is reachable, but no saved model connection exists yet. Add an Ollama connection in Connections.'
        : awsConfigured
          ? 'AWS credentials are available. Add or enable a Bedrock model connection in Connections.'
          : 'No chat-capable path is ready yet. Start Ollama locally or add a provider connection first.';

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
        configuredRuntimes[0] ??
        detectedRuntimes[0] ??
        (awsConfigured ? 'bedrock-credentials' : null),
    },
    dependencyState,
    fixCommands,
  };
}

export async function doctor(): Promise<void> {
  console.log('Checking prerequisites and runtime readiness...\n');
  const report = await collectDoctorReport();

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
    `  Effective connection: ${report.providerState.effective ?? 'none'}`,
  );
  console.log(
    `  Configured connections: ${
      report.providerState.configured.length > 0
        ? report.providerState.configured.join(', ')
        : 'none'
    }`,
  );
  console.log(
    `  Detected connections: ${
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
): Promise<void> {
  const runtimeDeps: DoctorJsonDeps = {
    collectReport: collectDoctorReport,
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
