#!/usr/bin/env tsx

/**
 * @kontourai/station-cli — Unified CLI for Station
 *
 * Dispatch only. The command vocabulary (summaries, valid actions, per-command
 * help) lives in `./help.ts` so the top-level summary, `station <verb> --help`,
 * and the unknown-input messages cannot drift apart; the prose reference is
 * `docs/reference/cli.md`.
 *
 * The recognized-verb tree is a Commander program built fresh per invocation by
 * `buildProgram` (so injected dependencies and lazy `.action()` callbacks never
 * leak across calls or run at module load). Commander does the routing; the
 * per-command flag semantics stay in the existing hand-rolled parsers
 * (`parseLifecycleArgs`, `parseCoreArgs`, …) because those encode ~20 pinned
 * behavioural contracts the tests assert. To keep Commander's own option
 * parsing from ever touching those flags, every verb receives its raw argument
 * list as variadic operands after a `--` separator. Help-at-any-depth, the
 * version short-circuit, the bare/default launcher, and the unknown-command arm
 * are all resolved BEFORE Commander parses, so Commander never overrides the
 * pinned exitCode / stdout-stderr semantics.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH } from '@kontourai/station-contracts/environment-security';
import {
  TaskToolResultRequestError,
  TaskUserInputReferenceRequestError,
} from '@kontourai/station-sdk/client';
import { Command } from 'commander';
import { build as buildPlugin } from './commands/build.js';
import { runCheckpointsCommand } from './commands/checkpoints.js';
import { runCloudCommand } from './commands/cloud.js';
import { configGet, configSet } from './commands/config.js';
import { runCoreCommand } from './commands/core.js';
import {
  configureRequestTimeout,
  getResolvedApiBase,
  parseCoreArgs,
} from './commands/core-api.js';
import { runDevCommand } from './commands/dev-command.js';
import {
  type EnvironmentSecurityServiceFactory,
  type PeerCredentialStoreFactory,
  pairSavedStation,
  runEnvironmentCommand,
  type SshEnvironmentProfileStoreFactory,
} from './commands/environment.js';
import { explainRequestFailure } from './commands/errors.js';
import { exportConfig } from './commands/export.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_UI_PORT,
  INVOKED_CWD,
  type LifecycleHomeSource,
  PROJECT_HOME,
  resolveLifecycleHomeTarget,
} from './commands/helpers.js';
import { importConfig } from './commands/import.js';
import { createPlugin, init } from './commands/init.js';
import {
  info,
  install,
  installRegistryPlugin,
  list,
  preview,
  registry,
  remove,
  update,
} from './commands/install.js';
import { type LazyStartOptions, runLazyStart } from './commands/lazy-start.js';
import {
  buildApplication,
  clean,
  doctor,
  doctorJson,
  homeBackup,
  homeReset,
  homeRestore,
  homeVerify,
  link,
  shortcut,
  start,
  stop,
  upgrade,
  validateLifecyclePorts,
} from './commands/lifecycle.js';
import { runStationsCommand } from './commands/profile-command.js';
import {
  parseAllowedOriginFlag,
  runServiceCommand,
} from './commands/service.js';
import { runServiceMenu } from './commands/service-menu.js';
import { runSetupCommand } from './commands/setup-command.js';
import { runSetupImportCommand } from './commands/setup-import.js';
import {
  runRegistryCatalogCommand,
  runSurfaceCommand,
} from './commands/surfaces.js';
import { runTargetCommand } from './commands/target-command.js';
import { runTriageCommand } from './commands/triage.js';
import { versionText } from './commands/version.js';
import { type DevFlags, startDevServer } from './dev/server.js';
import {
  assertCommandAvailable,
  assertDefaultInvocationAvailable,
  isBundledDistribution,
} from './distribution.js';
import {
  actionsFor,
  commandHelpText,
  didYouMean,
  knownCommands,
  usageText,
} from './help.js';

export { usageText };

/**
 * Unknown/incomplete commands are failures, not help requests: the message
 * goes to stderr and the process exits non-zero. A `... && next-step` chain (or
 * a CI gate) must never read a typo'd command as success — found as a
 * false-green during S2 dogfooding (an unsupported top-level build invocation
 * printed usage and exited 0, so a Playwright suite's build step had been a
 * silent no-op). Top-level `station build` is now a real lifecycle command,
 * while this rule continues to protect every unsupported command.
 *
 * What changed: it used to reprint the entire 156-line usage text, burying the
 * one line that mattered. Now it suggests the nearest real command and points
 * at `station --help`.
 */
function failUnknownCommand(
  label: string,
  suggestion = '',
  extra?: string,
): void {
  console.error(`Unknown command: ${label}`);
  if (extra) console.error(extra);
  console.error(`${suggestion}Run \`station --help\` for the command list.`);
  process.exitCode = 1;
}

/**
 * `--help`/`-h` at any depth is a help request, not a positional. Before this,
 * `station agents --help` failed with `Missing action for agents` and
 * `station chat --help` with `Missing required argument: agent`, because the
 * flag fell through to the command's own argument parsing.
 */
function printHelpFor(command: string | undefined): boolean {
  if (command === undefined) {
    console.log(usageText());
    return true;
  }
  const help = commandHelpText(command);
  if (help) {
    console.log(help);
    return true;
  }
  return false;
}

export interface ParsedLifecycleArgs {
  allowDefaultHomeClean: boolean;
  /** station#1913: `station home reset --confirm`. */
  confirm: boolean;
  /**
   * Browser origins the runtime's pairing gate should trust in addition to
   * its computed local ones (station#1672). Undefined means "not specified"
   * — for `service install` that preserves what the manifest already holds,
   * which is what makes the setting survive reinstalls.
   */
  allowedOrigins?: string[];
  baseDir: string;
  buildFlag: boolean;
  clearAllowedOrigins: boolean;
  features?: string;
  force: boolean;
  allowSharedHome: boolean;
  homeSource: LifecycleHomeSource;
  host?: string;
  instanceName?: string;
  logFile?: string;
  lifecycleJournal?: string;
  readinessFile?: string;
  rotateLogOnRestart: boolean;
  stopIntent?: 'promotion' | 'operator_stop' | 'recovery' | 'rollback';
  serverPort: number;
  uiPort: number;
  /**
   * Explicit consent-listener port (station#3677). `undefined` means "derive
   * `serverPort + 3`", the same rule the runtime applies — the derivation
   * happens at the start boundary so ad-hoc `--port=` instances keep a
   * collision-free block without repeating the arithmetic here.
   */
  consentPort?: number;
}

