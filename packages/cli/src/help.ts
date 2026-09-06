/**
 * `station --help`, `station <verb> --help`, and the action vocabulary the
 * error paths quote back.
 *
 * One table drives three surfaces that used to drift apart: the top-level
 * summary, per-command help (which did not exist — `station agents --help`
 * printed `Error: Missing action for agents`), and the "you typed something
 * that isn't an action" messages. Keeping the valid actions in a single place
 * is what lets an unknown action name its siblings instead of dumping the
 * whole manual.
 *
 * The full prose reference stays in `docs/reference/cli.md`; this is the
 * in-terminal short form.
 */

import { REVIEW_EVIDENCE_OPERATOR_OPERATIONS } from '@kontourai/station-contracts/review-evidence';
import { SCHEDULER_OPERATOR_OPERATIONS } from '@kontourai/station-contracts/scheduler';
import { resolveStationRuntimeContext } from '@kontourai/station-shared/runtime-path-resolver';
import {
  bundledAvailabilityNote,
  isBundledDistribution,
} from './distribution.js';

interface VerbSpec {
  /** One line in the top-level summary. */
  summary: string;
  /** Usage line(s) for per-command help. Defaults to `station <verb> <action>`. */
  usage?: string[];
  /** Valid actions, used by help and by unknown-action suggestions. */
  actions?: string[];
  /** Extra lines (flags, notes) appended to per-command help. */
  detail?: string[];
  /** Command talks to a running Station, so the target flags apply. */
  targets?: boolean;
  /** Group heading in the top-level summary. */
  group: Group;
}

type Group =
  | 'Lifecycle'
  | 'Stations'
  | 'Configuration'
  | 'Plugins'
  | 'Core Workspace'
  | 'Setup';

const runtimeHelp = (() => {
  const context = resolveStationRuntimeContext();
  const channelHome =
    context.channel === 'dev'
      ? '<STATION_ROOT>/instances/dev/<worktree-id>'
      : `<STATION_ROOT>/instances/${context.channel}`;
  return {
    channelHome,
    loopbackApiBase: `http://127.0.0.1:${context.serverPort}`,
    serverPort: context.serverPort,
    uiPort: context.uiPort,
  };
})();

const TARGET_FLAGS = [
  'Target flags (any command that talks to a running Station):',
  '  --station=<name>        Target a Station saved on this device',
  '  --api-base=<url>        Target one Station directly for bootstrap/diagnostics',
  '  --credential=<token>    Authenticate (or set STATION_API_CREDENTIAL)',
  '  --verbose               Print the resolved Station and endpoint to stderr',
  '',
  'Resolution order: --api-base, --station, STATION_TARGET, the deliberate',
  `project Station selection, the default Station, the active local Station, then ${runtimeHelp.loopbackApiBase}.`,
  'Requests give up after 30s; override',
  'with STATION_REQUEST_TIMEOUT_MS=<ms> (0 disables the deadline).',
];

