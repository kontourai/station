import { BrandIcon } from './BrandIcon';

interface AgentIconProps {
  agent: {
    name: string;
    icon?: string;
    slug?: string;
    id?: string;
    iconUrl?: string;
  };
  size?: 'small' | 'medium' | 'large' | number;
  className?: string;
  style?: React.CSSProperties;
/** Set only when the icon has no adjacent text describing the agent. */
  accessibleLabel?: string;
}

const SIZE_MAP = { small: 24, medium: 32, large: 48 };

export function AgentIcon({
  agent,
  size = 'medium',
  className,
  style,
  accessibleLabel,
}: AgentIconProps) {
  const px = typeof size === 'number' ? size : SIZE_MAP[size];
  return (
    <BrandIcon
      name={agent.name}
      id={agent.slug ?? agent.id}
      icon={agent.icon}
      iconUrl={agent.iconUrl}
      allowSafeImageIcon
      size={px}
      className={className}
      style={style}
      alt={accessibleLabel}
// archive#1424: deterministic identicon fallback — same agent always
// gets the same hue, so two unbranded agents without artwork stay
// visually distinguishable instead of rendering the same flat tile.
 // archive#1424 fix : seeded ONLY from a committed
// identifier (slug/id), never `agent.name` — a live-typed form value
// (`AgentEditorIdentityFields`'s name/icon preview during agent
// creation) would otherwise cycle the hue on every keystroke. A call
// site with no committed identifier yet gets no identicon at all
// (the previous flat swatch), not a guess.
      identiconSeed={agent.slug ?? agent.id}
    />
  );
}
