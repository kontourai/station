import {
  CheckGlyph,
  CloseGlyph,
  PauseGlyph,
  RefreshGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import './live-status.css';

/**
 * The one glyph vocabulary for live status — the chat pane's floating pill
 * and the inbox rows' state chip draw from this, so "working", "needs you"
 * and "done" look and move the same everywhere.
 *
 * Motion is CSS only, and only `transform`/`opacity` on HTML boxes (so it
 * composites): `working` is a single dot orbiting a faint ring, `reconnecting`
 * turns its arrows, and the one-shot kinds (`done`, `approval`) settle once
 * when they appear. Nothing here runs script per frame.
 */
export type LiveStatusGlyphKind =
  | 'working'
  | 'approval'
  | 'reconnecting'
  | 'attention'
  | 'done'
  | 'failed'
  | 'idle';

export type LiveStatusTone = 'active' | 'attention' | 'broken' | 'neutral';

export function LiveStatusGlyph({
  kind,
  animate = true,
}: {
  kind: LiveStatusGlyphKind;
  /** False draws the resting frame: a row that is not current does not orbit. */
  animate?: boolean;
}) {
  return (
    <span
      className="live-status-glyph"
      data-kind={kind}
      data-animate={animate ? 'true' : 'false'}
      aria-hidden="true"
    >
      {kind === 'working' && (
        <>
          <span className="live-status-glyph__ring" />
          <span className="live-status-glyph__orbit" />
        </>
      )}
      {kind === 'reconnecting' && (
        <span className="live-status-glyph__turn">
          <RefreshGlyph />
        </span>
      )}
      {kind === 'approval' && (
        <span className="live-status-glyph__settle">
          <PauseGlyph />
        </span>
      )}
      {kind === 'attention' && <WarningGlyph />}
      {kind === 'done' && (
        <span className="live-status-glyph__settle">
          <CheckGlyph />
        </span>
      )}
      {kind === 'failed' && <CloseGlyph />}
      {kind === 'idle' && <span className="live-status-glyph__dot" />}
    </span>
  );
}

let hiddenTracking = false;
/**
 * Pause every status animation while the page is hidden: a backgrounded tab
 * or a locked phone should cost nothing. One listener for the whole app.
 */
export function trackPageVisibilityForStatusMotion() {
  if (hiddenTracking || typeof document === 'undefined') return;
  hiddenTracking = true;
  const sync = () => {
    if (document.hidden) document.documentElement.dataset.pageHidden = 'true';
    else delete document.documentElement.dataset.pageHidden;
  };
  document.addEventListener('visibilitychange', sync);
  sync();
}
