import './StatusGlyph.css';
import type { SessionStateLabel } from '../../utils/session-state';

export interface StatusGlyphPresentation {
  glyph: string;
  color: 'muted' | 'active' | 'attention' | 'warning' | 'success' | 'danger';
  ariaLabel: string;
}

/**
 * The compact lifecycle vocabulary for surfaces that need a state glyph
 * without inventing another status-label fold. Consumers choose where it is
 * appropriate to render a lifecycle state; this module only owns the stable
 * visual/accessibility presentation for every contract state.
 */
export const STATUS_GLYPH_BY_STATE = {
  'Needs attention': {
    glyph: '!',
    color: 'attention',
    ariaLabel: 'Needs attention',
  },
  Failed: { glyph: '×', color: 'danger', ariaLabel: 'Failed' },
  Stopped: { glyph: '■', color: 'muted', ariaLabel: 'Stopped' },
  Running: { glyph: '●', color: 'active', ariaLabel: 'Running' },
  Ready: { glyph: '○', color: 'muted', ariaLabel: 'Ready' },
  // archive#1783 vocabulary rule: 'Unanswerable' is the system's internal
  // term, never the user's word — same translation lifecycleLabelText applies.
  Unanswerable: {
    glyph: '?',
    color: 'warning',
    ariaLabel: "Can't answer here",
  },
  Completed: { glyph: '✓', color: 'success', ariaLabel: 'Completed' },
} as const satisfies Record<SessionStateLabel, StatusGlyphPresentation>;

type StatusGlyphExhaustive =
  SessionStateLabel extends keyof typeof STATUS_GLYPH_BY_STATE
    ? true
    : [
        'STATUS_GLYPH_BY_STATE is missing a SessionStateLabel member:',
        Exclude<SessionStateLabel, keyof typeof STATUS_GLYPH_BY_STATE>,
      ];
true satisfies StatusGlyphExhaustive;

export function statusGlyphPresentation(
  state: SessionStateLabel,
): StatusGlyphPresentation {
  return STATUS_GLYPH_BY_STATE[state];
}

export function StatusGlyph({ state }: { state: SessionStateLabel }) {
  const presentation = statusGlyphPresentation(state);
  return (
    <span
      className={`status-glyph status-glyph--${presentation.color}`}
      data-lifecycle-state={state}
      role="img"
      aria-label={presentation.ariaLabel}
    >
      {presentation.glyph}
    </span>
  );
}
