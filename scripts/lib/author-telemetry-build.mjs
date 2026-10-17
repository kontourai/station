import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';

/** Public binary metadata. Release workflows are the only supported writers. */
export function authorTelemetryEndpoint(channel, env = process.env) {
  const endpoint = env.STATION_AUTHOR_TELEMETRY_ENDPOINT || '';
  if (!endpoint) return '';

  const ref = env.GITHUB_REF || '';
  const workflow = env.GITHUB_WORKFLOW_REF || '';
  const release =
    env.GITHUB_EVENT_NAME === 'push' &&
    /^refs\/tags\/v\d+\.\d+\.\d+(?:-preview\.[1-9]\d*)?$/.test(ref) &&
    workflow === `kontourai/station/.github/workflows/release.yml@${ref}`;
  const nightly =
    ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) &&
    ref === 'refs/heads/main' &&
    workflow ===
      'kontourai/station/.github/workflows/nightly.yml@refs/heads/main';
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'kontourai/station' ||
    !(release || nightly)
  ) {
    throw new Error(
      'Author telemetry endpoint is forbidden outside official release builds',
    );
  }
  const ring = release
    ? ref.includes('-preview.')
      ? 'preview'
      : 'stable'
    : 'nightly';
  if (channel !== STATION_RELEASE_RINGS[ring].runtimeChannel) {
    throw new Error(
      'Author telemetry endpoint requires the existing build channel to match the release',
    );
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      'Author telemetry endpoint must be a canonical HTTPS URL without credentials, query or fragment',
    );
  }
  if (
    endpoint !== url.href ||
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    /^https:\/\/[^/]*@/i.test(endpoint) ||
    endpoint.includes('?') ||
    endpoint.includes('#') ||
    /\s/.test(endpoint)
  ) {
    throw new Error(
      'Author telemetry endpoint must be a canonical HTTPS URL without credentials, query or fragment',
    );
  }
  return url.href;
}
