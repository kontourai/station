/**
 * archive#3549: how the production runtime composes the seam that tells
 * orchestration which credential profile (account) an agent runs on.
 *
 * Extracted from `runtime-initialize.ts` so it can be tested for BEHAVIOUR.
 * Two review rounds landed on this composition and both got it wrong, in
 * opposite directions, because it was an inline closure nothing could exercise:
 *
 *  - Round 1 ended it in `.catch(() => undefined)`. That collapsed "this agent
 *    has no execution config" and "this agent could not be read" into one
 *    value, which made orchestration's deliberate fail-closed branch
 *    unreachable in production — a credential-pinned agent whose spec was
 *    unreadable silently ran on the connection's account.
 *  - Round 2 removed the catch entirely. That propagated EVERY rejection,
 *    including the ordinary one: `loadAgent` also rejects when an agent has no
 *    on-disk spec, which is the normal state of every registry default
 *    (`station`, `claude`, `codex` are deliberately never written to
 *    `agents/`). It broke session starts for the default agent.
 *
 * The distinction the seam must preserve:
 *
 *  - **Absence** is a real answer — no spec means no pin is possible, so
 *    `undefined` is correct and the session proceeds.
 *  - **Unreadability** is not an answer — it means we cannot tell whether a pin
 *    exists, so it must reach the fail-closed branch rather than be reported as
 *    "expressed no preference".
 */
import { isAgentConfigNotFound } from '../../domain/config-loader-agents.js';

/** The narrow slice of ConfigLoader this seam needs. */
export interface AgentSpecSource {
  loadAgent: (slug: string) => Promise<{ execution?: unknown } | undefined>;
}

export function composeAgentExecutionConfigLoader(
  source: AgentSpecSource,
): (slug: string) => Promise<never | undefined | any> {
  return (slug: string) =>
    source
      .loadAgent(slug)
      .then((spec) => spec?.execution)
      .catch((error: unknown) => {
        // Absence is ordinary and answerable; everything else is not.
        if (isAgentConfigNotFound(error)) return undefined;
        throw error;
      });
}
