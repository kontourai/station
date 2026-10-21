/**
 * The public agent registry's part of the Add engine catalogue: where the
 * listing came from and how fresh it is, each listed engine's publisher,
 * version and availability, and an added engine's "the registry lists
 * something else now" notice. Nothing here changes a saved connection.
 */

import type {
  ACPConnectionRegistryEntry,
  ACPPublicRegistryListing,
  ACPPublicRegistrySourceStatus,
} from '@kontourai/station-contracts/acp';
import { useEffect, useRef, useState } from 'react';
import {
  refreshACPPublicRegistrySource,
  useACPConnectionRegistry,
  useACPPublicRegistrySource,
} from '../../hooks/useACPConnections';
import { openExternalLink } from '../../platform/openExternalLink';
import { relativeTimeAgo } from '../../utils/relativeTime';
import { Button } from '../Button';
import { RegistryEntryInstallHint } from './RegistryEntryInstallHint';
import { registryEntryDiscovery } from './registryEntryDiscovery';
import './PublicRegistry.css';

/** The listing's exact command line, as connecting would run it. */
export function publicRegistryCommandLine(
  launch: NonNullable<ACPPublicRegistryListing['hostLaunch']>,
): string {
  return [launch.command, ...launch.args].join(' ');
}

function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? relativeTimeAgo(at, now) : null;
}

/** One sentence on where the listing below came from. */
function publicRegistrySourceSentence(
  status: ACPPublicRegistrySourceStatus,
  now: number,
): string {
  const checked = ago(status.checkedAt, now);
  const fetched = ago(status.fetchedAt, now);
  if (status.origin === 'none') {
    if (status.refreshing) return 'Checking the public registry…';
    return status.lastError
      ? `Could not read the public registry: ${status.lastError}`
      : 'The public registry has not been checked yet.';
  }
  if (status.origin === 'network') {
    return `Registry checked ${checked ?? fetched ?? 'recently'}.`;
  }
  const saved = `Offline copy, downloaded ${fetched ?? 'earlier'}.`;
  return status.lastError && checked
    ? `${saved} Registry checked ${checked}: ${status.lastError}`
    : saved;
}

/** How often the line re-reads the status while a download is running. */
const REFRESHING_POLL_MS = 2_000;

function PublicRegistrySourceLine({
  status,
  refetch,
}: {
  status: ACPPublicRegistrySourceStatus;
  refetch: () => unknown;
}) {
  const { refetch: refetchEntries } = useACPConnectionRegistry() as {
    refetch: () => unknown;
  };
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Reading the catalogue starts a background download when the listing is
  // stale. Follow it, then re-read the entries it produced.
  const wasRefreshing = useRef(status.refreshing);
  useEffect(() => {
    if (wasRefreshing.current && !status.refreshing) void refetchEntries();
    wasRefreshing.current = status.refreshing;
    if (!status.refreshing) return;
    const timer = setTimeout(() => void refetch(), REFRESHING_POLL_MS);
    return () => clearTimeout(timer);
  }, [status, refetch, refetchEntries]);
  return (
    <div className="public-registry__source" role="status">
      <span>{publicRegistrySourceSentence(status, Date.now())}</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={checking || status.refreshing}
        onClick={() => {
          setChecking(true);
          setNotice(null);
          void refreshACPPublicRegistrySource()
            .then((result) => {
              if (result.status === 'not-permitted') {
                setNotice(
                  'This sign-in cannot ask Station to check the registry. The list shows the last copy Station has.',
                );
              }
            })
            .catch(() =>
              setNotice('Station could not check the registry just now.'),
            )
            .then(() => Promise.all([refetch(), refetchEntries()]))
            .finally(() => setChecking(false));
        }}
      >
        {checking ? 'Checking…' : 'Check registry'}
      </Button>
      {notice ? <p className="public-registry__notice">{notice}</p> : null}
    </div>
  );
}

/** Publisher, version and licence, as the registry states them. */
export function PublicRegistryFacts({
  listing,
}: {
  listing: ACPPublicRegistryListing;
}) {
  const parts = [
    `By ${listing.publishers.join(', ')}`,
    `version ${listing.version}`,
    ...(listing.license ? [listing.license] : []),
  ];
  return <div className="public-registry__facts">{parts.join(' · ')}</div>;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalLink(href);
      }}
    >
      {children}
    </a>
  );
}

