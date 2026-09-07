import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  type CredentialUsage,
  type CredentialUsageEntry,
  useCredentialUsageQuery,
} from '@kontourai/station-sdk';
import { ConnectionsHubSection } from './ConnectionsHubSection';

/**
 * archive#3552: how much of each account's quota the PROVIDER says is spent.
 *
 * Only engines with a credential-profile concept have accounts to report on —
 * the server's `APP_HOME_ENGINES` table is `claude` and `codex`. Those two ids
 * are named here rather than derived because the server route 404s for
 * anything else; a connection that gains the channel gains a row when the
 * server says so, and until then a third id here would render an empty card
 * that never fills.
 *
 * Three honesty rules this surface exists to keep:
 *
 *  - **Unknown is not zero.** A reading that failed renders as a stated reason
 *    with no meter at all, never an empty bar that reads as "nothing used".
 *  - **The provider's verdict wins.** `exhausted` comes from the provider's own
 *    flags; this component never re-derives it from a percentage.
 *  - **Say when it was read.** These are point-in-time reads of a remote
 *    counter, not Station's own accounting.
 */
const USAGE_ENGINES = ['claude', 'codex'].map((id) => ({
  id,
  label: engineDisplayLabel(id) ?? id,
}));

function relativeReset(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return 'resets now';
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

function fetchedAtLabel(fetchedAt: string): string | null {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'read just now';
  if (minutes < 60) return `read ${minutes}m ago`;
  return `read ${Math.round(minutes / 60)}h ago`;
}

function UsageBody({ usage }: { usage: CredentialUsage }) {
  if (usage.status === 'unknown') {
    // Deliberately no meter: an empty bar here would read as "nothing used".
    return (
      <div className="credential-usage__unknown">
        <span className="credential-usage__unknown-label">
          Usage unavailable
        </span>
        <span className="credential-usage__reason">{usage.reason}</span>
      </div>
    );
  }
  if (usage.windows.length === 0) {
    // an account the provider says is EXHAUSTED but
    // reports no percentages for rendered "Limit reached" above this line and
    // "reported no limits" below it — two statements that contradict each
    // other. The absence of percentages is not the absence of limits.
    return (
      <div className="credential-usage__unknown">
        <span className="credential-usage__unknown-label">
          {usage.exhausted
            ? 'The provider did not report usage percentages.'
            : 'The provider reported no limits for this account.'}
        </span>
      </div>
    );
  }
  return (
    <ul className="credential-usage__windows">
      {usage.windows.map((window) => {
        const reset = relativeReset(window.resetsAt);
        return (
          <li className="credential-usage__window" key={window.id}>
            <div className="credential-usage__window-head">
              <span className="credential-usage__window-label">
                {window.label}
              </span>
              <span className="credential-usage__window-value">
                {window.usedPercent}%
              </span>
              {reset && (
                <span className="credential-usage__window-reset">{reset}</span>
              )}
            </div>
            {/* A real <meter>, not a div wearing role="meter": the element
                carries the semantics natively and assistive tech announces
                the value without a hand-maintained aria triple. */}
            <meter
              aria-label={`${window.label} used`}
              className="credential-usage__meter"
              max={100}
              min={0}
              value={window.usedPercent}
            />
          </li>
        );
      })}
    </ul>
  );
}

function AccountCard({ entry }: { entry: CredentialUsageEntry }) {
  const { usage } = entry;
  return (
    <li className="credential-usage__account">
      <div className="credential-usage__account-head">
        <span className="credential-usage__account-label">{entry.label}</span>
        {usage.status === 'ok' && usage.planLabel && (
          <span className="credential-usage__plan">{usage.planLabel}</span>
        )}
        {/* The provider's own verdict, never a threshold computed here. */}
        {usage.status === 'ok' && usage.exhausted && (
          <span className="credential-usage__exhausted">Limit reached</span>
        )}
      </div>
      <UsageBody usage={usage} />
      <span className="credential-usage__fetched">
        {fetchedAtLabel(usage.fetchedAt) ?? 'read at an unknown time'}
      </span>
    </li>
  );
}

function EngineUsage({ id, label }: { id: string; label: string }) {
  const { data, isLoading, isError, refetch } = useCredentialUsageQuery(id);

  // The route 404s for a connection with no credential-profile channel, and an
  // engine that is simply not configured has nothing to report. Either way,
  // rendering nothing beats an empty card that never fills.
  if (isError || (!isLoading && (!data || data.length === 0))) return null;

  return (
    <div className="credential-usage__engine">
      <div className="credential-usage__engine-head">
        <h4 className="credential-usage__engine-title">{label}</h4>
        <button
          type="button"
          className="editor-link"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          {isLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <ul className="credential-usage__accounts">
        {(data ?? []).map((entry) => (
          <AccountCard entry={entry} key={entry.ref ?? '__connection__'} />
        ))}
      </ul>
    </div>
  );
}

export function CredentialUsageSection() {
  return (
    <ConnectionsHubSection
      id="usage"
      title="Account usage"
      description="How much of each signed-in account's quota the provider reports as spent"
    >
      <div className="credential-usage">
        {USAGE_ENGINES.map((engine) => (
          <EngineUsage id={engine.id} key={engine.id} label={engine.label} />
        ))}
      </div>
    </ConnectionsHubSection>
  );
}
