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
  const npm =
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    ref === 'refs/heads/main' &&
    workflow ===
      'kontourai/station/.github/workflows/publish-packages.yml@refs/heads/main';
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'kontourai/station' ||
    !(release || nightly || npm)
  ) {
    throw new Error(
      'Author telemetry endpoint is forbidden outside official release builds',
    );
  }
  const expectedChannel = release
    ? ref.includes('-preview.')
      ? 'preview'
      : 'stable'
    : nightly
      ? 'nightly'
      : 'stable';
  if (channel !== expectedChannel) {
    throw new Error(
      'Author telemetry endpoint requires the existing build channel to match the release',
    );
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      'Author telemetry endpoint must be an HTTPS URL without credentials, query or fragment',
    );
  }
  if (
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
      'Author telemetry endpoint must be an HTTPS URL without credentials, query or fragment',
    );
  }
  return url.href;
}