export function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  for (const selector of ['--station', '--profile', '--api-base']) {
    if (
      args.some((arg) => arg === selector || arg.startsWith(`${selector}=`))
    ) {
      throw new Error(
        `${selector} selects a remote client target and cannot be used with local lifecycle commands. Use --home or --base to select a runtime.`,
      );
    }
  }
  // Lifecycle options are deliberately `--flag=value` only. Commander receives
  // raw operands for this command tree, so reject only known value-taking flags
  // in their space-separated form while preserving the compatibility contract
  // that genuinely unknown lifecycle flags are ignored.
  const valueFlags = new Set([
    '--host',
    '--port',
    '--ui-port',
    '--consent-port',
    '--home',
    '--base',
    '--instance',
    '--log',
    '--features',
    '--allowed-origin',
    '--stop-intent',
    '--lifecycle-journal',
    '--readiness-file',
  ]);
  for (const arg of args) {
    if (valueFlags.has(arg)) {
      throw new Error(
        `Lifecycle option ${arg} requires the ${arg}=<value> form.`,
      );
    }
  }

  const channelDefaults = {
    serverPort: DEFAULT_SERVER_PORT,
    uiPort: DEFAULT_UI_PORT,
  };
  let serverPort = Number(
    process.env.STATION_SERVER_PORT || channelDefaults.serverPort,
  );
  let uiPort = Number(process.env.STATION_UI_PORT || channelDefaults.uiPort);
  let consentPort = process.env.STATION_CONSENT_PORT
    ? Number(process.env.STATION_CONSENT_PORT)
    : undefined;
  let logFile: string | undefined;
  let buildFlag = false;
  let baseDir: string | undefined;
  let homeDir: string | undefined;
  let features: string | undefined;
  let instanceName: string | undefined;
  let host: string | undefined;
  let lifecycleJournal: string | undefined;
  let readinessFile: string | undefined;
  let stopIntent: ParsedLifecycleArgs['stopIntent'];
  let allowedOrigins: string[] | undefined;
  const tempHome = args.includes('--temp-home');

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      serverPort = Number(arg.slice('--port='.length));
    } else if (arg.startsWith('--ui-port=')) {
      uiPort = Number(arg.slice('--ui-port='.length));
    } else if (arg.startsWith('--consent-port=')) {
      consentPort = Number(arg.slice('--consent-port='.length));
    } else if (arg.startsWith('--log=')) {
      logFile = arg.slice(arg.indexOf('=') + 1);
    } else if (arg === '--build') {
      buildFlag = true;
    } else if (arg.startsWith('--base=')) {
      baseDir = arg.slice(arg.indexOf('=') + 1);
    } else if (arg.startsWith('--home=')) {
      homeDir = arg.slice(arg.indexOf('=') + 1);
    } else if (arg.startsWith('--features=')) {
      features = arg.slice(arg.indexOf('=') + 1);
    } else if (arg.startsWith('--instance=')) {
      instanceName = arg.slice(arg.indexOf('=') + 1);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg.startsWith('--allowed-origin=')) {
      allowedOrigins = allowedOrigins ?? [];
      allowedOrigins.push(
        parseAllowedOriginFlag(arg.slice('--allowed-origin='.length)),
      );
    } else if (arg.startsWith('--lifecycle-journal=')) {
      lifecycleJournal = arg.slice('--lifecycle-journal='.length);
    } else if (arg.startsWith('--readiness-file=')) {
      readinessFile = arg.slice('--readiness-file='.length);
    } else if (arg.startsWith('--stop-intent=')) {
      const value = arg.slice('--stop-intent='.length);
      if (
        !['promotion', 'operator_stop', 'recovery', 'rollback'].includes(value)
      ) {
        throw new Error(`Invalid stop intent: ${value}`);
      }
      stopIntent = value as ParsedLifecycleArgs['stopIntent'];
    }
  }

  if (tempHome && baseDir) {
    throw new Error('--temp-home cannot be combined with --base.');
  }

  // station#4299. `--home` is the discoverable name for the home override and
  // `--base` is the name it shipped under; they set the same directory, so
  // neither ranks over the other — supplying both is refused rather than
  // resolved by a precedence rule nobody would guess. `--temp-home` picks a
  // directory of its own, so it cannot be combined with either.
  if (tempHome && homeDir) {
    throw new Error('--temp-home cannot be combined with --home.');
  }
  if (homeDir && baseDir) {
    throw new Error(
      '--home and --base set the same directory. Pass only one of them.',
    );
  }
  if (homeDir !== undefined && !homeDir.trim()) {
    throw new Error('--home requires a directory path.');
  }

  const homeTarget = resolveLifecycleHomeTarget({ baseDir, homeDir, tempHome });

  return {
    serverPort,
    uiPort,
    consentPort: consentPort ?? serverPort + 3,
    logFile,
    buildFlag,
    baseDir: homeTarget.projectHome,
    homeSource: homeTarget.source,
    host,
    features,
    instanceName,
    lifecycleJournal,
    readinessFile,
    rotateLogOnRestart: args.includes('--rotate-log-on-restart'),
    stopIntent,
    allowedOrigins,
    clearAllowedOrigins: args.includes('--clear-allowed-origins'),
    force: args.includes('--force'),
    allowSharedHome: args.includes('--allow-shared-home'),
    allowDefaultHomeClean: args.includes('--allow-default-home-clean'),
    confirm: args.includes('--confirm'),
  };
}

export interface CliDependencies {
  /** Installs the OS-keyring adapter only after a real client command passes distribution guards. */
  configureProfileCredentialStore?: () => void | Promise<void>;
  createEnvironmentSecurityService?: EnvironmentSecurityServiceFactory;
  /** station#1123 slice 2: `station environment peers ...` provisioning. */
  createPeerCredentialStore?: PeerCredentialStoreFactory;
  /** station#1123 slice 2 review fix: `peers add` SSH-precedence warning. */
  createSshEnvironmentProfileStore?: SshEnvironmentProfileStoreFactory;
  confirm?: (question: string) => Promise<boolean>;
  isInteractive?: boolean;
  /**
   * `station doctor --migrate-playbooks`. Injected the same way
   * `createEnvironmentSecurityService` is, and for the same reason: the pass
   * lives in `src-server/`, which must never ship inside a CLI tarball. The
   * published binary therefore has no factory here and says so; the repo-root
   * `./station` launcher (`scripts/station-cli.ts`) wires it.
   */
  runPlaybookSkillMigration?: (options: {
    homeDir: string;
    dryRun: boolean;
  }) => Promise<PlaybookSkillMigrationSummary>;
  /** Source-only diagnostic callback for `station triage`; never bundled. */
  collectTriageDoctorReport?: () => Promise<unknown>;
  /** Exact source revision supplied by the checkout launcher when available. */
  sourceRevision?: () => string | undefined;
}

