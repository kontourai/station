import type {
  EngineCommandAdapterAction,
  EngineCommandOutcome,
  EngineCommandRoute,
} from '@kontourai/station-contracts/engine-commands';

/**
 * The engine-neutral half of running a slash command a person typed: reading
 * the invocation, finding the route an adapter's own `getCommands` listing
 * gave it, and the line a routed command's outcome shows on its turn. How a
 * route reaches the engine stays with each adapter (ACP's extension methods,
 * Muse's MSP requests).
 */

/** A command a person typed, split into its name and argument text. */
export interface SlashCommandInvocation {
  readonly name: string;
  readonly args: string;
}

/** A whole message that is one slash command, or `undefined`. */
export function readSlashCommandInvocation(
  text: string | undefined,
): SlashCommandInvocation | undefined {
  const match = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(
    text?.trim() ?? '',
  );
  if (!match?.[1]) return undefined;
  return { name: match[1], args: match[2]?.trim() ?? '' };
}

/**
 * The adapter action `invocation` runs, when the adapter's command listing
 * routes that command name to one; otherwise `undefined` (prompt text or an
 * engine request, which the adapter resolves itself).
 */
export function adapterActionFor(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly route?: EngineCommandRoute;
  }>,
  invocation: SlashCommandInvocation,
): EngineCommandAdapterAction | undefined {
  const command = commands.find((entry) => entry.name === invocation.name);
  return command?.route?.kind === 'adapter-action'
    ? command.route.action
    : undefined;
}

/** The engine-attributed line a routed command's outcome shows on its turn. */
export function engineCommandOutcomeText(
  engine: string,
  name: string,
  outcome: EngineCommandOutcome,
): string {
  return outcome.kind === 'answered'
    ? outcome.success === false
      ? `${engine} could not run /${name}${outcome.text ? `: ${outcome.text}` : '.'}`
      : outcome.text || `${engine} ran /${name}.`
    : outcome.kind === 'failed'
      ? `${engine} refused /${name}: ${outcome.message}`
      : `${engine} did not run /${name}.`;
}
