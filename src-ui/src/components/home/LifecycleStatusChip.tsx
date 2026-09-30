import { useRef } from 'react';
import type { HomeLifecycleLabel } from '../../utils/lifecycle-priority';
import {
  LIFECYCLE_CHIP_LABELS,
  lifecycleLabelText,
} from '../../utils/lifecycle-priority';
import {
  LiveStatusGlyph,
  type LiveStatusGlyphKind,
} from '../status/LiveStatusGlyph';
import './LifecycleStatusChip.css';

/**
 * The color discipline for Home/inbox surfaces (design (d), archive#1099):
 * color is reserved for exactly three meanings —
 *   - act-now (`Needs attention`: approval, input, review, blocked, queued)
 *   - in-motion (`Running`)
 *   - broken (`Failed`)
 * Every other state (`Completed`, `Ready`, `Recent`, `Current`) renders with
 * the neutral "done"/no-chip treatment — unlabeled resting state, not a
 * fourth color meaning.
 *
 * The glyphs are the chat status pill's (`LiveStatusGlyph`), so a row and the
 * pill read as one system: the same orbiting dot for work in motion, the same
 * warning for act-now, the same check for done.
 *
 * Motion, cheaply: a chip animates only when its state CHANGES under the
 * user's eyes (it morphs in and a check settles), never on first mount — a
 * list of fifty rows opens still. Only the row the user is in (`live`) keeps
 * the working orbit turning; every other working row shows its resting frame.
 */
const CHIPS: Partial<
  Record<
    HomeLifecycleLabel,
    { tone: string; glyph?: LiveStatusGlyphKind; text?: string }
  >
> = {
  // "Running", the lane's own word — never "Active". The owner's report was
  // "'Active' feels incorrect when there's no activity"; the chip under the
  // Running lane must say what that lane computes, not a looser synonym.
  // (`--active` is the in-motion colour class, not copy.)
  Running: { tone: 'active', glyph: 'working', text: 'Running' },
  'Needs attention': {
    tone: 'warning',
    glyph: 'attention',
    text: 'Attention needed',
  },
  Failed: { tone: 'warning', glyph: 'failed', text: 'Failed' },
  Stopped: { tone: 'idle', glyph: 'failed', text: 'Stopped' },
  Completed: { tone: 'done', glyph: 'done', text: 'Done' },
  // archive#1783. Its OWN neutral treatment, not `--done`: review caught
  // that reusing the "Done" chip painted the opposite meaning in the same
  // colour, on a row that has NOT finished. The chip is the pointer; every
  // surface that renders it also renders `unanswerableNotice`, because a bare
  // "can't answer" with no basis is a label, not a derivation.
  Unanswerable: { tone: 'idle' },
  // #2310: a session nothing has been sent to. Neutral, like Unanswerable —
  // it is neither in motion, broken, nor done.
  Draft: { tone: 'idle', text: 'Draft' },
};

export function LifecycleStatusChip({
  lifecycle,
  live = false,
}: {
  lifecycle: HomeLifecycleLabel;
  /** This row is the one the user is in: its working glyph may keep moving. */
  live?: boolean;
}) {
  // A change of state, observed while mounted, is the only thing that plays
  // the morph; the first render never does.
  const previous = useRef(lifecycle);
  const changed = useRef(false);
  if (previous.current !== lifecycle) {
    changed.current = true;
    previous.current = lifecycle;
  }
  const chip = CHIPS[lifecycle];
  if (!chip) return null;
  const moving = chip.glyph === 'working' ? live : changed.current;
  return (
    <span
      // Re-keyed per state so a change mounts a fresh chip that morphs in.
      key={lifecycle}
      className={`lifecycle-chip lifecycle-chip--${chip.tone}`}
      data-lifecycle-morph={changed.current ? 'true' : undefined}
    >
      {chip.glyph && <LiveStatusGlyph kind={chip.glyph} animate={moving} />}
      {chip.text ?? lifecycleLabelText(lifecycle)}
    </span>
  );
}

export function hasLifecycleChip(lifecycle: HomeLifecycleLabel): boolean {
  return LIFECYCLE_CHIP_LABELS.has(lifecycle);
}