/**
 * What `doctor` prints. Structural only — the CLI must not re-derive anything
 * about the migration, it reports what the pass reported.
 */
export interface PlaybookSkillMigrationSummary {
  status: string;
  reason?: string;
  skills: Array<{
    playbookName: string;
    skillName: string;
    renamedFrom?: string;
    global: boolean;
    alreadyMigrated: boolean;
  }>;
  agents: Array<{
    slug: string;
    addedSkills: string[];
    droppedPromptIds: string[];
  }>;
  unboundAgentPins: Array<{ agentSlug: string; skillName: string }>;
  conflicts: Array<{
    playbookName: string;
    claimedBy: string;
    migratedAs: string;
  }>;
  failedAgents: Array<{ slug: string; reason: string }>;
  pluginRowsLeftInPlace: number;
  promptsArchivedTo?: string;
  errors: string[];
}

// ── The recognized top-level verbs, grouped by how they dispatch ──────────────
// The unknown-command arm and `buildProgram` share these sets so a verb can
// never be routable by one and unknown to the other.
const CORE_COMMANDS = [
  'agents',
  'sessions',
  'approvals',
  'operate',
  'delegate',
  'projects',
  'tasks',
  'skills',
  'secret-bindings',
  'conversation',
  'chat',
] as const;

const SURFACE_COMMANDS = [
  'connections',
  'flow',
  'tools',
  'notifications',
  'monitoring',
  'schedule',
  'runs',
  'review',
  'knowledge',
  'auth',
  'branding',
  'feedback',
  'insights',
  'acp',
  'voice',
] as const;

const INDIVIDUAL_COMMANDS = [
  'plugin',
  'start',
  'dev',
  'service',
  'setup',
  'build',
  'stop',
  'fresh',
  'home',
  'cloud',
  'upgrade',
  'doctor',
  'link',
  'shortcut',
  'config',
  'checkpoints',
  'environment',
  'export',
  'import',
  'stations',
  'target',
  'triage',
  'registry',
] as const;

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...CORE_COMMANDS,
  ...SURFACE_COMMANDS,
  ...INDIVIDUAL_COMMANDS,
]);

// ── Default-command (bare `station [dir]`) detection ─────────────────────────
const DEFAULT_COMMAND_FLAGS = new Set(['--inline', '--service', '--temp-home']);

function isDefaultCommandFlag(token: string): boolean {
  return (
    DEFAULT_COMMAND_FLAGS.has(token) ||
    token.startsWith('--port=') ||
    token.startsWith('--ui-port=') ||
    token.startsWith('--consent-port=') ||
    token === '--clean' ||
    token === '--force' ||
    token === '--allow-shared-home'
  );
}

/**
 * Whether this invocation is the bare launcher rather than a verb: no command
 * at all, a recognized default flag, or a first token that is an existing
 * directory. A first token that is neither a known verb, a default flag, nor a
 * real directory (a typo like `agnts`) is deliberately NOT default — it falls
 * through to the unknown-command arm, preserving that pinned contract.
 */
function isDefaultInvocation(command: string | undefined): boolean {
  if (command === undefined) return true;
  if (KNOWN_COMMANDS.has(command)) return false;
  if (command.startsWith('-')) return isDefaultCommandFlag(command);
  try {
    return existsSync(command) && statSync(command).isDirectory();
  } catch {
    return false;
  }
}

function parseDefaultArgs(argv: string[]): LazyStartOptions {
  const dir = argv.find((token) => !token.startsWith('-'));
  const options: LazyStartOptions = {
    inline: argv.includes('--inline'),
    service: argv.includes('--service'),
    tempHome: argv.includes('--temp-home'),
    // Recognized as a token since the refuse graduation; without this read
    // the flag was consumed and silently DROPPED on the default path, so the
    // refusal's remediation text pointed at a flag that did not work here.
    allowSharedHome: argv.includes('--allow-shared-home'),
  };
  if (dir) options.dir = dir;
  const portArg = argv.find((token) => token.startsWith('--port='));
  if (portArg) options.serverPort = Number(portArg.slice('--port='.length));
  const uiPortArg = argv.find((token) => token.startsWith('--ui-port='));
  if (uiPortArg) options.uiPort = Number(uiPortArg.slice('--ui-port='.length));
  const consentPortArg = argv.find((token) =>
    token.startsWith('--consent-port='),
  );
  if (consentPortArg) {
    options.consentPort = Number(
      consentPortArg.slice('--consent-port='.length),
    );
  }
  return options;
}

