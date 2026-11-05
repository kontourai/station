import { clientVersionInHostOrder } from '@kontourai/station-shared/release-version-order';
import { useApiQuery } from './query-core';

export const STATION_RELEASE_HISTORY_URL =
  'https://github.com/kontourai/station/releases';
const API = 'https://api.github.com/repos/kontourai/station/releases';

export interface StationReleaseNotes {
  tag: string;
  name: string;
  version: string;
  body: string;
  url: string;
}

function parseRelease(value: unknown): StationReleaseNotes | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as Record<string, unknown>;
  const tag = release.tag_name;
  if (typeof tag !== 'string' || release.draft !== false) return null;
  const version = tag.replace(/^(?:desktop-)?v/, '');
  if (!/^(?:desktop-)?v/.test(tag) || !clientVersionInHostOrder(version))
    return null;
  return {
    tag,
    version,
    name:
      typeof release.name === 'string' ? release.name : `Station ${version}`,
    body: typeof release.body === 'string' ? release.body : '',
    url: `${STATION_RELEASE_HISTORY_URL}/tag/${encodeURIComponent(tag)}`,
  };
}

async function readRelease(path: string, signal?: AbortSignal) {
  // Public release prose never carries a selected Station's credentials.
  const response = await fetch(`${API}${path}`, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`GitHub release notes: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function useStationReleaseNotesQuery(
  version: string | null,
  nativeApp: boolean,
  enabled = true,
) {
  const tag =
    version && clientVersionInHostOrder(version)
      ? `${nativeApp && version.includes('-nightly.') ? 'desktop-' : ''}v${version}`
      : null;
  return useApiQuery(
    ['station-release-notes', tag],
    async (signal) => {
      const release = parseRelease(
        await readRelease(`/tags/${encodeURIComponent(tag!)}`, signal),
      );
      if (release && release.tag !== tag)
        throw new Error('GitHub returned different release notes');
      return release;
    },
    {
      enabled: enabled && tag !== null,
      staleTime: 60 * 60 * 1000,
      retry: false,
    },
  );
}

export function useStationReleaseHistoryQuery(enabled = true) {
  return useApiQuery(
    ['station-release-history'],
    async (signal) => {
      const data = await readRelease('?per_page=100', signal);
      if (!Array.isArray(data))
        throw new Error('GitHub returned an invalid release history');
      return data.flatMap((value) => {
        const release = parseRelease(value);
        return release ? [release] : [];
      });
    },
    { enabled, staleTime: 5 * 60 * 1000, retry: false },
  );
}
