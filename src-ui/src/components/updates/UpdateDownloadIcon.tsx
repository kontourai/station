import { RefreshGlyph } from '../icons/Glyph';
import type { UpdateNotice } from './updatesEvents';

export function UpdateDownloadIcon({
  progress,
}: {
  progress: UpdateNotice['progress'];
}) {
  return (
    <span className="updates-control__icon">
      <RefreshGlyph />
      {progress && (
        <span
          className={`updates-control__progress${progress.percent === null ? ' updates-control__progress--indeterminate' : ''}`}
          role="progressbar"
          aria-label={progress.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent ?? undefined}
          aria-valuetext={progress.text}
        >
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle
              className="updates-control__progress-track"
              cx="18"
              cy="18"
              r="16"
            />
            <circle
              className="updates-control__progress-value"
              cx="18"
              cy="18"
              r="16"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={100 - (progress.percent ?? 25)}
            />
          </svg>
        </span>
      )}
    </span>
  );
}
