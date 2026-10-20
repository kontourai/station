import type { TelemetryTier } from '@kontourai/station-contracts/product-telemetry';
import { useId } from 'react';
import { PageCallout } from './PageCallout';
import './UsageTelemetryDisclosure.css';

export const SHARING_LABELS: Record<TelemetryTier, string> = {
  off: "Don't share",
  lite: 'Anonymous usage counts',
  full: 'Detailed usage to help improve Station',
};

export type SharingDisclosure = {
  events: Record<
    string,
    {
      description: string;
      properties: Record<string, { domain: string | readonly string[] }>;
    }
  >;
};

export type SharingCounts = Record<
  string,
  {
    domain: string | readonly string[];
    arrayMax?: number;
    maxLength?: number;
    max?: number;
  }
>;

/** One readable view of the server-owned definitions, for both sharing choices. */
function UsageSharingIncluded(
  props: { data: SharingDisclosure } | { counts: SharingCounts },
) {
  const daily = 'counts' in props;
  return (
    <section aria-label="What's included">
      <h3>What's included</h3>
      {daily ? (
        <>
          <p>
            App version and device categories, grouped feature use and
            customization, and counts of setup or connection trouble. No
            installation identity, account or content.
          </p>
          <ul>
            {Object.entries(props.counts).map(([field, detail]) => (
              <li key={field}>
                <strong>
                  {field === 'event_id'
                    ? 'retry code'
                    : field.replaceAll('_', ' ')}
                </strong>
                :{' '}
                {Array.isArray(detail.domain)
                  ? detail.domain.join(', ')
                  : detail.domain}
                {detail.arrayMax !== undefined &&
                  `; at most ${detail.arrayMax} entries`}
                {detail.maxLength !== undefined &&
                  `; at most ${detail.maxLength} characters`}
                {detail.max !== undefined && `; at most ${detail.max}`}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p>
            App and feature usage, with a random installation code that changes
            each month. No account identity, conversation content, file paths,
            repository names, hostnames or branches.
          </p>
          <p>
            Each event includes a random retry code, times rounded to the
            minute, and app build information: version, platform, CPU type,
            release channel, source revision and whether the build has local
            changes.
          </p>
          <ul>
            {Object.entries(props.data.events).map(([event, definition]) => (
              <li key={event}>
                {definition.description}
                <ul>
                  {Object.entries(definition.properties).map(
                    ([property, detail]) => (
                      <li key={property}>
                        {property.replaceAll('_', ' ')}:{' '}
                        {Array.isArray(detail.domain)
                          ? detail.domain.join(', ')
                          : detail.domain}
                      </li>
                    ),
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function UsageSharingChoices({
  value,
  onChange,
  disabled,
  dnt,
  host,
  data,
  detailedAvailable = true,
  counts,
  onDetailedIntent,
}: {
  value: TelemetryTier | undefined;
  onChange: (tier: TelemetryTier) => void;
  disabled?: boolean;
  dnt?: boolean;
  host?: string;
  data?: SharingDisclosure;
  counts?: SharingCounts;
  onDetailedIntent?: () => void;
  detailedAvailable?: boolean;
}) {
  const name = useId();
  return (
    <>
      <p>
        Choose what usage information to share with Kontour. You can change this
        in Privacy &amp; sharing.
      </p>
      {host && <p>Also shared with: {host}</p>}
      {dnt && (
        <PageCallout
          calloutId="usage-sharing-dnt"
          ariaLabel="Do Not Track"
          tone="info"
        >
          Do Not Track is on, so nothing is shared. Your saved choice applies
          when it is turned off; detailed sharing will need your confirmation
          then.
        </PageCallout>
      )}
      <fieldset
        className="usage-telemetry-disclosure__choices"
        disabled={disabled}
      >
        <legend>Usage sharing</legend>
        {(['off', 'lite', 'full'] as const).map((tier) => (
          <label key={tier}>
            <input
              type="radio"
              name={name}
              aria-label={SHARING_LABELS[tier]}
              aria-describedby={
                tier === 'lite' ? `${name}-description` : undefined
              }
              checked={value === tier}
              disabled={tier === 'full' && !detailedAvailable}
              onClick={() => {
                if (tier === 'full') onDetailedIntent?.();
              }}
              onChange={() => onChange(tier)}
            />
            <span>
              {SHARING_LABELS[tier]}
              {tier === 'lite' && (
                <small id={`${name}-description`}>
                  One daily count. No ID, no account, no content.
                </small>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {value === 'lite' && counts && (
        <details className="usage-telemetry-disclosure__included">
          <summary>What's included</summary>
          <UsageSharingIncluded counts={counts} />
        </details>
      )}
      {value === 'full' && data?.events && <UsageSharingIncluded data={data} />}
    </>
  );
}
