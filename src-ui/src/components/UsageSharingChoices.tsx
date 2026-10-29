import type { TelemetryTier } from '@kontourai/station-contracts/product-telemetry';
import { type Ref, useId } from 'react';
import { PageCallout } from './PageCallout';
import './UsageTelemetryDisclosure.css';

export const SHARING_LABELS: Record<TelemetryTier, string> = {
  off: "Don't share",
  lite: 'Anonymous usage counts',
  full: 'Detailed usage to help improve Station',
};

export type SharingDisclosure = {
  additionalHost?: string;
  authorDisclosure?: SharingDisclosure & {
    destination: string;
    inventoryRevision: string;
  };
  envelope?: string;
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

function readableSharingFields(text: string): string {
  return text
    .replaceAll('schema_version', 'format version')
    .replaceAll('inventory_revision', 'definition version')
    .replaceAll('distinct_id', 'monthly installation code')
    .replaceAll('event_id', 'retry code')
    .replace(/\bfull (?=\d)/gi, 'complete ')
    .replace(/\bpublisher\b/gi, 'destination')
    .replace(/\boperator\b/gi, 'additional destination')
    .replace(/\binventory\b/gi, 'included fields')
    .replace(/\breceipt\b/gi, 'confirmation')
    .replace(/\bFull\b/g, 'Detailed usage')
    .replace(/\bLite\b/g, 'Anonymous usage counts')
    .replaceAll('_', ' ');
}

/** One readable view of the server-owned definitions, for both sharing choices. */
export function UsageSharingIncluded(
  props:
    | { data: SharingDisclosure; saveLabel?: string; dnt?: boolean }
    | { counts: SharingCounts },
) {
  const daily = 'counts' in props;
  return (
    <section
      aria-label="What's included"
      className="usage-telemetry-disclosure__included-content"
    >
      <h3>What's included</h3>
      {!daily && props.data.authorDisclosure && (
        <p>
          Shared with Kontour at:{' '}
          {new URL(props.data.authorDisclosure.destination).host}
        </p>
      )}
      {daily ? (
        <p>
          App version and device categories, grouped feature use and
          customization, and counts of setup or connection trouble. No
          installation identity, account or content.
        </p>
      ) : (
        <>
          <ul>
            <li>
              App build and device information, feature use, and setup or
              connection outcomes.
            </li>
            <li>
              A random installation code changes monthly and is different for
              each destination.
            </li>
            <li>
              Never account identity, conversation content, file paths,
              repository names, hostnames or branches.
            </li>
          </ul>
          <p>
            {props.dnt
              ? `Select ${props.saveLabel ?? 'Save'} to keep this choice for when Do Not Track is off.`
              : `Review what's included, then select ${props.saveLabel ?? 'Save'} to confirm detailed sharing.`}
          </p>
        </>
      )}
      <details className="usage-telemetry-disclosure__technical">
        <summary>Technical details</summary>
        {daily ? (
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
        ) : (
          <>
            <p>
              Each event includes a random retry code, times rounded to the
              minute, and app build information: version, platform, CPU type,
              release channel, source revision and whether the build has local
              changes.
            </p>
            {props.data.envelope && (
              <ul>
                {props.data.envelope.split('\n\n').map((block) => (
                  <li key={block}>{readableSharingFields(block)}</li>
                ))}
              </ul>
            )}
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
      </details>
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
  firstRun = false,
  initialChoiceRef,
}: {
  initialChoiceRef?: Ref<HTMLInputElement>;
  value: TelemetryTier | undefined;
  onChange: (tier: TelemetryTier) => void;
  disabled?: boolean;
  dnt?: boolean;
  host?: string;
  data?: SharingDisclosure;
  counts?: SharingCounts;
  onDetailedIntent?: () => void;
  detailedAvailable?: boolean;
  firstRun?: boolean;
}) {
  const name = useId();
  return (
    <>
      <p>
        Choose what usage information to share with Kontour.
        {firstRun && ' You can change this in Privacy & sharing.'}
      </p>
      {!firstRun && <p>Changes wait until you select Save.</p>}
      {host && <p>Also shared with: {host}</p>}
      {dnt && (
        <PageCallout
          calloutId="usage-sharing-dnt"
          ariaLabel="Do Not Track"
          tone="info"
        >
          Do Not Track is on, so nothing is shared. The choice below applies if
          you turn it off.
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
              ref={tier === (value ?? 'off') ? initialChoiceRef : undefined}
              type="radio"
              name={name}
              aria-label={SHARING_LABELS[tier]}
              aria-describedby={`${name}-${tier}-description`}
              checked={value === tier}
              disabled={tier === 'full' && !detailedAvailable}
              onClick={() => {
                if (tier === 'full') onDetailedIntent?.();
              }}
              onChange={() => onChange(tier)}
            />
            <span>
              {SHARING_LABELS[tier]}
              <small id={`${name}-${tier}-description`}>
                {tier === 'off'
                  ? 'No automatic usage sharing.'
                  : tier === 'lite'
                    ? 'One daily count. No ID, no account, no content.'
                    : 'Feature use. Monthly code. No account or content.'}
              </small>
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
      {value === 'full' && data?.events && (
        <UsageSharingIncluded
          data={data}
          saveLabel={firstRun ? 'Save choice' : 'Save'}
          dnt={dnt}
        />
      )}
    </>
  );
}
