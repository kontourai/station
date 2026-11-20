/**
 * Whether an engine install is older than its built-in entry needs
 * (`minimumVersion`). An older Antigravity CLI has no `acp` command, so its
 * check never answers and would otherwise read as a generic startup failure.
 *
 * Read only after a check has failed for a reason other than sign-in: a
 * working engine never pays for it. The version command runs like a status
 * command (argv only, bounded in time and output, killed at the deadline),
 * and any output without a version, or a failed run, leaves the answer
 * unknown, never "too old".
 */

import {
  compareEngineVersions,
  readEngineVersion,
} from '@kontourai/station-contracts/acp';
import {
  type CliCommandResult,
  findCliBinaryAsync,
  runCliCommand,
} from '../../providers/auth/cli-auth.js';
import { engineAllowedByManagedPolicy } from '../../security/managed-engine-limits.js';
import {
  namesSameExecutable,
  registryLaunchEnvFor,
  registryMinimumVersionFor,
} from './acp-engine-descriptors.js';

/** An install below its entry's floor, in the entry's own words. */
export interface EngineUpdateRequired {
  installed: string;
  minimum: string;
  updateHint: string;
}

const VERSION_COMMAND_TIMEOUT_MS = 8_000;
const VERSION_COMMAND_MAX_OUTPUT = 16 * 1024;

export type VersionCommandRunner = (
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
) => Promise<CliCommandResult | null>;

const defaultRunner: VersionCommandRunner = (command, args, env) =>
  runCliCommand(command, args, undefined, env, {
    timeoutMs: VERSION_COMMAND_TIMEOUT_MS,
    maxBuffer: VERSION_COMMAND_MAX_OUTPUT,
    killSignal: 'SIGKILL',
  });

/**
 * The connection's engine is below its built-in floor, or undefined when it
 * is not, has no floor, or its version cannot be read.
 */
export async function engineUpdateRequired(connection: {
  command: string;
}): Promise<EngineUpdateRequired | undefined> {
  if (!engineAllowedByManagedPolicy('acp')) return undefined;
  const descriptor = registryMinimumVersionFor(connection);
  if (!descriptor) return undefined;
  const { versionCommand, minimum, updateHint } = descriptor.minimumVersion;
  const [argv0, ...args] = versionCommand as [string, ...string[]];
  // Read the binary this connection launches (it may be a full path), not
  // another program of the same name earlier on PATH.
  const program = namesSameExecutable(argv0, descriptor.command)
    ? connection.command
    : argv0;
  const resolved = await findCliBinaryAsync(program);
  if (!resolved) return undefined;
  const result = await defaultRunner(
    resolved,
    args,
    registryLaunchEnvFor(connection),
  ).catch(() => null);
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0)
    return undefined;
  const installed = readEngineVersion(result.stdout);
  if (!installed || compareEngineVersions(installed, minimum) >= 0)
    return undefined;
  return { installed, minimum, updateHint };
}

/** The sentence a surface shows for an install below its floor. */
export function engineUpdateRequiredMessage(
  engineName: string,
  required: EngineUpdateRequired,
): string {
  return `${engineName} ${required.installed} is installed, and Station needs ${required.minimum} or later. ${required.updateHint}`;
}
