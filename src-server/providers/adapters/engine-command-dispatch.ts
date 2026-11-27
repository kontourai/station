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
 * Muse's MSP requests, OpenCode's server routes).
 *
 * `dispatchEngineCommand` decides what each route kind does once, for the
 * adapters that hand it a port (ACP and OpenCode):
 *
 * - a refusal: nothing reaches the engine, and the turn shows why;
 * - `prompt-text`: the command is sent as the turn's prompt;
 * - `engine-request`: the engine's own request, its answer shown as the
 *   engine's output; an engine that has no such command (`unsupported`)
 *   gets the command as prompt text instead;
 * - `adapter-action`: an action the adapter performs itself (compact,
 *   rewind, export), where the adapter's port offers one; otherwise prompt
 *   text, as before such routes existed.
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

/** The route an adapter resolved for one invocation on one live session. */
export interface ResolvedEngineCommand {
  readonly route: EngineCommandRoute;
  /** An `engine-request` route's params; absent, the request cannot be sent. */
  readonly params?: Record<string, unknown>;
  /** Present: nothing is sent, and this text says why. */
  readonly refusal?: string;
}

export type EngineRequestRoute = Extract<
  EngineCommandRoute,
  { kind: 'engine-request' }
>;

/**
 * What the dispatcher needs from one adapter's live session. `R` is what a
 * turn's prompt settles with on that adapter.
 */
export interface EngineCommandPort<R> {
  /** The engine's name, as the output lines attribute it. */
  readonly engineName: string;
  /** Send the route's request; `unsupported` sends the command as prompt text. */
  request(
    route: EngineRequestRoute,
    params: Record<string, unknown>,
  ): Promise<EngineCommandOutcome>;
  /** Send the command as the turn's prompt. */
  asPromptText(): Promise<R>;
  /** Absent: this adapter performs no action itself, and the command is prompt text. */
  adapterAction?(
    action: EngineCommandAdapterAction,
    invocation: SlashCommandInvocation,
  ): Promise<EngineCommandOutcome>;
  /** Show `text` as the engine's output on this turn and end the turn. */
  answerTurn(text: string): R;
}

export async function dispatchEngineCommand<R>(
  port: EngineCommandPort<R>,
  invocation: SlashCommandInvocation,
  resolved: ResolvedEngineCommand,
): Promise<R> {
  if (resolved.refusal) return port.answerTurn(resolved.refusal);
  const { route } = resolved;
  let outcome: EngineCommandOutcome;
  if (route.kind === 'engine-request') {
    if (!resolved.params) return port.asPromptText();
    outcome = await port.request(route, resolved.params);
  } else if (route.kind === 'adapter-action') {
    if (!port.adapterAction) return port.asPromptText();
    outcome = await port.adapterAction(route.action, invocation);
  } else {
    return port.asPromptText();
  }
  if (outcome.kind === 'unsupported') return port.asPromptText();
  return port.answerTurn(
    engineCommandOutcomeText(port.engineName, invocation.name, outcome),
  );
}
