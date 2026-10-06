import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';

/**
 * A screenshot the person took of the page (#90), with what they can do
 * with it: save it as a file, or copy it as an image where this browser's
 * clipboard accepts one. Copy is offered only where it can work (a secure
 * context with `ClipboardItem`, and a PNG, the one image type every
 * clipboard implementation takes); otherwise the reason is said.
 */

export interface BrowserScreenshotShot {
  blob: Blob;
  /** The page's host, for the file name. */
  host: string;
  takenAt: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `browser-<host>-YYYYMMDD-HHMMSS.<ext>`, safe as a file name anywhere. */
function screenshotFileName(shot: BrowserScreenshotShot): string {
  const t = shot.takenAt;
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  const host =
    shot.host.replace(/[^A-Za-z0-9.-]+/g, '-').slice(0, 80) || 'page';
  const ext = shot.blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return `browser-${host}-${stamp}.${ext}`;
}

function canCopyImage(blob: Blob): boolean {
  return (
    blob.type === 'image/png' &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  );
}

export function BrowserScreenshot({
  shot,
  onDismiss,
}: {
  shot: BrowserScreenshotShot;
  onDismiss: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    const next = URL.createObjectURL(shot.blob);
    setUrl(next);
    setCopy('idle');
    return () => URL.revokeObjectURL(next);
  }, [shot.blob]);
  const copyable = canCopyImage(shot.blob);
  const name = screenshotFileName(shot);

  return (
    <div
      className="browser-pane__overlay-notice browser-pane__screenshot"
      role="status"
    >
      {url ? (
        <img
          className="browser-pane__screenshot-thumb"
          src={url}
          alt={`Screenshot of ${shot.host}`}
        />
      ) : null}
      <p className="browser-pane__notice">
        {copy === 'copied'
          ? 'Screenshot copied.'
          : copy === 'failed'
            ? 'This browser would not copy the image. Save it instead.'
            : copyable
              ? 'Screenshot taken.'
              : 'Screenshot taken. Copying images isn’t available in this browser; save it instead.'}
      </p>
      {url ? (
        <a
          className="button button--primary button--small browser-pane__control browser-pane__link-button"
          href={url}
          download={name}
        >
          Save image
        </a>
      ) : null}
      {copyable ? (
        <Button
          size="sm"
          className="browser-pane__control"
          onClick={() => {
            navigator.clipboard
              .write([new ClipboardItem({ [shot.blob.type]: shot.blob })])
              .then(
                () => setCopy('copied'),
                () => setCopy('failed'),
              );
          }}
        >
          Copy image
        </Button>
      ) : null}
      <Button size="sm" className="browser-pane__control" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
