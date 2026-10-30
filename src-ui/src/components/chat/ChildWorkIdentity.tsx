import { parseEngineId } from '@kontourai/station-contracts/agent-identity';
import { engineMark } from '../../utils/identity-marks';
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
  const engineId = parseEngineId(provider);
  const engine = engineId ? engineMark(engineId) : undefined;
  if (!agent && !engine) return <AgentGlyph />;
  const identity = agent ?? engine!;
  const label = [...new Set([agent?.name, engine?.name].filter(Boolean))].join(
    ' · ',
  );
  return (
    <span className="child-work-identity" title={label}>
      <AgentIcon agent={identity} size={24} accessibleLabel={label} />
      {agent?.slug && engine && (
        <span className="child-work-identity__engine" aria-hidden="true">
          <AgentIcon agent={engine} size={14} />
        </span>
      )}
    </span>
  );
}
