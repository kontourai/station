import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { StatusBadge } from '@kontourai/ui/react';
import type { AgentData } from '../contexts/AgentsContext';
import { agentRunnability } from './agent-runnability';
import { hostActionCopy } from './host-action/host-action-copy';
import './AgentReadinessCell.css';

/**
 * The readiness row's state + its ONE repair, as one component.
 *
 * DESIGN.md §2 and §5 say the Agents list and the New Chat picker render the
 * SAME row: the same state word, the same tone, the same single fixing verb.
 * They used to render two — the list a `StatusBadge` with its own label
 * mapping, the picker a warning chip with a `resolveNewChatAgentRemedy` label
* over the same `agentRunnability` answer, which is precisely how two
 * surfaces one click apart end up disagreeing about the same agent. There is
 * one presentation of that answer now, and both surfaces mount it.
 *
 * It derives nothing the server did not compute: `agentRunnability` reads
 * `available`/`unavailableReason`/`enable` and nothing else (see its
 * docblock), and the route below only maps the server's reason onto the page
 * that can fix it.
 */

export type AgentFixRoute = 'models' | 'enable' | 'engines' | 'edit';

export type ReadinessAgent = Pick<
  AgentData,
  'available' | 'unavailableReason' | 'unavailableFix' | 'enable'
>;

/**
 * The server owns the reason; this maps that reason to its one repair route,
 * and to NO route when nothing this app owns would fix it.
 *
 * `undefined` is load-bearing. An agent that is unavailable for a reason with
 * no engine behind it ("An external policy currently prevents launch", "This
 * Agent configuration needs attention") has nothing to connect and nothing to
 * enable, and offering "Set up" would send the user to a Connections page
 * that has no bearing on their problem — a guessed fix, which is worse than
 * none. Those rows keep their editor action and their reason.
 */
export function agentFixRoute(
  agent: ReadinessAgent,
): AgentFixRoute | undefined {
  const routes: Record<
    NonNullable<AgentData['unavailableFix']>['kind'],
    AgentFixRoute | undefined
  > = {
    'model-connection': 'models',
    'engine-disabled': 'enable',
    'cli-missing': 'engines',
    'connection-broken': 'engines',
    'agent-configuration': 'edit',
    unknown: 'edit',
    policy: undefined,
    none: undefined,
  };
  const kind = agent.unavailableFix?.kind;
  return kind ? routes[kind] : undefined;
}

/**
 * Exactly one state per row, in the server's own words. `Needs: <thing>` uses
 * `unavailableReason` verbatim — the sentence a person can act on — rather
 * than a category this file invented.
 */
export function agentReadinessState(agent: ReadinessAgent): {
  label: string;
  tone: 'positive' | 'caution' | 'neutral';
} {
  const runnability = agentRunnability(agent);
  if (runnability.runnable) return { label: 'Ready', tone: 'positive' };
// `enable` is a server-produced authorization that this engine alias has
// no authored Agent yet and can be materialized. It is not inferred from
// `engineDefault`, so a disconnected alias keeps the server's concrete need.
  if (agent.enable) return { label: 'Not set up', tone: 'neutral' };
  return { label: `Needs: ${runnability.reason}`, tone: 'caution' };
}

/**
 * The COMPACT form of `agentReadinessState`, for a context that cannot host
 * a full server sentence inline (archive#4521: the agent editor's page
 * header, beside the title) but still must not read as merely informational
* dropping the caution chip entirely there once made an unrunnable agent
 * look no different from a ready one. This shortens the label to chip-native
 * vocabulary while KEEPING the tone, so a caution row still reads caution at
 * a glance; the full sentence stays available where there is room for one
 * (the list row's trailing action name, and the editor's own banner beneath
 * the header).
 *
 * The decision of WHICH states collapse to which short label lives here,
 * not in a caller: a caller that wants the compact form asks for it via
 * `AgentReadinessCell`'s `compact` prop and takes whatever this returns. A
 * third short-label case added here (today there are two: "Ready" and "Not
 * set up") reaches every compact consumer with no caller change — the
 * lockstep a caller re-deriving this decision for itself would otherwise
 * require of every future case.
 */
export function agentReadinessCompactState(agent: ReadinessAgent): {
  label: string;
  tone: 'positive' | 'caution' | 'neutral';
} {
  const state = agentReadinessState(agent);
  return state.tone === 'caution'
    ? { label: 'Not set up', tone: 'caution' }
    : state;
}

/**
 * The one verb that fixes this row — or `undefined` when it is Ready, or when
 * nothing here would fix it.
 *
 * "Enable" is spoken ONLY on the server's `enable` signal. It used to be
 * spoken for any `engineDefault` row, which is an inference from a
 * presentation flag: `agent-runnability`'s docblock is explicit that `enable`
 * is the machine-readable "materializing this engine's Agent would work"
 * answer and that a consumer must never reconstruct it. A row promising
 * Enable over a connection that cannot start is a button that fails.
 */
