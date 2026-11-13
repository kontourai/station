/**
 * Runs a slash command a person typed, by the route the engine's adapter
 * resolved for it (`EngineCommandRoute`,
 * `packages/contracts/src/engine-commands.ts`). The route table is the
 * adapter's own (ACP: `acp-command-routes.ts`); what happens for each route
 * kind is decided here once, for every adapter:
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
import type {
  EngineCommandAdapterAction,
  EngineCommandOutcome,
  EngineCommandRoute,
} from '@kontourai/station-contracts/engine-commands';

/** A command a person typed, split into its name and argument text. */
export interface EngineCommandInvocation {
  readonly name: string;
  readonly args: string;
}

export function readSlashCommand(
  text: string | undefined,
): EngineCommandInvocation | undefined {
  const match = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(
    text?.trim() ?? '',
  );
  if (!match?.[1]) return undefined;
  return { name: match[1], args: match[2]?.trim() ?? '' };
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
    invocation: EngineCommandInvocation,
  ): Promise<EngineCommandOutcome>;
  /** Show `text` as the engine's output on this turn and end the turn. */
  answerTurn(text: string): R;
}

/** The line a routed command's outcome is shown as. */
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

export async function dispatchEngineCommand<R>(
  port: EngineCommandPort<R>,
  invocation: EngineCommandInvocation,
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
