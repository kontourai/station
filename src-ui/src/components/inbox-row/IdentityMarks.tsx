import type { IdentityMarks as Marks } from '../../utils/identity-marks';
import { AgentIcon } from '../icons/AgentIcon';

/**
 * A work row's leading marks (#4266): the engine(s) that ran it, overlapping
 * when the thread was handed between engines, and "+N" past three. Decorative:
 * the row names its agent in text beside the marks, and the engines are in
 * the tooltip, so the marks add a picture rather than a second announcement.
 */
export function IdentityMarks({
  identity,
  size,
}: {
  identity: Marks;
  size: number;
}) {
  if (identity.marks.length === 0) return null;
  const title =
    identity.engineNames.length > 0
      ? `Ran on ${identity.engineNames.join(', ')}`
      : undefined;
  return (
    <span
      className="identity-marks"
      data-testid="identity-marks"
      data-mark-count={identity.marks.length}
      title={title}
      aria-hidden="true"
    >
      {identity.marks.map((mark) => (
        <AgentIcon
          key={mark.engineId ?? mark.slug ?? mark.name}
          agent={mark}
          size={size}
          className="identity-marks__mark chat-dock-inbox__avatar"
        />
      ))}
      {identity.more > 0 && (
        <span className="identity-marks__more">+{identity.more}</span>
      )}
    </span>
  );
}