const VERBS: Record<string, VerbSpec> = {
  start: {
    group: 'Lifecycle',
    summary: 'Start the application (auto-builds if needed)',
    usage: ['station start [options]'],
    detail: [
      'Options:',
      '  --clean               Wipe and rebuild before starting',
      '  --force               Skip confirmation prompt (use with --clean)',
      '  --allow-shared-home   Start even though another live instance owns this home',
      '                        (default: refuse — concurrent writers silently lose data)',
      '  --allow-default-home-clean',
      '                        Explicitly allow deleting the selected channel default home',
      '  --build               Force rebuild before starting',
      `  --home=<dir>          Runtime home (default: STATION_HOME or ${runtimeHelp.channelHome})`,
      '  --base=<dir>          Same as --home, under its original name',
      '  --temp-home           Create and use a throwaway home under the temp dir',
      '  --instance=<name>     Stable instance name for targeted stop/restart',
      `  --port=<n>            Server port (resolved default: ${runtimeHelp.serverPort})`,
      `  --ui-port=<n>         UI port (resolved default: ${runtimeHelp.uiPort})`,
      '  --consent-port=<n>    Consent listener port (default: server port + 3)',
      '  --host=<address>      Bind server and UI to an IPv4/IPv6 address',
      '  --features=<flags>    Comma-separated feature flags (e.g. strands-runtime)',
      '  --log[=<path>]        Redirect server output to a log file',
    ],
  },
  dev: {
    group: 'Lifecycle',
    summary: 'Launch a per-worktree dev instance on stable, uncommon ports',
    usage: ['station dev [options]'],
    detail: [
      'Runs the same start path as `station start`, but derives a',
      'DETERMINISTIC, per-worktree server/UI port pair and an isolated home so',
      'a bleeding-edge dev instance never collides with the reserved dogfood',
      'release channels and a shared URL stays valid across restarts. Binds 0.0.0.0',
      'by default so a phone or LAN/tailnet client can reach the stable URL.',
      '',
      'Options:',
      '  --port-offset=<n>     Force an exact port offset (0-500)',
      '  --host=<address>      Bind address (default: 0.0.0.0)',
      '  --build               Force rebuild before starting',
      "  --clean               Wipe this dev instance's isolated home first",
      '  --force               Skip cleanup prompt / force restart',
      '  --features=<flags>    Comma-separated feature flags',
      '  --dry-run             Print the resolved ports/home and exit',
      '',
      'Ports: server 39141-39640, ui 40141-40640 (deliberately uncommon:',
      'clear of the reserved dogfood and common dev ports, below the OS',
      'ephemeral range). Home: <STATION_ROOT>/instances/dev/<worktree-id>',
      '(external to the worktree, so it survives a worktree cleanup).',
      '',
      'Env overrides (precedence high to low):',
      '  STATION_PORT_OFFSET   Exact numeric offset (wins over everything)',
      '  STATION_DEV_INSTANCE  Seed: numeric = exact offset, else hashed; also',
      '                        names the instance/home',
      '  (else) the worktree path is hashed to a stable offset',
    ],
  },
  build: {
    group: 'Lifecycle',
    summary: 'Build application artifacts without stopping or starting',
    usage: ['station build [options]'],
    detail: [
      'Options:',
      '  --instance=<name>     Build for a stable named instance',
      '  --home=<dir>          Station home used to resolve the instance',
      '  --base=<dir>          Same as --home, under its original name',
      '  --port=<n>            Server port used to resolve the instance',
      '  --ui-port=<n>         UI port used to resolve the instance',
    ],
  },
  stop: {
    group: 'Lifecycle',
    summary: 'Stop a running application instance',
    usage: ['station stop [options]'],
    detail: [
      'Options:',
      '  --instance=<name>     Stop a named instance',
      '  --home=<dir>          Stop the instance using a specific home',
      '  --base=<dir>          Same as --home, under its original name',
      '  --port=<n>            Match by server port',
      '  --ui-port=<n>         Match by UI port',
    ],
  },
  fresh: {
    group: 'Lifecycle',
    summary: 'Remove the selected home + shared build output',
    usage: ['station fresh [options]'],
    detail: [
      'Options:',
      '  --force               Skip confirmation prompt',
      '  --allow-default-home-clean',
      '                        Explicitly allow deleting the selected channel default home',
      `  --home=<dir>          Runtime home to clean (default: STATION_HOME or ${runtimeHelp.channelHome})`,
      '  --base=<dir>          Same as --home, under its original name',
      '  --temp-home           Create and clean a throwaway home under the temp dir',
      '  --instance=<name>     Stable instance name for targeted cleanup',
      '  --port=<n>            Server port used for instance targeting',
      '  --ui-port=<n>         UI port used for instance targeting',
    ],
  },
  cloud: {
    group: 'Lifecycle',
    summary: 'Prepare cloud environments and copy encrypted Git workspaces',
    actions: [
      'preview',
      'template',
      'keygen',
      'pack-workspace',
      'inspect-workspace',
      'unpack-workspace',
      'verify-workspace',
      'import-project',
    ],
    usage: [
      'station cloud preview --home=<path> --provider=<aws-ec2|gcp-compute> --region=<region> --instance-type=<type> [--json]',
      'station cloud template --provider=aws-ec2 --region=<region> --instance-type=<type> --image=<digest-pinned-image> --output=<new-file>',
      'station cloud keygen --output=<new-key-file>',
      'station cloud pack-workspace --workspace=<checkout-root> --key-file=<key> --output=<new-package> --source-paused',
      'station cloud inspect-workspace --archive=<package> --key-file=<key>',
      'station cloud unpack-workspace --archive=<package> --key-file=<key> --destination=<new-directory>',
      'station cloud verify-workspace --archive=<package> --key-file=<key> --workspace=<restored-checkout> --workspace-paused',
      'station cloud import-project --archive=<package> --key-file=<key> --destination=<new-directory> --target-workspace=<server-path> --name=<name> --slug=<slug> --station=<enrolled-target>',
    ],
    detail: [
      'Read-only metadata preview. Does not export credentials or move running work.',
      'GCP preview supports e2-micro, e2-small, and e2-medium; template generation is currently AWS-only.',
      'Whole-setup transfer and resume remain unavailable. Workspace packages copy data only.',
      'Packages include reachable Git history and non-ignored working files, which may contain secrets.',
      'unpack-workspace creates a fresh workspace without registration. import-project also creates and reads back a fresh target Project.',
      'Neither operation enrolls credentials or executes code. Failed registration retains the import for explicit reconciliation.',
    ],
  },
  home: {
    group: 'Lifecycle',
    summary: 'Verify, back up, restore, or archive a Station home',
    usage: [
      'station home verify [--json] [options]',
      'station home backup [--output=<directory>] [options]',
      'station home restore --from=<directory> --confirm [options]',
      'station home reset --confirm [options]',
    ],
    actions: ['verify', 'backup', 'restore', 'reset'],
    detail: [
      '`verify` runs an integrity check over the SQLite stores this home',
      'owns and reports each one. It opens them read-only, so it is safe to',
      'run while Station is up. Exit 1 means a store is corrupt; exit 2 means',
      'a store could not be read, which is not the same claim.',
      '`backup` creates a content-hashed, schema-bound offline snapshot.',
      '`restore` validates every file and atomically swaps the selected home,',
      'retaining the previous home beside it for recovery.',
      '',
      'The gate that fails a home with `STATION_HOME_RESET_REQUIRED` is',
      'intentionally strict: an old, marker-less, or wrong-version home is',
      'never absorbed. `station home reset` is the supported bridge --',
      'it renames (never deletes) the existing home aside with a',
      'timestamp, so a fresh one is scaffolded on next start.',
      '',
      'Options:',
      '  --output=<directory>  Backup destination (backup only)',
      '  --from=<directory>    Validated backup source (restore only)',
      '  --confirm              Required: archive the home (data is kept,',
      '                         never deleted)',
      '  --if-incompatible      No-op instead of archiving when the home',
      '                         already satisfies the current schema gate',
      `  --home=<dir>           Runtime home to act on (default: STATION_HOME or ${runtimeHelp.channelHome})`,
      '  --base=<dir>           Same as --home, under its original name',
      '  --instance=<name>      Stable instance name used for instance',
      '                         targeting and the running-instance refusal',
      '  --port=<n>             Server port used for instance targeting',
      '  --ui-port=<n>          UI port used for instance targeting',
      '  --json                 Print the result as JSON',
      '',
      'Every action except `verify` refuses while a Station instance for the',
      'target home is running -- stop it first with `station stop`.',
    ],
  },
  upgrade: {
    group: 'Lifecycle',
    summary: 'Pull latest + rebuild (keeps plugins)',
    usage: ['station upgrade'],
  },
  service: {
    group: 'Lifecycle',
    summary: 'Install and manage Station as a user service',
    actions: ['install', 'start', 'status', 'stop', 'uninstall', 'run'],
    detail: [
      'run is the foreground supervisor: it runs the server and UI in the',
      'current process and never returns. It is what the installed systemd',
      'unit, launchd plist, and container image invoke, and it is the way to',
      'supervise Station on a host with no service manager (a container, or',
      'any Linux without a systemd user session). Use install/start for a',
      'durable OS-registered service; use `station start` to launch detached.',
      '',
      'Options:',
      '  --json                status: print machine-readable status',
      `  --home=<dir>          Runtime home for the service (default: STATION_HOME or ${runtimeHelp.channelHome})`,
      '  --base=<dir>          Same as --home, under its original name',
      '  --instance=<name>     Stable service instance name',
      `  --port=<n>            Server port (resolved default: ${runtimeHelp.serverPort})`,
      `  --ui-port=<n>         UI port (resolved default: ${runtimeHelp.uiPort})`,
      '  --host=<address>      Bind server and UI (default: 127.0.0.1)',
    ],
  },
  stations: {
    group: 'Stations',
    summary: 'Manage Stations saved on this device and pick a default',
    usage: [
      'station stations list',
      'station stations show <name>',
      'station stations add <name> <endpoint> [--pair] [--default] [--force]',
      'station stations edit <name> <endpoint> [--pair] [--default] [--force]',
      'station stations pair <name> [--force]',
      'station stations use <name>',
      'station stations forget <name>',
      'station stations project show|use <name>|clear',
      'station stations export',
    ],
    actions: [
      'list',
      'show',
      'add',
      'edit',
      'pair',
      'use',
      'forget',
      'project',
      'export',
    ],
    detail: [
      'A bare `station stations` lists the Stations saved on this device.',
      'Saved Station metadata references credentials retained only in the OS credential store.',
      '',
      ...TARGET_FLAGS,
    ],
  },
  target: {
    group: 'Stations',
    summary: 'Show the exact Station and endpoint a command will use',
    usage: ['station target [--station=<name>|--api-base=<url>]'],
    detail: [
      'Reports the Station, endpoint, Environment identity, credential state,',
      'reachability, and local-service state when the endpoint is local.',
      'It never starts a Station or substitutes another target.',
    ],
  },
  triage: {
    group: 'Stations',
    summary: 'Create a bounded, read-only diagnostic hand-off',
    usage: [
      'station triage [--context-only] [--agent=codex|claude] [--problem=<text>] [--search-issues] [--station=<name>|--api-base=<url>] [--credential=<token>]',
    ],
    detail: [
      'Creates owner-only portable artifacts below <STATION_ROOT>/cache/triage.',
      '--context-only skips agent probing and launch, but retains read-only',
      'source-doctor and authenticated remote diagnostics. Without it,',
      'Station launches only hardened Codex read-only mode or Claude safe plan mode.',
      '--problem adds a bounded redacted symptom. --search-issues explicitly',
      'authorizes sending it to the fixed read-only Station issue search.',
      'When both agents are available, a TTY asks; a non-interactive shell',
      'requires --agent=codex or --agent=claude.',
      'The packaged client does not inspect local files or run the source doctor.',
      'Triage never repairs, changes Station state, patches source, or posts to GitHub.',
    ],
  },
  setup: {
    group: 'Stations',
    summary:
      'Set up a local, existing, or hosted Station; import existing setup',
    usage: [
      'station setup local [--name=kontour] [service flags]',
      'station setup existing <name> <endpoint> [--pair] [--device-name=<name>]',
      'station setup hosted [--name=station.kontourai.io] [--device-name=<name>]',
      'station setup import detect|preview|review-targets|apply|receipt|rollback [options]',
    ],
    actions: ['local', 'existing', 'hosted', 'import'],
    detail: [
      'Setup is the deliberate boundary that selects a default Station.',
      'Local setup installs a durable per-user service from a Station checkout.',
      'Hosted setup pairs with https://station.kontourai.io through the same OS-keyring path.',
      'Existing setup pairs only when --pair is supplied.',
      'Import is content-free: detect supported sources, preview reviewed metadata, then apply explicit item choices.',
      '  station setup import detect [target flags]',
      '  station setup import preview <source-id> [target flags]',
      '  station setup import review-targets <preview-id> --data={"items":[...]} [target flags]',
      '  station setup import apply <preview-id> --data={"witnessId":"..."} [target flags]',
      '  station setup import receipt|rollback <receipt-id> [target flags]',
    ],
  },
  environment: {
    group: 'Stations',
    summary: 'Manage environment identity, credentials, and SSH hosts',
    usage: [
      'station environment show',
      'station environment credential show|rotate [--force]',
      'station environment reset [--force]',
      'station environment offer [--tailscale] [--tailscale-serve-port=<port>]',
      'station environment access request --api-base=<url> [--station=<name>] [--device-name=<name>] [--timeout=<seconds>] [--force]',
      'station environment access list [--api-base=<loopback-url>|--station=<name>]',
      'station environment access approve|deny [<request-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]',
      'station environment hosts',
      'station environment list',
      'station environment show <id>',
      'station environment add --ssh=<host> --project=<remote-path> [--remote-port=<n>]',
      'station environment connect|stop|remove <id>',
      'station environment peers list',
      'station environment peers add --environment-id=<id> --api-base=<peer-url> --credential=<token> --scope=<space-delimited-scope> [--label=<name>]',
      'station environment peers remove <environment-id>',
    ],
    actions: [
      'show',
      'credential',
      'reset',
      'offer',
      'access',
      'hosts',
      'list',
      'add',
      'connect',
      'stop',
      'remove',
      // #765 D3: `peers` was implemented and documented (docs/reference/
      // cli.md, environment.ts's own USAGE) but hidden from this table, so
      // `station environment --help` denied the verb the Computers page tells
      // users to run. `offer` above had the same usage-but-not-actions gap.
      'peers',
    ],
  },
  config: {
    group: 'Configuration',
    summary: 'Read and write Station configuration values',
    usage: [
      'station config              Show all config values',
      'station config get <key>    Show one value',
      'station config set <key> <value> [--offline]',
    ],
    actions: ['get', 'set'],
    detail: [
      'Set a value to the literal string "null" to unset it. Keys are the',
      'top-level fields of <STATION_HOME>/config/app.json.',
      '',
      "`config set` writes through Station's live PUT /config/app route by",
      'default (station#175), so a running Station never diverges from disk;',
      '--offline writes config/app.json directly instead (still validated).',
      'Unreachable without --offline is an error naming both options.',
    ],
  },
  export: {
    group: 'Configuration',
    summary: 'Export Station configuration for another tool',
    usage: [
      'station export --format=<agents-md|claude-desktop> [--output=<path>] [--include-secrets]  (--include-secrets writes ordinary legacy credentials as plaintext; binding refs never export)',
    ],
    detail: [
      'Options:',
      '  --format=<format>     Required. agents-md or claude-desktop',
      '  --output=<path>       Write to a file instead of stdout',
    ],
  },
  import: {
    group: 'Configuration',
    summary: 'Import a previously exported configuration file',
    usage: [
      'station import <file>  (requiredEnvNames is an untrusted informational hint; Station fails closed when a configured stored credential reference is missing during hydration)',
    ],
  },
  plugin: {
    group: 'Plugins',
    summary: 'Install, inspect, scaffold, build, and preview plugins',
    usage: [
      'station plugin install <source> [--skip=<components>] [--yes]',
      'station plugin preview <source>',
      'station plugin list|build',
      'station plugin remove|info|update <name>',
      'station plugin init [name]',
      'station plugin create [name] [--template=<full|layout|provider>]',
      'station plugin dev [--port=<n>] [flags]',
    ],
    actions: [
      'install',
      'preview',
      'list',
      'remove',
      'info',
      'update',
      'registry',
      'init',
      'create',
      'build',
      'dev',
    ],
    detail: [
      'Install, preview, list, update, and remove use the configured running',
      'Station server so every lifecycle mutation shares registry authority.',
      'Local sources require a Station on the same filesystem; use git URLs',
      'for remote Stations.',
      '',
      'install previews the source first and prints what installing it would',
      'require — permissions, dependency ids, and the parts that run in',
      "Station's own page — then asks. The approval travels with the install",
      'and the server refuses to write anything without it. A non-interactive',
      'run must approve what it saw with --yes.',
      '',
      'Options:',
      '  --skip=<components>   install: skip components (comma-separated)',
      '  --yes                 install: approve the printed disclosure without',
      '                        prompting (required when stdin is not a TTY)',
      '  --template=<name>     create: full, layout, or provider',
      '  --port=<n>            dev: preview server port (default: 4200).',
      '                        A bare positional port still works.',
      '  --no-mcp              dev: disable MCP tool connections',
      '  --tools-dir=<path>    dev: tool configs directory',
      '',
      'The dev server binds 127.0.0.1 only; use SSH local port forwarding for',
      'remote development.',
    ],
  },
  registry: {
    group: 'Plugins',
    summary: 'Browse and install from the plugin/catalog registry',
    usage: [
      'station registry [url]',
      'station registry install <id>',
      'station registry <agents|skills|integrations|plugins> <action>',
    ],
    actions: ['install', 'agents', 'skills', 'integrations', 'plugins'],
    detail: [
      'Catalog actions: list, installed, install <id>, remove|uninstall|delete <id>.',
      '',
      ...TARGET_FLAGS,
    ],
  },
  agents: {
    group: 'Core Workspace',
    summary:
      'List/get/create/update/delete agents (get shows delegation denials)',
    targets: true,
    actions: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'chat',
      'conversations',
      'messages',
      'workflows',
    ],
    detail: [
      'station agents get|update|delete <slug>',
      'station agents chat <slug> <message>',
      'station agents conversations <slug>',
      'station agents messages <slug> <conversation-id>',
      'station agents workflows <list|get|create|update|delete> <slug> [id]',
      '',
      '`agents get` includes the built-in delegated-child denial catalog and',
      'any denials configured for that Agent, as separate groups.',
      '',
      'create/update read JSON from --data=<json>, --file=<path>, or stdin.',
    ],
  },
  chat: {
    group: 'Core Workspace',
    summary: 'Chat with an agent',
    targets: true,
    usage: ['station chat <agent> <message...> [--on=<environment>]'],
    detail: [
      'Options:',
      '  --on=<environment>   Run on a saved Environment (default: current)',
      '  --session=<id>        Start or resume a stable session (--conversation alias)',
      '  cwd                    New chats bind to the invoking shell directory',
      '  --cwd=<path>          Override the invoking directory for a new chat',
      '  --project=<slug>      Select a project context at the invoking directory',
      '                        (use --cwd or --project, not both)',
      '  --model=<id>          Select a model for this session/turn',
      '  --title=<text>        Reserved; rejected until canonical execution supports it',
      '  --approval-mode=<v>   ask|auto|never|connection-default (Engine connections only)',
      '  --effort=<v>          Reasoning effort, e.g. low|medium|high (engine-specific)',
      '  --thinking=<bool>     true|false — enable adaptive thinking (engine-specific)',
      '  --model-option k=v    Escape hatch: any modelOptions key not covered above',
      '                        (repeatable; named flags above win on key collision)',
      '  --on-request=<v>      wait|fail (default wait) — see below',
      '  --json                Emit machine-readable output instead of a stream',
      '',
      '--approval-mode/--effort/--thinking/--model-option only apply when the',
      'selected Agent supports them. The target Environment resolves the Agent,',
      'engine, and model; connections and engines are not execution selectors.',
      'A Station agent has no per-invocation engine settings and rejects them. An option key',
      "the target engine doesn't read is rejected with an explicit error naming",
      'the option and target, never silently dropped. Changed options apply from',
      'the next turn when resuming a session with --session=<id>.',
      '',
      'Streaming turns have no request deadline — they finish when the agent does.',
      '',
      'If the agent opens a pending request (approval/permission/confirmation/',
      'input) mid-turn, a notice naming it and the exact station approvals',
      'respond command prints to stderr instead of the CLI hanging silently.',
      '--on-request=wait (default) keeps waiting for the request to be resolved',
      'out-of-band; --on-request=fail exits 4 instead, leaving the session alive',
      'and resumable (never torn down just because a request is open). --json',
      'carries a typed pendingRequest field (requestId/requestType/title/',
      'respondCommand) plus lifecycleState when either is present.',
    ],
  },
  sessions: {
    group: 'Core Workspace',
    summary: 'List/read/inspect/interrupt managed and runtime sessions',
    targets: true,
    usage: [
      'station sessions list|read|interrupt <agent> [sessionId]',
      'station sessions inspect <agent> <sessionId> <eventId> [--json]',
    ],
    actions: ['list', 'read', 'inspect', 'interrupt'],
    detail: [
      'inspect resolves the exact owner-authorized terminal tool result; protected failures stay generic and 503 responses are retryable.',
      '  --turn=<id>           interrupt: target a specific turn',
    ],
  },
  conversation: {
    group: 'Core Workspace',
    summary: 'Export a conversation as a portable thread (or provider format)',
    targets: true,
    usage: ['station conversation export <agent> <conversationId>'],
    actions: ['export'],
    detail: [
      '  --format=<fmt>        thread (default), anthropic-messages, openai-chat, gemini, markdown',
      '  --output=<path>       write to a file instead of stdout',
    ],
  },
  approvals: {
    group: 'Core Workspace',
    summary: 'List/respond to orchestration approval requests',
    targets: true,
    actions: ['list', 'respond'],
    detail: [
      'station approvals list [--session=<id>] [--json]',
      'station approvals respond <request-id> <decision>',
    ],
  },
  operate: {
    group: 'Core Workspace',
    summary: 'Terminal operator view for a hosted run',
    targets: true,
    usage: ['station operate [--session=<id>]'],
    detail: [
      'Requires an interactive terminal. For scripting use sessions/approvals/chat.',
    ],
  },
  delegate: {
    group: 'Core Workspace',
    summary: 'Delegate a Task and headlessly supervise it',
    targets: true,
    usage: [
      'station delegate --agent=<slug> [--on=<environment>] [options] <prompt|--data=<text>|--file=<path>|stdin>',
      'station delegate --session=<conversation-id> <message> [--on=<environment>] [options]',
      'station delegate status <task-id> [--on=<environment>]',
      'station delegate events <task-id> [--after=<cursor>] [--on=<environment>]',
      'station delegate continue <legacy-id> <message> [--on=<environment>] [--model=<id>] (deprecated compatibility alias)',
      'station delegate respond <task-id> <request-id> <decision> [--on=<environment>]',
      'station delegate interrupt <task-id> [--on=<environment>]',
      'station delegate targets [--on=<environment>] [--project=<slug>|--project-path=<path>]',
    ],
    actions: [
      'status',
      'events',
      'continue',
      'respond',
      'interrupt',
      'targets',
    ],
    detail: [
      'Options (create):',
      '  --agent=<slug>        Delegate to an Agent',
      '  --on=<environment>    Run on a saved Environment (default: current)',
      '  --model=<id>          Select a model for this task',
      '  --project=<slug>      Bind to a project (or --project-path=<path>)',
      '  --cwd=<path>          Bind to an explicit directory instead of a project',
      '                        (no registered project required; use --project/',
      '                        --project-path or --cwd, not both)',
      '  --parent-task=<id>    Create a child task of an existing one',
      '  --approval-mode=<v>   ask|auto|never|connection-default (create + continue,',
      '                        Claude and Codex engines only — most ACP-based',
      '                        External agents reject it)',
      '  --effort=<v>          Reasoning effort, e.g. low|medium|high (create + continue,',
      '                        engine-specific)',
      '  --thinking=<bool>     true|false — enable adaptive thinking (create + continue,',
      '                        engine-specific)',
      '  --model-option k=v    Escape hatch: any modelOptions key not covered above',
      '                        (repeatable; named flags above win on key collision)',
      '  --on-request=<v>      wait|fail (default wait, create + continue) — see below',
      '',
      '--after=<cursor> (events) is the opaque nextCursor a previous page',
      'returned (station-task-events:v1:<n>), never a raw sequence number.',
      '',
      'decision (respond) is one of: accept, acceptForSession, decline, cancel.',
      '',
      "An option key the target engine doesn't support (including a Station agent",
      'target) is rejected with an explicit error naming the option and target,',
      'never silently dropped. --cwd is create-only; continue reuses the cwd bound',
      'at creation.',
      '',
      'create/continue dispatch is fire-and-forget (no live wait), so',
      '--on-request=fail makes one follow-up status check right after dispatch:',
      'if the task already shows a pending request, it prints the request and',
      'the exact station delegate respond command and exits 4 instead of the',
      'ordinary success output; --on-request=wait (default) skips that check.',
      'status/events always surface a pendingRequest with its respond command',
      'when one is open, regardless of --on-request.',
      '',
      'Exit codes (delegate only): 0 success, 1 usage error, 2 transport',
      'failure (Station unreachable/timed out), 3 delegation rejection (bad',
      'target, not ready, or a deps-unavailable response — including an',
      'unsupported modelOptions key), 4 --on-request=fail found a request',
      'already pending right after dispatch (session/task left alive).',
    ],
  },
  projects: {
    group: 'Core Workspace',
    summary: 'CRUD projects and project layouts',
    targets: true,
    actions: ['list', 'get', 'create', 'update', 'delete', 'layouts'],
    detail: [
      'station projects layouts <available|list|get|create|update|delete|from-plugin> ...',
    ],
  },
  tasks: {
    group: 'Core Workspace',
    summary:
      'List, get, create, attach exact answers, inputs, or tool results, support them, and keep immutable task outputs',
    targets: true,
    usage: [
      'station tasks list|get|create [options]',
      'station tasks attach-turn <taskId> --session=<sessionId> --turn=<turnId>',
      'station tasks show-turn <taskId>',
      'station tasks attach-input <taskId> --session=<sessionId> --event=<eventId>',
      'station tasks show-inputs <taskId> [--json]',
      'station tasks attach-result <taskId> --session=<sessionId> --event=<eventId>',
      'station tasks show-results <taskId> [--json]',
      'station tasks show-support <taskId>',
      'station tasks basis <taskId> [--answer-reference=<referenceId>] [--format summary|json]',
      'station tasks list-support-bundles <taskId> --reference=<referenceId>',
      'station tasks list-support-claims <taskId> --reference=<referenceId> --bundle=<bundleId>',
      'station tasks attach-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId>',
      'station tasks replace-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId> --revision=<revision>',
      'station tasks remove-support <taskId> --reference=<referenceId> --revision=<revision>',
      'station tasks list-outputs|get-output <taskId> [outputId]',
      'station tasks keep-output <taskId> --path=<relativePath> --title=<title> --operation=<operationId>',
      'station tasks download-output <taskId> <outputId> --out=<absolute destination>',
      'station tasks delete-output <taskId> <outputId>',
    ],
    actions: [
      'list',
      'get',
      'create',
      'attach-turn',
      'show-turn',
      'attach-input',
      'show-inputs',
      'attach-result',
      'show-results',
      'basis',
      'show-support',
      'list-support-bundles',
      'list-support-claims',
      'attach-support',
      'replace-support',
      'remove-support',
      'list-outputs',
      'get-output',
      'keep-output',
      'download-output',
      'delete-output',
    ],
    detail: [
      'create accepts --json=<json> as well as --data/--file/stdin.',
      'attach-turn stores only the exact Session/turn identity; Station reauthorizes the completed assistant answer before attaching it.',
      "show-turn reopens the Task's authorized exact answer projections, including supported execution provenance when present.",
      'attach-input stores only the exact Session/event identity; Station reauthorizes the authored input before attaching it.',
      "show-inputs reopens the Task's authorized authored-input projections. Protected input failures stay generic; 503 responses are retryable.",
      'attach-result stores only the exact Session/tool-result event identity; Station reauthorizes the terminal result before attaching it.',
      "show-results reopens the Task's authorized safe tool-result projections. Protected result failures stay generic; 503 responses are retryable.",
      'show-support reopens authorized answer cards and their bounded support standing.',
      'attach-support is idempotent; replace-support is explicit compare-and-swap and requires the observed --revision.',
      'Support bundle and claim selectors are opaque authorized IDs; protected answers and support choices report generic not-found.',
      'download-output requires an explicit absolute destination and refuses symlink or existing paths.',
    ],
  },
  skills: {
    group: 'Core Workspace',
    summary: 'List/get/create/update/delete/install skills',
    targets: true,
    actions: ['list', 'get', 'create', 'update', 'delete', 'install'],
  },
  connections: {
    group: 'Core Workspace',
    summary: 'Manage model/runtime connections and credential recovery',
    targets: true,
    usage: [
      'station connections list|models|runtimes|get|create|update|delete|test [options]',
      'station connections recovery <connection-id>',
      'station connections profiles <connection-id>',
      'station connections profile-upsert <connection-id> --data={"ref":"...","label":"..."}',
      'station connections profile-delete|profile-enroll|profile-unenroll <connection-id> <profile-ref>',
      'station connections recovery-policy <connection-id> --automatic=<true|false>',
      'station connections profile-import <connection-id> <profile-ref> [--include-credentials]',
      'station connections profile-apply <connection-id> <profile-ref> --confirm [--timeout-ms=<ms>]',
    ],
    actions: [
      'list',
      'models',
      'runtimes',
      'get',
      'create',
      'update',
      'delete',
      'test',
      'recovery',
      'profiles',
      'profile-upsert',
      'profile-delete',
      'profile-enroll',
      'profile-unenroll',
      'recovery-policy',
      'profile-import',
      'profile-apply',
    ],
    detail: [
      'Credential recovery is manual-first. `recovery` prints the safe application',
      'projection without local labels; `profiles` is the management view and may',
      'show local labels. Automatic recovery remains off until explicitly enabled',
      'with `recovery-policy` and profiles are explicitly enrolled.',
      '',
      'profile-import excludes credentials by default. Pass --include-credentials',
      'only when you explicitly intend to provision them into the selected credential profile.',
      'profile-apply requires --confirm because it runs a provider-backed check and',
      'only reports adoption after that check succeeds.',
    ],
  },
  flow: {
    group: 'Core Workspace',
    summary: 'Drive project Flow runs',
    targets: true,
    usage: ['station flow <action> <project> [run-id] [options]'],
    actions: [
      'definitions',
      'runs',
      'start',
      'get',
      'attach-command',
      'evaluate',
      'report',
    ],
    detail: [
      'attach-command runs a gate command server-side and has no client',
      'deadline; its own --timeout-ms=<ms> bounds it.',
    ],
  },
  tools: {
    group: 'Core Workspace',
    summary: 'Manage tool servers (MCP integrations)',
    targets: true,
    actions: ['list', 'get', 'create', 'update', 'delete', 'reconnect'],
  },
  'secret-bindings': {
    group: 'Core Workspace',
    summary: 'Manage operator-owned MCP secret bindings',
    targets: true,
    actions: [
      'list',
      'get',
      'create',
      'replace',
      'revoke',
      'bind',
      'unbind',
      'migrate-stored-env',
    ],
    detail: [
      'Every mutation takes structured --data JSON. Binding material is never printed or accepted as a CLI flag.',
      '`migrate-stored-env <integration-id>` is keyed by the MCP integration, not a binding id.',
    ],
  },
  notifications: {
    group: 'Core Workspace',
    summary: 'Manage inbox and approval notifications',
    targets: true,
    actions: [
      'list',
      'create',
      'delete',
      'dismiss',
      'clear',
      'providers',
      'action',
      'snooze',
    ],
  },
  monitoring: {
    group: 'Core Workspace',
    summary: 'Query monitoring stats, metrics, and events',
    targets: true,
    actions: ['stats', 'metrics', 'events'],
    detail: [
      'A bare `events` follows the live stream and runs until interrupted;',
      'pass --start/--end/--user-id for a bounded query instead.',
    ],
  },
  schedule: {
    group: 'Core Workspace',
    summary: 'Manage scheduled jobs and scheduler status',
    targets: true,
    actions: [
      'list',
      'jobs',
      ...SCHEDULER_OPERATOR_OPERATIONS.filter(
        (operation) => operation !== 'list',
      ),
    ],
    detail: [
      'station schedule preview <cron> [count] [--timezone=<iana>]',
      '',
      'preview evaluates the expression in --timezone; omitted means UTC,',
      'which is how the scheduler treats a schedule with no zone. A local',
      'weekday rule has no correct fixed-UTC spelling, so pass the zone the',
      'expression is written in or the instants will not be the ones it fires',
      'at.',
    ],
  },
  runs: {
    group: 'Core Workspace',
    summary: 'Read global run history through the neutral runs API',
    targets: true,
    actions: ['list', 'read', 'output'],
    detail: [
      'station runs list',
      'station runs read <run-id>',
      'station runs output --data=<RunOutputRef json>',
      '',
      'output takes a { source, providerId, runId, artifactId, kind } body via',
      '--data=<json>, --file=<path>, or stdin — the fields come from a run',
      "record's own outputs entries.",
    ],
  },
  review: {
    group: 'Core Workspace',
    summary: 'Run and inspect independent review evidence',
    targets: true,
    actions: [...REVIEW_EVIDENCE_OPERATOR_OPERATIONS],
    detail: [
      'station review run <project> --file=<request.json>',
      'station review status <project> <request-id>',
      'station review list <project>',
      'station review read <project> <receipt-id>',
      '',
      'Reviewer findings are evidence input, never a merge or gate verdict.',
    ],
  },
  knowledge: {
    group: 'Core Workspace',
    summary: 'Query and rebuild the knowledge index',
    targets: true,
    actions: [
      'reindex',
      'migrate',
      'status',
      'search',
      'namespaces',
      'docs',
      'documents',
    ],
    detail: [
      'Options:',
      '  --root=<id>           reindex: rebuild only this root (omit for all)',
      '                        search: scope to this root (repeatable; omit for all)',
      '  --top-k=<n>           search: maximum number of results',
      '  --json                search: print the raw results array as JSON',
      '  --project=<slug>      migrate: migrate only this project (omit for all)',
      '',
      'search <query> runs semantic search over the knowledge index and prints',
      're-resolved records (title, category, excerpt), never raw index hits.',
      '',
      'reindex and migrate have no client deadline — they run as long as the',
      'corpus needs.',
    ],
  },
  auth: {
    group: 'Core Workspace',
    summary: 'Check auth status and user directory info',
    targets: true,
    actions: ['status', 'renew', 'terminal', 'users'],
  },
  branding: {
    group: 'Core Workspace',
    summary: 'Read resolved branding config',
    targets: true,
    actions: ['get'],
  },
  feedback: {
    group: 'Core Workspace',
    summary: 'Manage message ratings and learned behavior state',
    targets: true,
    actions: [
      'rate',
      'delete',
      'unrate',
      'ratings',
      'guidelines',
      'analyze',
      'clear-analysis',
      'status',
      'test',
    ],
  },
  insights: {
    group: 'Core Workspace',
    summary: 'Read aggregated product insights',
    targets: true,
    actions: ['get', 'events'],
  },
  acp: {
    group: 'Core Workspace',
    summary: 'Manage ACP status, commands, and connections',
    targets: true,
    actions: ['status', 'commands', 'command-options', 'connections'],
    usage: [
      'station acp connections list',
      'station acp connections create --id=<id> --command=<cmd> [--args=<arg>]... [--name=<name>] [--cwd=<path>]',
      'station acp connections create --data=<json>',
      'station acp connections delete <id>',
    ],
    detail: [
      'The flag form builds the same body as --data and is validated by the',
      'same route schema; it exists so adding an engine does not require',
      'hand-writing JSON. Repeat --args once per argument — each occurrence',
      'becomes one argv entry, and no shell is involved.',
      'Passing create flags together with --data or --file is an error',
      'rather than a silent precedence rule. Piped stdin is not read when',
      'create flags are present.',
    ],
  },
  voice: {
    group: 'Core Workspace',
    summary: 'Manage voice session status and lifecycle',
    targets: true,
    actions: ['status', 'agent', 'create-session', 'delete-session'],
  },
  doctor: {
    group: 'Setup',
    summary: 'Check prerequisites and runtime readiness',
    usage: [
      'station doctor [--json]',
      'station doctor --migrate-playbooks [--dry-run] [--json]',
    ],
    detail: [
      '--migrate-playbooks folds a legacy prompts.json store from an older',
      'home into skills. It never deletes: the old store is archived as',
      'prompts.migrated-<timestamp>/. Add --dry-run to see the whole',
      'report — renames, agent bindings, dropped ids — without writing.',
      'Migrating agent.prompts into agent.skills ACTIVATES bindings that',
      'were previously inert; see',
      'docs/adr/0016-merge-playbooks-into-skills-behind-a-boot-flag.md.',
      "Available through the repo's ./station launcher only.",
    ],
  },
  checkpoints: {
    group: 'Setup',
    summary: 'Inspect and reclaim workspace-checkpoint disk usage',
    usage: [
      'station checkpoints status [--json]',
      'station checkpoints prune --thread=<threadId> [--gc]',
      'station checkpoints prune --all [--gc]',
      'station checkpoints history --thread=<threadId> [--json]',
      'station checkpoints restore --thread=<threadId> --turn=<turnId> [--phase=baseline|settle] --confirm',
    ],
    detail: [
      'Workspace checkpoints (the workspaceCheckpoints setting) snapshot a',
      "project's working directory into hidden git refs at turn boundaries.",
      'git gc cannot reclaim them for gc.reflogExpire days (default 90), so',
      'this command reports per-thread disk usage across checkpointed',
      'repositories and prunes them. prune --gc also runs the git gc that',
      'actually frees the space.',
    ],
  },
  link: {
    group: 'Setup',
    summary: "Add 'station' to PATH (~/.local/bin)",
    usage: ['station link'],
    detail: [
      'Not the same as the launcher flag `./station --link`, which npm-links',
      'the SDK and CLI packages for plugin development.',
    ],
  },
  shortcut: {
    group: 'Setup',
    summary: 'Create a macOS app in ~/Applications',
    usage: ['station shortcut'],
  },
  version: {
    group: 'Setup',
    summary: 'Print the CLI version and build provenance',
    usage: ['station --version'],
  },
};