export function agentFixLabel(
  agent: ReadinessAgent,
): 'Enable' | 'Connect' | 'Set up' | 'Edit agent' | undefined {
  if (agentRunnability(agent).runnable) return undefined;
  const route = agentFixRoute(agent);
  if (route === 'enable') return 'Enable';
  if (route === 'models') return 'Connect';
  if (route === 'edit') return 'Edit agent';
  return route === 'engines' ? 'Set up' : undefined;
}

export function AgentReadinessCell({
  agent,
  agentName,
  devicePresentation,
  fixLabel: fixLabelOverride,
  fixDisabled,
  onChat,
  onFix,
  className,
  compact,
  part = 'both',
}: {
  agent: ReadinessAgent;
/** Names the action for assistive tech when several rows are on screen. */
  agentName?: string;
/**
 * Which machine is reading the row (archive#3843). "Set up" sends you to
* Connections, which a paired device can browse — so this row keeps its ONE
* verb (`tests/agents-readiness-board.spec.ts`) and the engine's machine is
* named in the action's accessible name instead. Adding a second control,
* or a helper line per row, would break the contract this rail was built on.
*/
  devicePresentation?: DevicePresentation | undefined;
/**
* A host that knows something the server's reason does not may pick a
* different verb from the SAME three (archive#3027: an engine whose connection
* is broken cannot be Enabled into working — the connection is what needs
* setting up). It may not invent a fourth.
*/
  fixLabel?: 'Enable' | 'Connect' | 'Set up' | 'Edit agent';
/** The repair is already running; the affordance says so. */
  fixDisabled?: boolean;
/** Omitted where the ROW itself is the chat action (the New Chat picker). */
  onChat?: () => void;
  onFix?: (route: AgentFixRoute) => void;
  className?: string;
/**
* Shorten the status badge to chip-native vocabulary (`agentReadinessCompactState`)
* rather than the server's full reason sentence — for a context with no
* room for one (archive#4521: the editor page header, beside the title).
* The full sentence stays available wherever this is NOT set (the list
* row's action name, and any banner rendering the reason directly).
*/
  compact?: boolean;
/** Render only the shared inline state badge or only the trailing action. */
  part?: 'status' | 'action' | 'both';
}) {
  const state = compact
    ? agentReadinessCompactState(agent)
    : agentReadinessState(agent);
  const derivedFixLabel = agentFixLabel(agent);
  const fixLabel = derivedFixLabel
    ? (fixLabelOverride ?? derivedFixLabel)
    : undefined;
// Console Kit's `.status` is a tone BLOCK (display: grid, a 4-unit
// min-width) meant for card corners. Inline beside a row name it stretches
// to the name's full width (caught by eye in this lane's 1440 capture), so
// the cell renders the compact variant — one rule, both hosts.
  const status = (
    <StatusBadge
      status={state.label}
      tone={state.tone}
      className="agent-readiness__status"
    />
  );
// The trailing clause is empty on the host and for every verb whose repair
// is not the host's engine setup, so the accessible name is unchanged there.
  const hostClause =
    fixLabel === 'Set up'
      ? hostActionCopy('agent-engine-setup', devicePresentation)
      : '';
  const actionName = [fixLabel, agentName ?? 'this agent', hostClause]
    .filter(Boolean)
    .join(' ');
  const action = fixLabel ? (
    <button
      type="button"
      className={className ?? 'agent-readiness__action'}
// `enable` and `remedy` are the two shapes a repair takes — one
// creates the missing Agent, the other sends you to the connection
// that has to be fixed first.
      data-agent-action={
        fixLabel === 'Enable'
          ? 'enable'
          : fixLabel === 'Edit agent'
            ? 'edit'
            : 'remedy'
      }
      aria-label={actionName}
// Same one string, made readable by pointer as well. Only present when
// there is a host to name — no tooltip appears on the host.
      {...(hostClause ? { title: actionName } : {})}
      disabled={fixDisabled}
      onClick={(event) => {
        event.stopPropagation();
        const route = agentFixRoute(agent);
        if (route) onFix?.(route);
      }}
    >
      {fixLabel}
    </button>
  ) : onChat ? (
    <button
      type="button"
      className={className ?? 'agent-readiness__action'}
      aria-label={`Chat with ${agentName ?? 'this agent'}`}
      onClick={(event) => {
        event.stopPropagation();
        onChat();
      }}
    >
      Chat
    </button>
  ) : null;

  if (part === 'status') return status;
  if (part === 'action') return action;
  return (
    <span className="agent-readiness">
      {status}
      {action}
    </span>
  );
}
