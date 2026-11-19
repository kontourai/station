import {
  type EngineId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import { BrandIcon } from './BrandIcon';
import { AgentGlyph } from './Glyph';

interface AgentIconProps {
  agent: {
    name: string;
    icon?: string;
    slug?: string;
    id?: string;
    iconUrl?: string;
    engineId?: EngineId;
    engineDefault?: boolean;
    execution?: { agentConnectionId?: string };
    provenance?: { engineId: string };
  };
  size?: 'small' | 'medium' | 'large' | number;
  className?: string;
  style?: React.CSSProperties;
  /** Set only when the icon has no adjacent text describing the agent. */
  accessibleLabel?: string;
  fallbackGlyph?: boolean;
}

const SIZE_MAP = { small: 24, medium: 32, large: 48 };

export function agentIconEngineId(
  agent: AgentIconProps['agent'],
): EngineId | undefined {
  const connectionId = agent.execution?.agentConnectionId;
  const detectedEngineId = agent.provenance?.engineId;
  if ((!agent.engineId || agent.engineId === 'acp') && connectionId) {
    // ACP identifies the adapter. A default profile's binding identifies the app.
    if (agent.engineDefault || detectedEngineId === connectionId) {
      return connectionId;
    }
  }
  return agent.engineId ?? parseEngineId(agent.slug ?? agent.id);
}

export function AgentIcon({
  agent,
  size = 'medium',
  className,
  style,
  accessibleLabel,
  fallbackGlyph,
}: AgentIconProps) {
  const px = typeof size === 'number' ? size : SIZE_MAP[size];
  return (
    <BrandIcon
      name={agent.name}
      id={agent.slug ?? agent.id}
      icon={agent.icon}
      iconUrl={agent.iconUrl}
      engineId={agentIconEngineId(agent)}
      allowSafeImageIcon
      size={px}
      className={className}
      style={style}
      alt={accessibleLabel}
      fallback={fallbackGlyph ? <AgentGlyph /> : undefined}
      // archive#1424: deterministic identicon fallback — same agent always
      // gets the same hue, so two unbranded agents without artwork stay
      // visually distinguishable instead of rendering the same flat tile.
      // archive#1424: seeded ONLY from a committed
      // identifier (slug/id), never `agent.name` — a live-typed form value
      // (`AgentEditorIdentityFields`'s name/icon preview during agent
      // creation) would otherwise cycle the hue on every keystroke. A call
      // site with no committed identifier yet gets no identicon at all
      // (the previous flat swatch), not a guess.
      identiconSeed={agent.slug ?? agent.id}
    />
  );
}
