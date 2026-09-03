import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import type { ReactNode } from 'react';
import {
  type AgentFixRoute,
  AgentReadinessCell,
} from '../../components/AgentReadinessCell';
import {
  AUTHORED_BAND_LABEL,
  ENGINE_BAND_LABEL,
  isEngineProvenanceAgent,
} from '../../components/agent-provenance';
import {
  EngineChip,
  engineChipLabel,
} from '../../components/badges/EngineChip';
import { AgentIcon } from '../../components/icons/AgentIcon';
import { AgentGlyph } from '../../components/icons/Glyph';
import { Empty } from '../../components/state';
import type { AgentData } from '../../contexts/AgentsContext';
import { agentEngineDescriptor } from '../../utils/engine';

export { agentFixRoute } from '../../components/AgentReadinessCell';
export type { AgentFixRoute };

type ACPConnectionItem = {
  id: string;
  name?: string;
  icon?: string;
  modes?: unknown[];
};

/**
 * DESIGN.md §2 — the rail is a READINESS BOARD, not a directory. Two bands
 * (`section`), and a row carrying the user's own name, the engine chip ONLY
 * when it says something the name does not, and exactly one server-derived
 * state with its one repair. No slug line, no description, no provenance
 * (Y1): the row used to print the engine word three times and no state at all.
 *
 * The state and the repair are `AgentReadinessCell` — the same component the
 * New Chat picker mounts (§5), so the two surfaces cannot word the same agent
 * differently.
 */
export function buildAgentsViewItems(
  agents: AgentData[],
  _acpConnections: ACPConnectionItem[],
  _knownProjectSlugs?: ReadonlySet<string>,
  actions?: {
    onChat: (agent: AgentData) => void;
    onFix: (agent: AgentData, route: AgentFixRoute) => void;
  },
  options?: {
    /**
     * archive#3751: false while `/api/agents` is serving the last stable
     * catalog (`catalogState: 'reconciling'`). Those rows are real — they are
     * this Station's agents — but their readiness was computed for a
     * configuration that may already be gone, so an agent bound to a MISSING
     * engine reads "Ready".
     *
     * The row still renders; only the state WORD is withheld. Blanking the
     * whole rail instead was the first cut and is worse: a catalog that
     * reconciles for a while (a busy host, a runtime mid-change) leaves the
     * Agents page showing nothing at all, which is a bigger lie than a stale
     * badge and cost this branch a live E2E to notice. An absent word is not
     * a wrong word; an absent rail is an absent product.
     */
    readinessKnown?: boolean;
    /** Which machine is reading the rail (archive#3843). */
    devicePresentation?: DevicePresentation | undefined;
  },
) {
  const readinessKnown = options?.readinessKnown !== false;
  const agentItems = agents.map((agent) => {
    const engine = agentEngineDescriptor(agent);
    return {
      id: agent.slug,
      name: agent.name,
      // No second line. The row's state is the badge in `trailing`; printing
      // it here too rendered "Ready" directly above a READY chip on every row
      // (caught in this lane's own 1440 capture). §2: name, chip when it says
      // something the name does not, one state.
      subtitle: '',
      icon: <AgentIcon agent={agent as any} size="small" />,
      badge: (
        <>
          {engineChipLabel(engine) !== agent.name && (
            <EngineChip engine={engine} />
          )}
          {readinessKnown && <AgentReadinessCell agent={agent} part="status" />}
        </>
      ),
      section: isEngineProvenanceAgent(agent)
        ? ENGINE_BAND_LABEL
        : AUTHORED_BAND_LABEL,
      trailing: actions ? (
        <AgentReadinessCell
          agent={agent}
          agentName={agent.name}
          devicePresentation={options?.devicePresentation}
          onChat={() => actions.onChat(agent)}
          onFix={(route) => actions.onFix(agent, route)}
          part="action"
        />
      ) : undefined,
    };
  });

  // The rail prints a section header whenever `section` changes, so the ARRAY
  // order is the band order — DESIGN.md §2 puts the engines band first, and
  // the New Chat picker already does. Interleaved input would otherwise print
  // the same heading twice.
  return [
    ...agentItems.filter((item) => item.section === ENGINE_BAND_LABEL),
    ...agentItems.filter((item) => item.section !== ENGINE_BAND_LABEL),
  ];
}

export function buildAgentsViewEmptyContent(options: {
  agentsCount: number;
  onCreateBlank: () => void;
}): ReactNode {
  return (
    <Empty
      variant="prominent"
      icon={
        <span className="agent-editor__state-icon" aria-hidden="true">
          <AgentGlyph />
        </span>
      }
      label="No agents of your own yet"
      description="Pick the engine that runs it — Station, or one you've connected."
      action={
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          onClick={options.onCreateBlank}
        >
          New agent
        </button>
      }
    />
  );
}