/** Everything the listing says, open for an entry that cannot connect too. */
function PublicRegistryDetails({
  entry,
  listing,
}: {
  entry: ACPConnectionRegistryEntry;
  listing: ACPPublicRegistryListing;
}) {
  return (
    <details className="public-registry__details">
      <summary>About this listing</summary>
      <dl>
        <dt>Registry id</dt>
        <dd>{listing.id}</dd>
        <dt>Ways it is distributed</dt>
        <dd>{listing.distributions.join(', ')}</dd>
        {listing.binaryPlatforms.length > 0 ? (
          <>
            <dt>Builds for</dt>
            <dd>{listing.binaryPlatforms.join(', ')}</dd>
          </>
        ) : null}
        {listing.packages?.map((pkg) => (
          <div key={`${pkg.kind}:${pkg.package}`}>
            <dt>Package ({pkg.kind})</dt>
            <dd>
              <code>{pkg.package}</code>
            </dd>
          </div>
        ))}
        {listing.hostLaunch ? (
          <>
            <dt>Connecting runs</dt>
            <dd>
              <code>{publicRegistryCommandLine(listing.hostLaunch)}</code>
            </dd>
          </>
        ) : null}
        {listing.recommendedEnv ? (
          <>
            <dt>Settings the registry recommends</dt>
            <dd>
              {Object.entries(listing.recommendedEnv)
                .map(([name, value]) => `${name}=${value}`)
                .join(', ')}{' '}
              (Station does not apply these.)
            </dd>
          </>
        ) : null}
      </dl>
      <div className="public-registry__links">
        {listing.websiteUrl ? (
          <ExternalLink href={listing.websiteUrl}>
            {`${entry.name} website`}
          </ExternalLink>
        ) : null}
        {listing.repositoryUrl ? (
          <ExternalLink href={listing.repositoryUrl}>
            {`${entry.name} source`}
          </ExternalLink>
        ) : null}
      </div>
    </details>
  );
}

/**
 * The "From the public registry" group. Listings that cannot connect on this
 * computer stay in the list, with the reason and their details.
 */
export function PublicRegistryCatalogGroup({
  entries,
  onChoose,
}: {
  entries: ACPConnectionRegistryEntry[];
  onChoose: (entry: ACPConnectionRegistryEntry) => void;
}) {
  const { data: status, refetch } = useACPPublicRegistrySource() as {
    data?: ACPPublicRegistrySourceStatus;
    refetch: () => unknown;
  };
  if (status?.enabled !== true && entries.length === 0) return null;
  return (
    <section
      className="public-registry"
      aria-labelledby="public-registry-heading"
    >
      <h3 id="public-registry-heading" className="public-registry__heading">
        From the public registry
      </h3>
      <p className="public-registry__intro">
        Listed by their publishers, not by Station. Station connects only a
        program you installed yourself, and shows exactly what it runs before it
        does.
      </p>
      {status ? (
        <PublicRegistrySourceLine status={status} refetch={refetch} />
      ) : null}
      <div className="plugins__registry-list">
        {entries.map((entry) => {
          const listing = entry.publicRegistry;
          if (!listing) return null;
          const available = Boolean(listing.hostLaunch);
          const discovery = registryEntryDiscovery(entry);
          const label = !available
            ? 'Unavailable'
            : discovery === 'detected-unconfigured'
              ? 'Found'
              : 'Not installed';
          return (
            <div
              className="plugins__registry-item"
              key={entry.id}
              data-testid={`public-registry-entry-${entry.id}`}
            >
              <div className="plugins__registry-info">
                <div className="plugins__registry-name">
                  {entry.name}
                  <span className="plugins__cap plugins__cap--ref">
                    {label}
                  </span>
                </div>
                <PublicRegistryFacts listing={listing} />
                {entry.description ? (
                  <div className="plugins__registry-desc">
                    {entry.description}
                  </div>
                ) : null}
                {listing.unavailableReason ? (
                  <p className="public-registry__reason">
                    {listing.unavailableReason}
                  </p>
                ) : null}
                {available ? <RegistryEntryInstallHint entry={entry} /> : null}
                <PublicRegistryDetails entry={entry} listing={listing} />
              </div>
              {available ? (
                <button
                  type="button"
                  className="editor-btn"
                  onClick={() => onChoose(entry)}
                  aria-label={`Review ${entry.name}`}
                >
                  Review
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * On an added engine: the public listing it came from now names another
 * version or command. Shown, never applied.
 */
export function PublicRegistryUpdateNotice({
  entry,
}: {
  entry: ACPConnectionRegistryEntry | undefined;
}) {
  const update = entry?.publicRegistry?.update;
  if (!entry || !update) return null;
  return (
    <div
      className="public-registry__update"
      role="status"
      data-testid="public-registry-update"
    >
      <strong>Update listed</strong>
      <span>
        The public registry now lists {entry.name} version {update.version}
        {update.command
          ? `, run as ${[update.command, ...(update.args ?? [])].join(' ')}`
          : ''}
        . Your saved connection is unchanged; update the program yourself, and
        change the connection's command if it should run something else.
      </span>
    </div>
  );
}
