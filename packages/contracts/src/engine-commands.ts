/**
 * How an engine's slash command runs when a person invokes it in Station.
 *
 * An engine lists its commands (ACP `available_commands_update`). Most run as
 * prompt text: Station sends `/<name> <args>` as the turn. Some engines also
 * expose a command as its own request, and Station's adapter can carry a few
 * as its own actions. A route says which. An `engine-request` route applies
 * only when the live session declared its method (`basis: 'declared'`) or a
 * reviewed handshake-identity entry matched (`basis: 'undeclared-engine'`);
 * otherwise the command runs as prompt text.
 */

/** How a route builds the request's params from the session and invocation. */
export type EngineCommandParams =
  /** `{ sessionId }` */
  | 'session'
  /** `{ sessionId, subcommand }`: the first argument word. */
  | 'session+subcommand'
  /** `{ sessionId, command }`: the whole `/name args` line. */
  | 'session+command-line';

/** An action Station's adapter performs itself, not through the engine's command. */
export type EngineCommandAdapterAction = 'compact' | 'rewind' | 'export';

export type EngineCommandRoute =
  | { readonly kind: 'prompt-text' }
  | {
      readonly kind: 'engine-request';
      readonly method: string;
      readonly params: EngineCommandParams;
      readonly basis: 'declared' | 'undeclared-engine';
      /** Where the method and its answer were observed. */
      readonly evidence: string;
    }
  | {
      readonly kind: 'adapter-action';
      readonly action: EngineCommandAdapterAction;
    };

/**
 * What came of a routed command.
 *
 * - `answered`: the engine replied. A `{ success: false, message }` reply is
 *   still `answered` (with `success: false`), shown as an engine-attributed
 *   failure line rather than a Station error.
 * - `unsupported`: the engine refused the method (`-32601`); the adapter may
 *   fall back to prompt text.
 * - `failed`: the request failed for another reason.
 * - `not-declared`: the route needs a method this session never declared.
 */
export type EngineCommandOutcome =
  | {
      readonly kind: 'answered';
      readonly text?: string;
      readonly success?: boolean;
    }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'not-declared' };

/** Longest engine-attributed text an outcome carries; longer text is cut by the reader. */
export const ENGINE_COMMAND_OUTCOME_TEXT_MAX = 64 * 1024;

/** The params a route sends. Pure: the caller supplies the session id and the invocation. */
export function engineCommandRequestParams(
  params: EngineCommandParams,
  sessionId: string,
  invocation: { readonly name: string; readonly args: string },
): Record<string, string> {
  switch (params) {
    case 'session':
      return { sessionId };
    case 'session+subcommand': {
      const subcommand = invocation.args.trim().split(/\s+/)[0] ?? '';
      return subcommand ? { sessionId, subcommand } : { sessionId };
    }
    case 'session+command-line': {
      const args = invocation.args.trim();
      return {
        sessionId,
        command: args ? `/${invocation.name} ${args}` : `/${invocation.name}`,
      };
    }
  }
}
