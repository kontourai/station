import type { OwnerAttribution } from '../../utils/ownerAttribution';
import './AttributionChip.css';

interface OwnerChipProps {
  owner: OwnerAttribution | null;
  className?: string;
}

/**
 * "via <Station>" chip — names the Station that produced an agent-authored
 * row. `owner === null` renders nothing rather than guessing, mirroring
 * `EngineChip`'s honesty rule.
 */
export function OwnerChip({ owner, className = '' }: OwnerChipProps) {
  if (!owner) return null;
  return (
    <span className={`attribution-chip ${className}`.trim()}>
      <span className="attribution-chip__pill">via {owner.label}</span>
    </span>
  );
}