const GROUP_ORDER: Group[] = [
  'Lifecycle',
  'Stations',
  'Configuration',
  'Plugins',
  'Core Workspace',
  'Setup',
];

/** Every verb the CLI dispatches, for did-you-mean suggestions. */
export function knownCommands(): string[] {
  return Object.keys(VERBS);
}

/** Valid actions for a verb, or `undefined` when it takes no action word. */
export function actionsFor(command: string): string[] | undefined {
  return VERBS[command]?.actions;
}

/** Levenshtein distance, bounded by the shorter input's length. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/**
 * The closest candidate to `input`, or `undefined` when nothing is close
 * enough to be worth suggesting. A wrong suggestion is worse than none, so the
 * threshold scales with the input length and prefix matches win outright.
 */
export function suggest(
  input: string,
  candidates: string[],
): string | undefined {
  const needle = input.toLowerCase();
  if (needle.length === 0) return undefined;
  const prefixMatch = candidates.find((candidate) =>
    candidate.toLowerCase().startsWith(needle),
  );
  if (prefixMatch) return prefixMatch;

  const threshold = needle.length <= 4 ? 1 : needle.length <= 7 ? 2 : 3;
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
}

/** `Did you mean 'agents'? ` — empty when nothing is close enough. */
export function didYouMean(input: string, candidates: string[]): string {
  const match = suggest(input, candidates);
  return match ? `Did you mean '${match}'? ` : '';
}

