import type { HomeLifecycleLabel } from '../../utils/lifecycle-priority';
import {
  LIFECYCLE_CHIP_LABELS,
  lifecycleLabelText,
} from '../../utils/lifecycle-priority';
import { CheckGlyph, CloseGlyph, WarningGlyph } from '../icons/Glyph';
import './LifecycleStatusChip.css';

/**
 * The color discipline for Home/inbox surfaces (design (d), station#1099):
 * color is reserved for exactly three meanings —
 *   - act-now (`Needs attention`: approval, input, review, blocked, queued)
 *   - in-motion (`Running`)
 *   - broken (`Failed`)
 * Every other state (`Completed`, `Ready`, `Recent`, `Current`) renders with
 * the neutral "done"/no-chip treatment — unlabeled resting state, not a
 * fourth color meaning.
 */
export function LifecycleStatusChip({
  lifecycle,
}: {
  lifecycle: HomeLifecycleLabel;
}) {
  if (lifecycle === 'Running') {
    return (
      <span className="lifecycle-chip lifecycle-chip--active">Active</span>
    );
  }
  if (lifecycle === 'Needs attention') {
    return (
      <span className="lifecycle-chip lifecycle-chip--warning">
        <WarningGlyph />
        Attention needed
      </span>
    );
  }
  if (lifecycle === 'Failed') {
    return (
      <span className="lifecycle-chip lifecycle-chip--warning">
        <CloseGlyph />
        Failed
      </span>
    );
  }
  if (lifecycle === 'Stopped') {
    return (
      <span className="lifecycle-chip lifecycle-chip--idle">
        <CloseGlyph />
        Stopped
      </span>
    );
  }
  if (lifecycle === 'Completed') {
    return (
      <span className="lifecycle-chip lifecycle-chip--done">
        <CheckGlyph />
        Done
      </span>
    );
  }
  // station#1783. Its OWN neutral treatment, not `--done`: review caught
  // that reusing the "Done" chip painted the opposite meaning in the same
  // colour, on a row that has NOT finished. The chip is the pointer; every
  // surface that renders it also renders `unanswerableNotice`, because a bare
  // "can't answer" with no basis is a label, not a derivation.
  if (lifecycle === 'Unanswerable') {
    return (
      <span className="lifecycle-chip lifecycle-chip--idle">
        {lifecycleLabelText(lifecycle)}
      </span>
    );
  }
  return null;
}

export function hasLifecycleChip(lifecycle: HomeLifecycleLabel): boolean {
  return LIFECYCLE_CHIP_LABELS.has(lifecycle);
}
