import { workGroupLabelText } from './work-group-label';
import './WorkGroupLabel.css';

/**
 * THE group-heading rendering: one text run in the normal UI face, so the
 * count is read aloud with the label (never an aria-hidden badge) and a
 * heading looks the same on every surface. The host owns the element around
 * it (a heading, a disclosure toggle, a list section) and whether a count
 * is shown at all; this owns the words and their face.
 */
export function WorkGroupLabel({
  label,
  count,
}: {
  label: string;
  count?: number;
}) {
  return (
    <span className="work-group-label" data-testid="work-group-label">
      {workGroupLabelText(label, count)}
    </span>
  );
}
