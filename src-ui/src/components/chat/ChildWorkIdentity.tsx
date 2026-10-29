import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import { AgentIcon } from '../icons/AgentIcon';
import { AgentGlyph } from '../icons/Glyph';
import './ChildWorkIdentity.css';

export function ChildWorkIdentity({
  provider,
  agent,
}: {
  provider?: string;
  agent?: SessionIconAgent;
}) {
  const engine = provider
    ? (engineDisplayLabel(provider) ?? provider)
    : undefined;
  if (!agent && !engine) return <AgentGlyph />;
  const identity = agent ?? { name: engine!, engineId: provider };
  const label = [...new Set([agent?.name, engine].filter(Boolean))].join(' · ');
  return (
    <span className="child-work-identity" title={label}>
      <AgentIcon agent={identity} size={24} accessibleLabel={label} />
      {agent?.slug && provider && (
        <span className="child-work-identity__engine" aria-hidden="true">
          <AgentIcon agent={{ name: engine!, engineId: provider }} size={14} />
        </span>
      )}
    </span>
  );
}
