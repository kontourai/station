import type { StationCompatibilityResult } from '@kontourai/station-contracts';

/**
 * The verdict shown before a host is committed.
 *
 * Only rendered for a blocking verdict: `compatible` should be quiet (a green
 * banner on every successful add is noise), and `unknown` — a host older than
 * the contract — must read as normal, because that host works today and this
 * check must not be the thing that makes it look broken.
 */
export function CompatibilityNotice({
  result,
  onDismiss,
}: {
  result: StationCompatibilityResult;
  onDismiss: () => void;
}) {
  return (
    <div className="station-connect-compat" role="alert">
      <p className="station-connect-compat__title">
        {result.verdict === 'client-too-old'
          ? 'This app is too old for that host'
          : 'That host is too old for this app'}
      </p>
      <p className="station-connect-compat__reason">{result.reason}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="station-connect-btn station-connect-btn--secondary"
      >
        Dismiss
      </button>
    </div>
  );
}
