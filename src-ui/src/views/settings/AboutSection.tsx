import { useQuery } from '@tanstack/react-query';
import { type MouseEvent, useId, useState } from 'react';
import { buildInfo, verifiedBuildLabel } from '../../build-info';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { InfoGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { openExternalLink } from '../../platform/openExternalLink';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { InstalledAppBuildProvenance } from './BuildProvenance';
import { SettingsPageRow as PageRow } from './SettingsPageRow';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';
import './AboutSection.css';

/** Written next to index.html by `scripts/vite-third-party-licenses.ts`. */
const THIRD_PARTY_LICENSES_URL = '/third-party-licenses.json';

const PRIVACY_POLICY_URL = 'https://kontourai.io/privacy/station/';
const SUPPORT_URL = 'https://kontourai.io/support/';
const STATION_LICENSE_URL =
  'https://github.com/kontourai/station/blob/main/LICENSE';

interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
  repository?: string;
  text?: string;
}

const CHANNEL_LABELS = {
  stable: 'Stable',
  beta: 'Beta',
  nightly: 'Nightly',
  dev: 'Development',
} as const;

async function fetchThirdPartyLicenses(): Promise<ThirdPartyPackage[]> {
  const response = await fetch(THIRD_PARTY_LICENSES_URL, {
    cache: 'no-cache',
  });
  if (!response.ok)
    throw new Error(`License list unavailable (HTTP ${response.status})`);
  const body = (await response.json()) as { packages?: unknown };
  if (!Array.isArray(body.packages))
    throw new Error('License list is malformed');
  return body.packages as ThirdPartyPackage[];
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  // A plain anchor would navigate the native webview away from Station.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternalLink(href);
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={open}>
      {children}
    </a>
  );
}

function OpenSourceLicenses() {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const regionId = useId();
  const licenses = useQuery({
    queryKey: ['third-party-licenses'],
    queryFn: fetchThirdPartyLicenses,
    enabled: expanded,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const needle = filter.trim().toLowerCase();
  const shown = (licenses.data ?? []).filter(
    (entry) =>
      !needle ||
      entry.name.toLowerCase().includes(needle) ||
      entry.license.toLowerCase().includes(needle),
  );
  return (
    <PageRow
      {...settingsRow('open-source-licenses')}
      description="Station is built on open source software. These are the packages included in this app, with the license each one is used under."
    >
      <DisclosureToggle
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        controls={regionId}
      >
        {licenses.data
          ? `${licenses.data.length} packages`
          : 'Bundled packages'}
      </DisclosureToggle>
      {expanded && (
        <div id={regionId} className="about__licenses">
          {licenses.isPending && (
            <SkeletonList count={4} withIcon={false} label="Loading licenses" />
          )}
          {licenses.isError && (
            <ErrorState
              variant="compact"
              title="License list unavailable"
              description="This build did not include its license list. Release builds always include it."
              action={
                <button
                  type="button"
                  className="settings__secondary-btn"
                  onClick={() => void licenses.refetch()}
                >
                  Try again
                </button>
              }
            />
          )}
          {licenses.data && (
            <>
              <input
                type="search"
                className="about__licenses-filter"
                placeholder="Filter by package or license"
                aria-label="Filter open source packages"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {shown.length === 0 ? (
                <Empty
                  variant="compact"
                  label={needle ? 'No matching packages' : 'No packages listed'}
                />
              ) : (
                <ul className="about__license-list">
                  {shown.map((entry) => (
                    <li key={`${entry.name}@${entry.version}`}>
                      <details className="about__license">
                        <summary>
                          <span className="about__license-name">
                            {entry.name}
                          </span>{' '}
                          <span className="about__license-meta">
                            {entry.version} · {entry.license}
                          </span>
                        </summary>
                        {entry.repository && (
                          <p className="about__license-source">
                            <ExternalLink href={entry.repository}>
                              {entry.repository}
                            </ExternalLink>
                          </p>
                        )}
                        {entry.text ? (
                          <pre className="about__license-text">
                            {entry.text}
                          </pre>
                        ) : (
                          <p className="settings__field-hint">
                            This package does not ship a license file; it
                            declares {entry.license} in its manifest.
                          </p>
                        )}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </PageRow>
  );
}

/**
 * Settings → About: what this installed app is and the notices a store
 * release must carry. Everything here is local to the app build; nothing is
 * read from the connected Station.
 */
export function AboutSection({
  onOpenSection,
}: {
  onOpenSection: (section: string) => void;
}) {
  const platform = usePlatformProfile();
  const channel = platform.channel ? CHANNEL_LABELS[platform.channel] : null;
  return (
    <SettingsSection icon={<InfoGlyph />} title="About" id="section-about">
      <PageRow
        {...settingsRow('app-version')}
        description={
          verifiedBuildLabel
            ? `${platform.productName ?? 'Station'} ${buildInfo.version}${channel ? ` · ${channel}` : ''} · commit ${buildInfo.commit}`
            : 'Development build: no release version is stamped on it.'
        }
      >
        {platform.isTauri && (
          <InstalledAppBuildProvenance
            build={platform.clientBuild}
            development={platform.isDevBuild}
          />
        )}
        <div className="about__links">
          <button
            type="button"
            className="settings__secondary-btn"
            onClick={() => onOpenSection('system')}
          >
            Updates and build details
          </button>
          <button
            type="button"
            className="settings__secondary-btn"
            onClick={() => onOpenSection('diagnostics')}
          >
            Diagnostics
          </button>
        </div>
      </PageRow>
      <OpenSourceLicenses />
      <PageRow {...settingsRow('legal')} description="Station by Kontour AI.">
        <ul className="about__legal" aria-label="Legal links">
          <li>
            <ExternalLink href={PRIVACY_POLICY_URL}>
              Privacy policy
            </ExternalLink>
          </li>
          <li>
            <ExternalLink href={STATION_LICENSE_URL}>
              Station license (Apache 2.0)
            </ExternalLink>
          </li>
          <li>
            <ExternalLink href={SUPPORT_URL}>Support</ExternalLink>
          </li>
        </ul>
      </PageRow>
    </SettingsSection>
  );
}