function wrapList(values: string[], indent: string, width = 72): string[] {
  const lines: string[] = [];
  let current = indent;
  values.forEach((value, index) => {
    const token = index === values.length - 1 ? value : `${value},`;
    const piece = current === indent ? token : ` ${token}`;
    if (current.length + piece.length > width && current !== indent) {
      lines.push(current);
      current = `${indent}${token}`;
      return;
    }
    current += piece;
  });
  if (current !== indent) lines.push(current);
  return lines;
}

/** Per-command help, or `undefined` for a verb we do not document. */
export function commandHelpText(command: string): string | undefined {
  const spec = VERBS[command];
  if (!spec) return undefined;

  const lines: string[] = [];
  lines.push(`station ${command} — ${spec.summary}`);
  lines.push('');
  lines.push('Usage:');
  for (const usage of spec.usage ?? [`station ${command} <action> [options]`]) {
    lines.push(`  ${usage}`);
  }
  if (spec.actions && spec.actions.length > 0) {
    lines.push('');
    lines.push('Actions:');
    lines.push(...wrapList(spec.actions, '  '));
  }
  if (spec.detail && spec.detail.length > 0) {
    lines.push('');
    lines.push(...spec.detail);
  }
  if (spec.targets) {
    lines.push('');
    lines.push(...TARGET_FLAGS);
  }
  lines.push('');
  lines.push('Run `station --help` for the full command list.');
  return `${lines.join('\n')}\n`;
}

