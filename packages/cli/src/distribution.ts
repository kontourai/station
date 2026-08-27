/**
 * How this CLI was launched: as the published, bundled executable, or from a
 * Station repository checkout.
 *
 * `packages/cli/esbuild.config.mjs` writes a `__STATION_CLI_BUNDLE__` marker
 * into the bundle's banner, so the marker is present exactly when the code is
 * running as `dist/station.mjs` and absent when a contributor runs the
 * TypeScript sources through the repo-root `./station` launcher. That single
 * fact drives two behaviours the tier split in `docs/design/cli-product.md`
 * asks for, and nothing else in the CLI branches on packaging.
 */

import { parseCoreArgs } from './commands/core-api.js';
import { normalizeEnvironmentArgsForParsing } from './commands/environment.js';

/** Build-time facts the bundle carries about itself. */
export interface StationCliBundleInfo {
  /** `packages/cli/package.json`'s version, frozen at build time. */
  version: string;
  /** Immutable source revision selected by the bundle build. */
  sourceSha: string;
  /** CLI build channel, deliberately independent from `STATION_CHANNEL`. */
  channel: string;
}

/** The bundle marker, or `undefined` when running from source. */
export function bundleInfo(): StationCliBundleInfo | undefined {
  const marker = (
    globalThis as { __STATION_CLI_BUNDLE__?: Partial<StationCliBundleInfo> }
  ).__STATION_CLI_BUNDLE__;
  return marker &&
    typeof marker.version === 'string' &&
    typeof marker.sourceSha === 'string' &&
    typeof marker.channel === 'string'
    ? {
        version: marker.version,
        sourceSha: marker.sourceSha,
        channel: marker.channel,
      }
    : undefined;
}

/** Whether this process is the published, bundled `station` executable. */
export function isBundledDistribution(): boolean {
  return bundleInfo() !== undefined;
}

/**
 * Verbs that operate on a Station repository checkout — building the app,
 * starting/upgrading it, installing OS services, or putting the launcher on
 * PATH. They stay behind the repo-root `./station` and are refused, by name,
 * from the published bundle rather than half-running against whatever
 * directory the user happened to be in.
 *
 * `stop` belongs here too. Its old cwd-anchored implementation made a global
 * client silently report the wrong instance, which is not a harmless outcome.
 */
export const CONTRIBUTOR_COMMANDS: readonly string[] = [
  'build',
  'dev',
  'doctor',
  'fresh',
  'home',
  'link',
  'service',
  'shortcut',
  'start',
  'stop',
  'upgrade',
];

/**
 * The message a contributor-tier verb fails with when it is invoked from the
 * published bundle. Names the exact command to run instead, because "command
 * not found" and a stack trace from a missing `package.json` are both worse
 * than being told where the verb lives.
 */
export function contributorCommandMessage(
  command: string,
  args: readonly string[] = [],
): string {
  const invocation = ['./station', command, ...args].join(' ');
  return [
    `\`station ${command}\` runs against a Station repository checkout, so it is not part of the published CLI.`,
    `Run it from the root of a Station checkout with the bundled launcher:`,
    `    ${invocation}`,
    `The published CLI drives Stations that are already running — see \`station stations\` and \`--api-base\`.`,
  ].join('\n');
}

/**
 * Throws for a contributor-tier verb when running as the published bundle.
 * A no-op from a checkout, where every one of these verbs is supported.
 */
export function assertCommandAvailable(
  command: string,
  args: readonly string[] = [],
): void {
  if (!isBundledDistribution()) return;
  if (CONTRIBUTOR_COMMANDS.includes(command)) {
    throw new Error(contributorCommandMessage(command, args));
  }
  if (command === 'setup' && setupAction(args) === 'local') {
    throw new Error(
      'Local Station setup starts and installs a backend, so run `./station setup local` from a Station repository checkout.',
    );
  }
  if (command === 'environment' && isHostEnvironmentInvocation(args)) {
    throw new Error(
      'Environment security commands require the Station repository launcher (./station). ' +
        'Use the host UI to offer or approve access, or run `station environment access request` from this client.',
    );
  }
}

function isHostEnvironmentInvocation(args: readonly string[]): boolean {
  const positionals = parseCoreArgs(
    normalizeEnvironmentArgsForParsing([...args]),
  ).positionals;
  if (positionals[0] === 'offer') return true;
  if (positionals[0] === 'access')
    return ['list', 'approve', 'deny'].includes(positionals[1] ?? '');
  return (
    positionals[0] === 'peers' ||
    (positionals[0] === 'show' && positionals.length === 1) ||
    (positionals[0] === 'credential' &&
      ['show', 'rotate'].includes(positionals[1] ?? '')) ||
    positionals[0] === 'reset'
  );
}

function setupAction(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

/**
 * The source launcher is allowed to offer local start paths. A packaged client
 * is not: every bare shape (`station`, `--inline`, `--service`, and
 * `--temp-home`) would otherwise be a backend lifecycle request before a
 * named-command guard has a chance to run.
 */
export function assertDefaultInvocationAvailable(): void {
  if (!isBundledDistribution()) return;
  throw new Error(
    [
      'The packaged Station CLI cannot start or manage a local backend.',
      'Pair it with a running Station using `station setup existing <name> <host-url> --pair`,',
      'or run `./station start` from a Station repository checkout.',
    ].join('\n'),
  );
}

/** One distribution authority supplies both refusal behaviour and help copy. */
export function bundledAvailabilityNote(): string[] {
  return [
    'Not available in the packaged client — these manage a Station checkout:',
    `  ${CONTRIBUTOR_COMMANDS.join(', ')}`,
    'Run them from the repo root as `./station <command>`.',
    'Host pairing offer/approval also requires that host launcher:',
    '  station environment offer | station environment access list|approve|deny',
    'Use `station environment access request` or `station setup existing <name> <host-url> --pair` from this client.',
  ];
}
