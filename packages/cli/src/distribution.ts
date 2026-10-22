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

import {
  CONTRIBUTOR_COMMANDS,
  isBundledDistribution,
} from './distribution-info.js';

export {
  bundledAvailabilityNote,
  bundleInfo,
  CONTRIBUTOR_COMMANDS,
  isBundledDistribution,
} from './distribution-info.js';

/**
 * The message a contributor-tier verb fails with when it is invoked from the
 * published bundle. Names the exact command to run instead, because "command
 * not found" and a stack trace from a missing `package.json` are both worse
 * than being told where the verb lives.
 */
function contributorCommandMessage(
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
  // Installed-service control stays with the OS service manager. Installation,
  // removal and source builds remain outside the packaged client.
  if (
    command === 'service' &&
    ['status', 'start', 'stop'].includes(args[0] ?? '')
  )
    return;
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
  if (positionals[0] === 'offer') return false;
  if (positionals[0] === 'access') return false;
  return (
    positionals[0] === 'peers' ||
    (positionals[0] === 'credential' && positionals[1] === 'rotate') ||
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
