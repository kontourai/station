import { Button } from '../../components/Button';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  RefreshGlyph,
} from '../../components/icons/Glyph';

export type BrowserNavAction = 'back' | 'forward' | 'reload';

/**
 * A browser's navigation in the full-screen bar (the float's and the
 * pane's): where the page is, and Back, Forward, Reload. Each caller sends
 * the action through its own session history call.
 */
export function BrowserImmersiveNav({
  host,
  disabled,
  onAction,
}: {
  host: string;
  /** No one may navigate from here right now (not in control, not live). */
  disabled: boolean;
  onAction: (action: BrowserNavAction) => void;
}) {
  const button = 'live-surface-controls__action live-surface-controls__icon';
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={button}
        aria-label="Back"
        title="Back"
        disabled={disabled}
        onClick={() => onAction('back')}
      >
        <ArrowLeftGlyph />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={button}
        aria-label="Forward"
        title="Forward"
        disabled={disabled}
        onClick={() => onAction('forward')}
      >
        <ArrowRightGlyph />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={button}
        aria-label="Reload"
        title="Reload"
        disabled={disabled}
        onClick={() => onAction('reload')}
      >
        <RefreshGlyph />
      </Button>
      <p className="live-surface-controls__status" title={host}>
        {host}
      </p>
    </>
  );
}