// ── Production I/O for the default (lazy-start) command ───────────────────────
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 1_500,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeInstance(serverPort: number): Promise<boolean> {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${serverPort}/api/system/instance`,
    { method: 'GET' },
  );
  return response?.ok ?? false;
}

/**
 * Best-effort mint of a one-time bootstrap token for a running instance. Reads
 * the per-boot local-grant secret off disk (same file the desktop shell reads,
 * readable only by this OS user) and posts it to the mint route directly on
 * loopback. Any failure returns null so the opener falls back to opening the
 * browser without a token — never a hard error on the launch path.
 */
async function mintBootstrapTokenForOpener(
  serverPort: number,
  home: string | undefined,
  deviceName: string,
): Promise<string | null> {
  const secretPath = join(
    home ?? PROJECT_HOME,
    'runtime',
    'local-grant.secret',
  );
  let secret: string;
  try {
    secret = readFileSync(secretPath, 'utf8');
  } catch {
    return null;
  }
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${serverPort}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, deviceName }),
    },
  );
  if (!response?.ok) return null;
  try {
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === 'string' ? body.token : null;
  } catch {
    return null;
  }
}

/**
 * Builds a lifecycle arg list from the default-command options.
 *
 * The positional `[dir]` is a PROJECT selector (it becomes `?project=<name>`
 * when a browser is opened — see `lazy-start.ts`), never a Station-home
 * override. So `dir` deliberately does NOT become `--base=<dir>` here: every
 * start path (inline, service, temp-home) resolves its home from STATION_HOME
 * or the default, exactly as a verbless start with no positional would.
 */
export function lifecycleArgvFrom(options: LazyStartOptions): string[] {
  const argv: string[] = [];
  if (options.tempHome) argv.push('--temp-home');
  if (options.allowSharedHome) argv.push('--allow-shared-home');
  if (options.serverPort) argv.push(`--port=${options.serverPort}`);
  if (options.uiPort) argv.push(`--ui-port=${options.uiPort}`);
  if (options.consentPort) argv.push(`--consent-port=${options.consentPort}`);
  return argv;
}

async function runInlineStart(options: LazyStartOptions): Promise<void> {
  const lifecycleArgs = parseLifecycleArgs(lifecycleArgvFrom(options));
  validateLifecyclePorts(
    lifecycleArgs.serverPort,
    lifecycleArgs.uiPort,
    lifecycleArgs.consentPort,
  );
  await start({
    serverPort: lifecycleArgs.serverPort,
    uiPort: lifecycleArgs.uiPort,
    consentPort: lifecycleArgs.consentPort,
    allowSharedHome: lifecycleArgs.allowSharedHome,
    build: lifecycleArgs.buildFlag,
    baseDir: lifecycleArgs.baseDir,
    homeSource: lifecycleArgs.homeSource,
    instanceName: lifecycleArgs.instanceName,
  });
}

async function runServiceInstall(options: LazyStartOptions): Promise<void> {
  const argv = lifecycleArgvFrom({ ...options, tempHome: false });
  const lifecycleArgs = parseLifecycleArgs(argv);
  validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
  await runServiceCommand(['install', ...argv], lifecycleArgs);
}

/**
 * `station doctor --migrate-playbooks [--dry-run] [--json]`.
 *
 * Prints the Playbooks→Skills report. `--dry-run` is the safe read: the pass
 * writes nothing and reports what it WOULD do, which is the point of exposing
 * it here at all — a one-way write on a user's home should be inspectable
 * before it happens.
 *
 * The pass itself lives in `src-server/` and is injected, exactly like
 * `EnvironmentSecurityService`: server source must never ship in a CLI tarball,
 * so the published binary says which launcher to use instead of pretending.
 */
async function runPlaybookMigrationReport(
  rawArgs: string[],
  dependencies: CliDependencies,
): Promise<void> {
  if (!dependencies.runPlaybookSkillMigration) {
    throw new Error(
      "station doctor --migrate-playbooks is only available through the repo's ./station launcher (it runs the server-side migration, which is not part of the published CLI).",
    );
  }
  const dryRun = rawArgs.includes('--dry-run');
  const report = await dependencies.runPlaybookSkillMigration({
    homeDir: PROJECT_HOME,
    dryRun,
  });
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `Playbooks → Skills (${PROJECT_HOME}): ${report.status}${
      report.reason ? ` — ${report.reason}` : ''
    }`,
  );
  if (dryRun) console.log('  DRY RUN — nothing was written.');
  for (const skill of report.skills) {
    const notes = [
      skill.renamedFrom ? `renamed from '${skill.renamedFrom}'` : '',
      skill.global ? 'offered to every agent' : '',
      skill.alreadyMigrated ? 'already migrated' : '',
    ].filter(Boolean);
    console.log(
      `  playbook '${skill.playbookName}' → skill '${skill.skillName}'${
        notes.length > 0 ? ` (${notes.join('; ')})` : ''
      }`,
    );
  }
  for (const agent of report.agents) {
    if (agent.addedSkills.length > 0) {
      // Named as an activation, not as an add: nothing read `agent.prompts`,
      // and `agent.skills` reaches the model.
      console.log(
        `  agent '${agent.slug}' now receives: ${agent.addedSkills.join(', ')}`,
      );
    }
    if (agent.droppedPromptIds.length > 0) {
      console.log(
        `  agent '${agent.slug}' dropped unresolvable playbook ids: ${agent.droppedPromptIds.join(', ')}`,
      );
    }
  }
  for (const pin of report.unboundAgentPins) {
    console.log(
      `  playbook pinned to unknown agent '${pin.agentSlug}': skill '${pin.skillName}' is not attached to anything`,
    );
  }
  for (const conflict of report.conflicts) {
    console.log(
      `  ! skill '${conflict.claimedBy}' already claims playbook '${conflict.playbookName}' but was not written by this migration; migrated as '${conflict.migratedAs}' instead`,
    );
  }
  for (const failure of report.failedAgents) {
    console.log(
      `  ! agent '${failure.slug}' could not be updated: ${failure.reason}`,
    );
  }
  if (report.pluginRowsLeftInPlace > 0) {
    console.log(
      `  ${report.pluginRowsLeftInPlace} plugin-registered row(s) left in place — they are read from the plugin, not copied`,
    );
  }
  if (report.promptsArchivedTo) {
    console.log(`  playbook store archived to ${report.promptsArchivedTo}`);
  }
  for (const error of report.errors) console.log(`  ! ${error}`);
}

/**
 * Builds the recognized-verb Commander program fresh for this invocation. Each
 * verb receives its raw post-verb argument list as variadic operands (the
 * caller passes them after a `--` separator so Commander parses none of them as
 * options), and delegates to the same handlers the hand-rolled dispatcher used
 * — preserving every pinned flag contract. `.exitOverride()` keeps Commander
 * from calling `process.exit` on its own; unknown top-level verbs never reach
 * here (the manual arm handles them before parse), and thrown handler errors
 * propagate as a rejected `parseAsync` exactly as before.
 */
function buildProgram(
  dependencies: CliDependencies,
  interactive: boolean,
): Command {
  const program = new Command();
  program.exitOverride();
  program.allowUnknownOption(true);
  program.helpOption(false);
  program.addHelpCommand(false);

  const register = (
    name: string,
    action: (rawArgs: string[]) => Promise<void> | void,
  ): void => {
    program
      .command(name)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[rawArgs...]')
      .action((rawArgs: string[]) => action(rawArgs));
  };

  for (const name of CORE_COMMANDS) {
    register(name, (rawArgs) => runCoreCliAction(name, rawArgs));
  }
  for (const name of SURFACE_COMMANDS) {
    register(name, (rawArgs) => runSurfaceCommand(name, rawArgs));
  }

  register('upgrade', async (rawArgs) => {
    const lifecycleArgs = parseLifecycleArgs(rawArgs);
    validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
    await upgrade({
      baseDir: lifecycleArgs.baseDir,
      serverPort: lifecycleArgs.serverPort,
      uiPort: lifecycleArgs.uiPort,
    });
  });
  register('link', () => {
    link();
  });
  register('shortcut', () => {
    shortcut();
  });
  register('import', async (rawArgs) => {
    await importConfig(rawArgs[0]);
  });
  register('stations', async (rawArgs) => {
    await runStationsCommand(rawArgs);
  });
  register('target', (rawArgs) => runTargetCommand(rawArgs));
  register('triage', async (rawArgs) => {
    await runTriageCommand(rawArgs, {
      collectSourceDoctorReport: dependencies.collectTriageDoctorReport,
      isInteractive: interactive,
      sourceRevision: dependencies.sourceRevision,
    });
  });
  register('dev', (rawArgs) => runDevCommand(rawArgs));
  register('doctor', async (rawArgs) => {
    if (rawArgs.includes('--migrate-playbooks')) {
      await runPlaybookMigrationReport(rawArgs, dependencies);
      return;
    }
    if (rawArgs.includes('--json')) await doctorJson();
    else await doctor();
  });

  register('plugin', async (args) => {
    const [sub, ...subArgs] = args;
    switch (sub) {
      case 'install': {
        const parsed = parseCoreArgs(subArgs);
        const skipArg = subArgs.find((a) => a.startsWith('--skip='));
        const skipList = skipArg
          ? skipArg.replace('--skip=', '').split(',')
          : [];
        const source = parsed.positionals[0];
        await install(source!, skipList, parsed);
        break;
      }
      case 'preview': {
        const parsed = parseCoreArgs(subArgs);
        await preview(parsed.positionals[0], parsed);
        break;
      }
      case 'list': {
        const parsed = parseCoreArgs(subArgs);
        await list(parsed);
        break;
      }
      case 'remove': {
        const parsed = parseCoreArgs(subArgs);
        await remove(parsed.positionals[0], parsed);
        break;
      }
      case 'info': {
        const parsed = parseCoreArgs(subArgs);
        await info(parsed.positionals[0], parsed);
        break;
      }
      case 'update': {
        const parsed = parseCoreArgs(subArgs);
        await update(parsed.positionals[0], parsed);
        break;
      }
      case 'registry':
        if (
          ['agents', 'skills', 'integrations', 'plugins'].includes(subArgs[0])
        ) {
          await runRegistryCatalogCommand(subArgs);
          break;
        }
        if (subArgs[0] === 'install') {
          const registryId = subArgs[1];
          await installRegistryPlugin(
            registryId,
            parseCoreArgs(subArgs.slice(2)),
          );
          break;
        }
        await registry(subArgs[0]);
        break;
      case 'init':
        init(subArgs[0]);
        break;
      case 'create': {
        const name = subArgs.find((arg) => !arg.startsWith('--'));
        const templateArg = subArgs.find((arg) =>
          arg.startsWith('--template='),
        );
        const template = templateArg?.slice(templateArg.indexOf('=') + 1);
        // Validate before createPlugin touches the filesystem: an unknown
        // template previously "worked" only because split('=') truncated it,
        // and the unchecked cast let init write a self-inconsistent scaffold
        // while reporting success.
        if (
          template !== undefined &&
          template !== 'provider' &&
          template !== 'layout' &&
          template !== 'full'
        ) {
          console.error(
            `Unknown plugin template "${template}"; expected provider, layout, or full.`,
          );
          process.exitCode = 1;
          break;
        }
        createPlugin(name, { template, cwd: INVOKED_CWD });
        break;
      }
      case 'build':
        await buildPlugin();
        break;
      case 'dev': {
        const flags: DevFlags = {};
        let devPort = 4200;
        let positionalPortSeen = false;
        for (const arg of subArgs) {
          if (arg === '--no-mcp') flags.mcp = false;
          else if (arg === '--mcp') flags.mcp = true;
          else if (
            arg.startsWith('--tools-dir=') &&
            arg.length > '--tools-dir='.length
          )
            flags.toolsDir = arg.slice('--tools-dir='.length);
          // `--port=` is the shape every other Station command uses; the
          // bare positional stays supported so existing invocations keep
          // working. Naming the port twice stays an error, as before.
          else if (arg.startsWith('--port=')) {
            const value = arg.slice('--port='.length);
            if (!/^\d+$/.test(value)) {
              failUnknownCommand(`plugin dev port ${value}`);
              return;
            }
            devPort = Number(value);
            positionalPortSeen = true;
          } else if (/^\d+$/.test(arg) && !positionalPortSeen) {
            devPort = Number(arg);
            positionalPortSeen = true;
          } else {
            failUnknownCommand(`plugin dev option ${arg}`);
            return;
          }
        }
        if (!Number.isInteger(devPort) || devPort < 1 || devPort > 65_535) {
          failUnknownCommand(`plugin dev port ${devPort}`);
          return;
        }
        await startDevServer(devPort, flags);
        break;
      }
      default:
        failUnknownCommand(
          sub === undefined ? 'plugin (missing action)' : `plugin ${sub}`,
          sub === undefined ? '' : didYouMean(sub, actionsFor('plugin') ?? []),
          `Valid plugin actions: ${(actionsFor('plugin') ?? []).join(', ')}.`,
        );
    }
  });

  register('start', async (args) => {
    const lifecycleArgs = parseLifecycleArgs(args);
    validateLifecyclePorts(
      lifecycleArgs.serverPort,
      lifecycleArgs.uiPort,
      lifecycleArgs.consentPort,
    );
    if (args.includes('--clean')) {
      await clean({
        actionLabel: 'start --clean',
        allowDefaultHomeClean: lifecycleArgs.allowDefaultHomeClean,
        force: lifecycleArgs.force,
        homeSource: lifecycleArgs.homeSource,
        instanceName: lifecycleArgs.instanceName,
        projectHome: lifecycleArgs.baseDir,
        serverPort: lifecycleArgs.serverPort,
        uiPort: lifecycleArgs.uiPort,
      });
    }
    await start({
      serverPort: lifecycleArgs.serverPort,
      uiPort: lifecycleArgs.uiPort,
      consentPort: lifecycleArgs.consentPort,
      logFile: lifecycleArgs.logFile,
      build: lifecycleArgs.buildFlag,
      force: lifecycleArgs.force,
      allowSharedHome: lifecycleArgs.allowSharedHome,
      intent: lifecycleArgs.stopIntent,
      rotateLogOnRestart: lifecycleArgs.rotateLogOnRestart,
      baseDir: lifecycleArgs.baseDir,
      homeSource: lifecycleArgs.homeSource,
      instanceName: lifecycleArgs.instanceName,
      features: lifecycleArgs.features,
      host: lifecycleArgs.host,
      // Ad-hoc starts honor the flag too; only `service install` persists
      // it (#1672).
      allowedOrigins: lifecycleArgs.allowedOrigins,
      lifecycleJournal: lifecycleArgs.lifecycleJournal,
      readinessFile: lifecycleArgs.readinessFile,
    });
  });

  register('service', async (args) => {
    if (args.includes('--temp-home')) {
      throw new Error('--temp-home cannot be used with service commands');
    }
    const lifecycleArgs = parseLifecycleArgs(args.slice(1));
    validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
    // No action + a TTY: present the interactive menu. Otherwise (an action, or
    // no TTY) fall through to the ordinary command, whose usage error is the
    // deterministic non-TTY fallback.
    if (args.length === 0) {
      await runServiceMenu(lifecycleArgs, {
        isInteractive: interactive,
        runService: (serviceArgs, lifecycle) =>
          runServiceCommand(serviceArgs, lifecycle),
      });
      return;
    }
    await runServiceCommand(args, lifecycleArgs);
    // Signpost only on the DIRECT plumbing invocation: `setup local` composes
    // this same install and must not tell the user to run setup again (#1098
    // follow-up: the bare install writes no client profile, by design).
    if (args[0] === 'install') {
      console.log(
        'Service installed. To use it from this machine (CLI and browser), save it as your default Station: station setup local',
      );
    }
  });

  register('setup', async (args) => {
    if (args[0] === 'import') {
      await runSetupImportCommand(args.slice(1));
      return;
    }
    await runSetupCommand(args, {
      installLocalService: async (serviceArgs) => {
        assertCommandAvailable('service', ['install', ...serviceArgs]);
        const lifecycleArgs = parseLifecycleArgs(serviceArgs);
        validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
        const receipt = await runServiceCommand(
          ['install', ...serviceArgs],
          lifecycleArgs,
        );
        if (!receipt) {
          throw new Error(
            'Station service install completed without a compensation receipt.',
          );
        }
        return receipt;
      },
      pair: (input) => pairSavedStation(input),
    });
  });

  register('build', async (args) => {
    const lifecycleArgs = parseLifecycleArgs(args);
    validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
    await buildApplication({
      baseDir: lifecycleArgs.baseDir,
      instanceName: lifecycleArgs.instanceName,
      serverPort: lifecycleArgs.serverPort,
      uiPort: lifecycleArgs.uiPort,
    });
  });

  register('stop', (args) => {
    const lifecycleArgs = parseLifecycleArgs(args);
    const hasExplicitBase = args.some((arg) => arg.startsWith('--base='));
    const hasSelector =
      args.some((arg) => arg.startsWith('--instance=')) ||
      args.some((arg) => arg.startsWith('--port=')) ||
      args.some((arg) => arg.startsWith('--ui-port='));
    stop({
      baseDir:
        hasExplicitBase || !hasSelector ? lifecycleArgs.baseDir : undefined,
      instanceName: lifecycleArgs.instanceName,
      serverPort: args.some((arg) => arg.startsWith('--port='))
        ? lifecycleArgs.serverPort
        : undefined,
      uiPort: args.some((arg) => arg.startsWith('--ui-port='))
        ? lifecycleArgs.uiPort
        : undefined,
      ...(lifecycleArgs.stopIntent ? { intent: lifecycleArgs.stopIntent } : {}),
    });
  });

  register('fresh', async (args) => {
    const lifecycleArgs = parseLifecycleArgs(args);
    validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
    await clean({
      actionLabel: 'fresh',
      allowDefaultHomeClean: lifecycleArgs.allowDefaultHomeClean,
      force: lifecycleArgs.force,
      homeSource: lifecycleArgs.homeSource,
      instanceName: lifecycleArgs.instanceName,
      projectHome: lifecycleArgs.baseDir,
      serverPort: lifecycleArgs.serverPort,
      uiPort: lifecycleArgs.uiPort,
    });
  });

  register('cloud', (args) => runCloudCommand(args));

  register('home', (args) => {
    const [homeAction, ...homeArgs] = args;
    if (!['backup', 'reset', 'restore', 'verify'].includes(homeAction ?? '')) {
      throw new Error(
        'Usage: station home <backup|restore|reset|verify> [options]',
      );
    }
    const lifecycleArgs = parseLifecycleArgs(homeArgs);
    validateLifecyclePorts(lifecycleArgs.serverPort, lifecycleArgs.uiPort);
    if (homeAction === 'verify') {
      let result: ReturnType<typeof homeVerify>;
      try {
        result = homeVerify({
          homeSource: lifecycleArgs.homeSource,
          instanceName: lifecycleArgs.instanceName,
          projectHome: lifecycleArgs.baseDir,
          serverPort: lifecycleArgs.serverPort,
          uiPort: lifecycleArgs.uiPort,
        });
      } catch (error) {
        // A home that does not exist is the documented exit-3 case —
        // "nothing was verified" — not exit 1, which the table reserves for
        // corrupt bytes. Falling through to the generic catch would page
        // every corruption-alerting script over a typo'd --base.
        if ((error as { code?: unknown })?.code === 'STATION_HOME_MISSING') {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 3;
          return;
        }
        throw error;
      }
      if (homeArgs.includes('--json')) console.log(JSON.stringify(result));
      else {
        for (const store of result.results) {
          const detail = store.detail === undefined ? '' : ` — ${store.detail}`;
          // `absent` gets its own mark: a store this home has never created
          // is not a finding, and printing it beside a failure mark would
          // read as one.
          const mark =
            store.verdict === 'ok'
              ? '✓'
              : store.verdict === 'absent'
                ? '–'
                : '✗';
          console.log(
            `${mark} ${store.verdict} ${store.databasePath} (${store.durationMs}ms)${detail}`,
          );
        }
      }
      // A verdict an operator has to act on must not exit 0. `corrupt` and
      // `unavailable` stay distinct codes: only the first says anything about
      // the bytes.
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
      return;
    }
    if (homeAction === 'backup') {
      const output = homeArgs
        .find((arg) => arg.startsWith('--output='))
        ?.slice('--output='.length);
      const result = homeBackup({
        homeSource: lifecycleArgs.homeSource,
        instanceName: lifecycleArgs.instanceName,
        outputDir: output,
        projectHome: lifecycleArgs.baseDir,
        serverPort: lifecycleArgs.serverPort,
        uiPort: lifecycleArgs.uiPort,
      });
      if (homeArgs.includes('--json'))
        console.log(
          JSON.stringify({
            backupDir: result.backupDir,
            createdAt: result.manifest.createdAt,
            fileCount: result.manifest.files.length,
            homeSchemaVersion: result.manifest.homeSchemaVersion,
            totalBytes: result.manifest.totalBytes,
          }),
        );
      else console.log(`✓ Backed up Station home to ${result.backupDir}`);
      return;
    }
    if (homeAction === 'restore') {
      const backupDir = homeArgs
        .find((arg) => arg.startsWith('--from='))
        ?.slice('--from='.length);
      if (!backupDir)
        throw new Error(
          'Usage: station home restore --from=<backup-dir> --confirm [--base=<dir>] [--json]',
        );
      const result = homeRestore({
        backupDir,
        confirm: lifecycleArgs.confirm,
        homeSource: lifecycleArgs.homeSource,
        instanceName: lifecycleArgs.instanceName,
        projectHome: lifecycleArgs.baseDir,
        serverPort: lifecycleArgs.serverPort,
        uiPort: lifecycleArgs.uiPort,
      });
      if (homeArgs.includes('--json'))
        console.log(
          JSON.stringify({
            homeDir: result.homeDir,
            previousHome: result.previousHome,
            restoredFrom: backupDir,
            fileCount: result.manifest.files.length,
            totalBytes: result.manifest.totalBytes,
          }),
        );
      else {
        console.log(`✓ Restored Station home from ${backupDir}`);
        if (result.previousHome)
          console.log(`  Previous home retained at ${result.previousHome}`);
      }
      return;
    }
    const result = homeReset({
      confirm: lifecycleArgs.confirm,
      homeSource: lifecycleArgs.homeSource,
      ifIncompatible: homeArgs.includes('--if-incompatible'),
      instanceName: lifecycleArgs.instanceName,
      projectHome: lifecycleArgs.baseDir,
      serverPort: lifecycleArgs.serverPort,
      uiPort: lifecycleArgs.uiPort,
    });
    if (homeArgs.includes('--json')) {
      console.log(JSON.stringify(result));
    } else if (result.archived) {
      console.log(`✓ Archived Station home to ${result.archivePath}`);
      console.log(
        `  A fresh home will be created at ${result.projectHome} on next start.`,
      );
    } else {
      console.log(`Nothing to archive at ${result.projectHome}.`);
    }
  });

  register('config', async (args) => {
    // `--offline` is a flag, not a positional — parse it out before reading
    // `sub`/`key`/`value` so `station config --offline` (bare, offline) still
    // resolves `sub` to `undefined` rather than the flag string itself.
    const parsedConfigArgs = parseCoreArgs(args);
    const [sub, key, value] = parsedConfigArgs.positionals;
    if (sub === 'set') await configSet(key, value, parsedConfigArgs);
    else if (sub === 'get') await configGet(key, parsedConfigArgs);
    else if (sub === undefined)
      await configGet(undefined, parsedConfigArgs); // bare `station config` shows all
    // A typo'd action must not read as success.
    else
      failUnknownCommand(
        `config ${sub}`,
        didYouMean(sub, actionsFor('config') ?? []),
        'Valid config actions: get, set (or no action to show every value).',
      );
  });

  register('checkpoints', async (args) => {
    await runCheckpointsCommand(args);
  });

  register('environment', async (args) => {
    await runEnvironmentCommand(args, {
      ...(dependencies.createEnvironmentSecurityService
        ? { createService: dependencies.createEnvironmentSecurityService }
        : {}),
      ...(dependencies.createPeerCredentialStore
        ? {
            createPeerCredentialStore: dependencies.createPeerCredentialStore,
          }
        : {}),
      ...(dependencies.createSshEnvironmentProfileStore
        ? {
            createSshEnvironmentProfileStore:
              dependencies.createSshEnvironmentProfileStore,
          }
        : {}),
      projectHome: PROJECT_HOME,
      isInteractive: dependencies.isInteractive ?? Boolean(process.stdin.isTTY),
      ...(dependencies.confirm ? { confirm: dependencies.confirm } : {}),
    });
  });

  register('export', (args) => {
    const formatArg = args.find((arg) => arg.startsWith('--format='));
    const outputArg = args.find((arg) => arg.startsWith('--output='));
    const format = formatArg?.slice(formatArg.indexOf('=') + 1);
    if (!format) {
      throw new Error(
        'Usage: station export --format=<agents-md|claude-desktop>',
      );
    }
    exportConfig({
      format: format as 'agents-md' | 'claude-desktop',
      output: outputArg?.slice(outputArg.indexOf('=') + 1),
      includeSecrets: args.includes('--include-secrets'),
    });
  });

  register('registry', async (args) => {
    if (['agents', 'skills', 'integrations', 'plugins'].includes(args[0])) {
      await runRegistryCatalogCommand(args);
      return;
    }
    if (args[0] === 'install') {
      const registryId = args[1];
      await installRegistryPlugin(registryId, parseCoreArgs(args.slice(2)));
      return;
    }
    await registry(args[0]);
  });

  return program;
}

const TASK_PROTECTED_REFERENCE_ACTIONS = new Set([
  'attach-input',
  'show-inputs',
  'attach-result',
  'show-results',
  'show-support',
  'list-support-bundles',
  'list-support-claims',
  'attach-support',
  'replace-support',
  'remove-support',
]);

const TASK_USER_INPUT_REFERENCE_ACTIONS = new Set([
  'attach-input',
  'show-inputs',
]);

const TASK_TOOL_RESULT_REFERENCE_ACTIONS = new Set([
  'attach-result',
  'show-results',
]);

function protectedReferenceFailureStatus(error: unknown): number | undefined {
  const value = (error as { status?: unknown })?.status;
  return typeof value === 'number' ? value : undefined;
}

function taskUserInputReferenceFailureStatus(
  error: unknown,
): number | undefined {
  if (!(error instanceof TaskUserInputReferenceRequestError)) return undefined;
  return [404, 503].includes(error.status) ? error.status : undefined;
}

function taskToolResultFailureStatus(error: unknown): number | undefined {
  if (!(error instanceof TaskToolResultRequestError)) return undefined;
  return error.status;
}

function protectedReferenceFailureMessage(
  action: string,
  status: number | undefined,
  error: unknown,
): string {
  if (action === 'attach-input' || action === 'show-inputs') {
    return status === 503
      ? 'User input references are temporarily unavailable. Retry the request.'
      : 'User input references are unavailable.';
  }
  if (
    action === 'attach-result' ||
    action === 'show-results' ||
    action === 'inspect'
  ) {
    return status === 503
      ? 'Tool results are temporarily unavailable. Retry the request.'
      : 'Tool results are unavailable.';
  }
  return describeCliError(error);
}

/**
 * Protected capability reads keep their CLI failures generic, and let --json
 * remain machine-readable without exposing server diagnostics. Other core
 * commands keep their established propagation shape.
 */
async function runCoreCliAction(
  command: string,
  rawArgs: string[],
): Promise<void> {
  try {
    await runCoreCommand(command, rawArgs);
  } catch (error) {
    const action = rawArgs[0] ?? '';
    const isTaskProtectedAction =
      command === 'tasks' && TASK_PROTECTED_REFERENCE_ACTIONS.has(action);
    const isSessionToolResultAction =
      command === 'sessions' && action === 'inspect';
    if (!isTaskProtectedAction && !isSessionToolResultAction) throw error;

    const isUserInputAction = TASK_USER_INPUT_REFERENCE_ACTIONS.has(action);
    const isToolResultAction =
      TASK_TOOL_RESULT_REFERENCE_ACTIONS.has(action) ||
      isSessionToolResultAction;
    const status = isUserInputAction
      ? taskUserInputReferenceFailureStatus(error)
      : isToolResultAction
        ? taskToolResultFailureStatus(error)
        : protectedReferenceFailureStatus(error);
    if ((isUserInputAction || isToolResultAction) && status === undefined) {
      throw error;
    }
    const message = protectedReferenceFailureMessage(action, status, error);
    if (rawArgs.includes('--json')) {
      console.error(
        JSON.stringify({
          success: false,
          error: message,
          ...(status === undefined ? {} : { status }),
          ...(status === 503 ? { retryable: true } : {}),
        }),
      );
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
  }
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const [command, ...args] = argv;
  const interactive =
    dependencies.isInteractive ?? Boolean(process.stdin.isTTY);

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(versionText().trimEnd());
    return;
  }

  // Explicit help (`--help`/`-h`, `station help`, `station help --help`) prints
  // usage as a success. Handled before the default launcher so a bare `--help`
  // never lazy-starts.
  if (
    command === '--help' ||
    command === '-h' ||
    (command === 'help' && (args.length === 0 || args[0].startsWith('-')))
  ) {
    console.log(usageText());
    return;
  }

  // `station help <verb>` and `station <verb> [...] --help` land here, at any
  // depth: a help flag anywhere wins over the command's own parsing.
  if (command === 'help') {
    if (printHelpFor(args[0])) return;
    failUnknownCommand(args[0], didYouMean(args[0], knownCommands()));
    return;
  }
  if (
    command !== undefined &&
    (args.includes('--help') || args.includes('-h'))
  ) {
    if (printHelpFor(command)) return;
  }

  // Bare `station [dir]` / `station <default-flag>` — the launcher. In a TTY it
  // resolves a running Station and opens it (or offers to start one); with no
  // TTY and no action flag it prints usage, exactly as bare `station` always
  // has, so the pinned bare-invocation contract holds.
  if (isDefaultInvocation(command)) {
    // This must be before argument parsing, timeout configuration, probing,
    // profile/keyring use, and lazy-start runner composition. Every default
    // shape can otherwise become an implicit host lifecycle request.
    assertDefaultInvocationAvailable();
    const options = parseDefaultArgs(argv);
    if (
      !interactive &&
      !options.inline &&
      !options.service &&
      !options.tempHome
    ) {
      console.log(usageText());
      return;
    }
    configureRequestTimeout();
    await runLazyStart(options, {
      isInteractive: interactive,
      probe: probeInstance,
      mintToken: mintBootstrapTokenForOpener,
      runners: {
        inline: (o) => runInlineStart(o),
        service: (o) => runServiceInstall(o),
        tempHome: (o) => runInlineStart({ ...o, tempHome: true }),
      },
      printUsage: () => console.log(usageText()),
    });
    return;
  }

  // Contributor-tier verbs need a Station repository checkout. From the
  // published bundle they refuse by name (see `./distribution.ts`) rather than
  // half-running against whatever directory the user is standing in. `--help`
  // for those verbs is answered above.
  assertCommandAvailable(command!, args);

  // Every Station request gets a deadline from here on, so a listening-but-
  // silent server fails loudly instead of hanging with no output.
  configureRequestTimeout();

  // Manual unknown-command arm: an unrecognized verb never reaches Commander,
  // so Commander's own "unknown command" handling can never override the pinned
  // stderr message + exitCode-1 semantics.
  if (!KNOWN_COMMANDS.has(command!)) {
    failUnknownCommand(command!, didYouMean(command!, knownCommands()));
    return;
  }

  // Help, version, default/contributor/host refusals, and unknown input must
  // not construct or query the platform keyring. The executable provides this
  // adapter lazily only for a dispatchable client command.
  await dependencies.configureProfileCredentialStore?.();

  // Recognized verb: route through Commander. The raw post-verb args are passed
  // as operands after `--` so Commander parses none of them as options, leaving
  // every per-command flag contract to the hand-rolled parsers in the actions.
  await buildProgram(dependencies, interactive).parseAsync(
    [command!, '--', ...args],
    { from: 'user' },
  );
}

/**
 * The single place a thrown CLI error becomes user-facing text. Transport
 * failures are rewritten to name the Station that was targeted and where that
 * address came from; everything else is reported verbatim.
 */
export function describeCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return explainRequestFailure(error, getResolvedApiBase()) ?? message;
}

// `scripts/station-cli.ts` is the only supported source entry: it establishes
// the code-root context before importing this library.  Keep the published
// bundle's bin entry untouched, but fail direct source execution loudly rather
// than retaining a second cwd-derived launch path.
if (
  !isBundledDistribution() &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  console.error('Direct CLI source execution is unsupported; use ./station.');
  process.exitCode = 1;
}