/**
 * The top-level summary: one line per command, grouped, with a pointer to the
 * per-command help. It replaced a 156-line wall that reprinted every flag of
 * every command — unreadable at exactly the moment someone is lost.
 */
export function usageText(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Station CLI (@kontourai/station-cli)');
  lines.push('');
  lines.push('Usage:');
  lines.push('  station <command> [action] [options]');
  lines.push('');
  lines.push('  station --help          This summary');
  lines.push('  station <command> --help');
  lines.push('                         Actions and flags for one command');
  lines.push('  station --version       CLI version and build provenance');

  const width = 28;
  for (const group of GROUP_ORDER) {
    lines.push('');
    lines.push(`${group}:`);
    for (const [command, spec] of Object.entries(VERBS)) {
      if (spec.group !== group || command === 'version') continue;
      const label = spec.actions
        ? `station ${command} <action>`
        : `station ${command}`;
      lines.push(`  ${label.padEnd(width)} ${spec.summary}`);
    }
  }

  // The same distribution authority that rejects unavailable commands supplies
  // this copy, so help cannot advertise a second, drifting capability set.
  if (isBundledDistribution()) {
    lines.push('');
    lines.push(...bundledAvailabilityNote());
  }

  lines.push('');
  lines.push(
    'Commands resolve their target in this order: --api-base=<origin>,',
  );
  lines.push(
    `--station=<name>, STATION_TARGET, the deliberate project Station selection, the default Station, the active local Station, ${runtimeHelp.loopbackApiBase}.`,
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}
