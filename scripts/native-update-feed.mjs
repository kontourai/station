import { readFileSync, writeFileSync } from 'node:fs';
import semver from 'semver';

const CUSTOM_FEED_FIELDS = [
  'VITE_NATIVE_APP_UPDATE_FEED_URL',
  'VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN',
  'NATIVE_APP_UPDATE_ACTION_URL',
  'NATIVE_APP_UPDATE_ACTION_KIND',
  'NATIVE_APP_UPDATE_ACTION_ORIGINS',
];
const STORE_UPDATE_AUTHORITY = 'TestFlight/App Store';

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing required protected update value: ${name}`);
  return value;
}

function present(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

function requiredCustomFeedValues(env) {
  const provided = CUSTOM_FEED_FIELDS.filter((name) => present(env, name));
  if (provided.length === 0) return null;
  const missing = CUSTOM_FEED_FIELDS.filter((name) => !present(env, name));
  if (missing.length > 0) {
    throw new Error(
      `Native update feed configuration is partial; missing: ${missing.join(', ')}`,
    );
  }
  return Object.fromEntries(
    CUSTOM_FEED_FIELDS.map((name) => [name, env[name]]),
  );
}

function isExactIosStorePageAction(action, actionKind, iosAppId) {
  if (typeof iosAppId !== 'string' || !/^[1-9]\d*$/.test(iosAppId)) {
    throw new Error(
      'iOS custom update action requires the resolved numeric App Store Connect app ID',
    );
  }
  const pathSegments = action.pathname.split('/').filter(Boolean);
  return (
    actionKind === 'store-page' &&
    action.origin === 'https://apps.apple.com' &&
    pathSegments.at(-1) === `id${iosAppId}`
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {{ platform?: string | null, iosAppId?: string | null }} options
 */
export function resolveNativeUpdateAuthority(
  env = process.env,
  { platform = null, iosAppId = null } = {},
) {
  if (platform !== null && !['android', 'ios'].includes(platform))
    throw new Error('Native update platform must be android or ios');
  if (!/^[a-z0-9-]+$/.test(env.VITE_NATIVE_APP_UPDATE_CHANNEL ?? ''))
    throw new Error('Invalid native update channel');
  if (semver.valid(env.VITE_NATIVE_APP_VERSION ?? '') === null)
    throw new Error('Invalid immutable native app version');

  const custom = requiredCustomFeedValues(env);
  if (!custom) {
    const authority = {
      updateAuthority: STORE_UPDATE_AUTHORITY,
      customFeed: null,
      channel: env.VITE_NATIVE_APP_UPDATE_CHANNEL,
      version: env.VITE_NATIVE_APP_VERSION,
    };
    return platform === null ? authority : { ...authority, platform };
  }

  const feed = new URL(custom.VITE_NATIVE_APP_UPDATE_FEED_URL);
  const provider = new URL(custom.VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN);
  if (
    feed.protocol !== 'https:' ||
    provider.protocol !== 'https:' ||
    feed.username ||
    feed.password ||
    provider.username ||
    provider.password ||
    provider.origin !== provider.href.replace(/\/$/, '') ||
    feed.origin !== provider.origin
  ) {
    throw new Error(
      'Native update feed must be HTTPS and pinned to the provider origin',
    );
  }
  const action = new URL(custom.NATIVE_APP_UPDATE_ACTION_URL);
  if (action.protocol !== 'https:' || action.username || action.password)
    throw new Error('Native update action must be HTTPS');
  if (
    !['artifact', 'store-page'].includes(custom.NATIVE_APP_UPDATE_ACTION_KIND)
  )
    throw new Error('Native update action kind must be artifact or store-page');
  if (
    platform === 'ios' &&
    !isExactIosStorePageAction(
      action,
      custom.NATIVE_APP_UPDATE_ACTION_KIND,
      iosAppId,
    )
  ) {
    throw new Error(
      'iOS custom update action must be the exact App Store store-page URL for the resolved app ID',
    );
  }
  const actionOrigins =
    custom.NATIVE_APP_UPDATE_ACTION_ORIGINS.split(',').filter(Boolean);
  if (
    actionOrigins.length === 0 ||
    actionOrigins.some((value) => {
      const origin = new URL(value.trim());
      return (
        origin.protocol !== 'https:' ||
        origin.username ||
        origin.password ||
        origin.origin !== origin.href.replace(/\/$/, '')
      );
    })
  ) {
    throw new Error(
      'Native update action origins must be an explicit HTTPS allowlist',
    );
  }
  const normalizedActionOrigins = actionOrigins.map(
    (value) => new URL(value.trim()).origin,
  );
  if (platform === 'ios' && !normalizedActionOrigins.includes(action.origin)) {
    throw new Error(
      'iOS App Store action origin must be present in the HTTPS allowlist',
    );
  }

  const authority = {
    updateAuthority: STORE_UPDATE_AUTHORITY,
    customFeed: {
      endpoint: feed.href,
      providerOrigin: provider.origin,
      actionUrl: action.href,
      actionKind: custom.NATIVE_APP_UPDATE_ACTION_KIND,
      actionOrigins: normalizedActionOrigins,
    },
    channel: env.VITE_NATIVE_APP_UPDATE_CHANNEL,
    version: env.VITE_NATIVE_APP_VERSION,
  };
  return platform === null ? authority : { ...authority, platform };
}

export function validateUpdateConfig(env = process.env, options = {}) {
  return resolveNativeUpdateAuthority(env, options);
}

export function writeNativeUpdateAuthorityReceipt(
  output,
  env = process.env,
  options = {},
) {
  const authority = resolveNativeUpdateAuthority(env, options);
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'native-update-authority',
        ...authority,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return authority;
}

export async function deployUpdateFeed({
  endpoint,
  actionUrl,
  actionKind,
  actionOrigins,
  channel,
  version,
  token,
  bytes,
  fetchImpl = fetch,
}) {
  const observe = async (response) => {
    if (response.ok)
      return {
        state: 'present',
        bytes: await response.text(),
        etag: response.headers?.get('etag') ?? null,
      };
    if (response.status === 404 || response.status === 410)
      return { state: 'absent' };
    return { state: 'ambiguous', status: response.status };
  };
  const ambiguous = (message) => {
    const error = new Error(message);
    error.ambiguousFeedState = true;
    return error;
  };
  if (!token) throw new Error('Missing native update publish credential');
  let staged;
  try {
    staged = JSON.parse(bytes);
  } catch {
    throw new Error('Staged update feed is not valid JSON');
  }
  if (
    !staged ||
    typeof staged !== 'object' ||
    Array.isArray(staged) ||
    Object.keys(staged).sort().join(',') !== 'channel,releaseUrl,version' ||
    staged.channel !== channel ||
    staged.version !== version ||
    staged.releaseUrl !== actionUrl
  ) {
    throw new Error(
      'Staged update feed does not exactly match protected release values',
    );
  }
  const action = await fetchImpl(actionUrl, {
    method: 'GET',
    redirect: 'follow',
  });
  if (!action.ok) throw new Error('Native update action is not downloadable');
  let resolvedAction;
  try {
    resolvedAction = new URL(action.url);
  } catch {
    throw new Error('Native update action response did not expose a final URL');
  }
  const allowedActionOrigins = actionOrigins
    .split(',')
    .map((value) => new URL(value.trim()).origin);
  if (
    resolvedAction.protocol !== 'https:' ||
    !allowedActionOrigins.includes(resolvedAction.origin)
  ) {
    throw new Error(
      'Native update action redirected outside the protected HTTPS origin policy',
    );
  }
  const contentType = action.headers.get('content-type') ?? '';
  const disposition = action.headers.get('content-disposition') ?? '';
  if (
    (actionKind === 'artifact' &&
      !contentType.includes('application/octet-stream') &&
      !contentType.includes('application/vnd.android.package-archive') &&
      !/attachment/i.test(disposition)) ||
    (actionKind === 'store-page' && !contentType.includes('text/html'))
  ) {
    throw new Error(
      'Native update action did not resolve to its protected install target kind',
    );
  }
  const current = await fetchImpl(endpoint, {
    method: 'GET',
    redirect: 'error',
  });
  const prior = await observe(current);
  if (prior.state === 'ambiguous')
    throw ambiguous(`Cannot establish prior feed state: HTTP ${prior.status}`);
  const priorBytes = prior.state === 'present' ? prior.bytes : null;
  const priorEtag = prior.state === 'present' ? (prior.etag ?? '') : null;
  const conditional =
    prior.state === 'present'
      ? { 'If-Match': priorEtag ?? '' }
      : { 'If-None-Match': '*' };
  if (prior.state === 'present' && !conditional['If-Match'])
    throw new Error(
      'Update provider did not return an ETag for atomic replacement',
    );
  const restorePrior = async (changedEtag) => {
    const rollback = await fetchImpl(endpoint, {
      method: priorBytes === null ? 'DELETE' : 'PUT',
      redirect: 'error',
      body: priorBytes ?? undefined,
      headers: {
        Authorization: `Bearer ${token}`,
        'If-Match': changedEtag,
        ...(priorBytes === null ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    if (!rollback.ok) throw new Error(`rollback returned ${rollback.status}`);
    const restored = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
    });
    const restoredState = await observe(restored);
    if (restoredState.state === 'ambiguous')
      throw new Error(
        `rollback verification ambiguous: HTTP ${restoredState.status}`,
      );
    if (
      priorBytes === null
        ? restoredState.state !== 'absent'
        : restoredState.state !== 'present' ||
          restoredState.bytes !== priorBytes
    )
      throw new Error('rollback verification mismatch');
  };
  const inspectFailedPut = async (originalError) => {
    let observed;
    try {
      observed = await observe(
        await fetchImpl(endpoint, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
        }),
      );
    } catch (error) {
      throw ambiguous(
        `Feed state is ambiguous because failed-PUT inspection was unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (observed.state === 'ambiguous')
      throw ambiguous(
        `Feed state is ambiguous after failed PUT: HTTP ${observed.status}`,
      );
    if (
      (priorBytes === null && observed.state === 'absent') ||
      (observed.state === 'present' && observed.bytes === priorBytes)
    )
      throw originalError;
    if (
      observed.state === 'present' &&
      observed.bytes === bytes &&
      observed.etag
    ) {
      try {
        await restorePrior(observed.etag);
      } catch (error) {
        throw ambiguous(
          `Feed state is ambiguous after failed PUT rollback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw originalError;
    }
    throw ambiguous(
      'Feed state is ambiguous after failed PUT; manual recovery required',
    );
  };
  let published;
  try {
    published = await fetchImpl(endpoint, {
      method: 'PUT',
      redirect: 'error',
      body: bytes,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...conditional,
      },
    });
  } catch (publicationError) {
    return inspectFailedPut(publicationError);
  }
  if (!published.ok)
    return inspectFailedPut(
      new Error(`Update feed publication failed: ${published.status}`),
    );
  const publishedEtag = published.headers.get('etag');
  if (!publishedEtag) {
    let observedState;
    try {
      observedState = await observe(
        await fetchImpl(endpoint, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
        }),
      );
    } catch (error) {
      throw ambiguous(
        `Published feed has no ETag and observation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      observedState.state === 'present' &&
      observedState.bytes === bytes &&
      observedState.etag
    ) {
      try {
        await restorePrior(observedState.etag);
        throw new Error(
          'Published feed response omitted ETag; prior feed was restored',
        );
      } catch (rollbackError) {
        if (
          rollbackError instanceof Error &&
          rollbackError.message.includes('prior feed was restored')
        )
          throw rollbackError;
      }
    }
    const error = new Error(
      'Published feed has no ETag; state is ambiguous and requires manual recovery',
    );
    error.ambiguousFeedState = true;
    throw error;
  }
  let verifiedMatches;
  try {
    const verified = await fetchImpl(endpoint, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
    });
    verifiedMatches = verified.ok && (await verified.text()) === bytes;
  } catch (verificationError) {
    try {
      await restorePrior(publishedEtag);
      throw new Error(
        `Published feed fetchback failed; prior feed was restored: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
      );
    } catch (rollbackError) {
      if (
        rollbackError instanceof Error &&
        rollbackError.message.includes('prior feed was restored')
      )
        throw rollbackError;
      throw ambiguous(
        `Feed state is ambiguous after fetchback and rollback failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
  }
  if (!verifiedMatches) {
    try {
      await restorePrior(publishedEtag);
    } catch (rollbackError) {
      const error = new Error(
        `Feed state is ambiguous after rollback failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
      error.ambiguousFeedState = true;
      throw error;
    }
    throw new Error(
      'Published update feed failed verification; prior feed was restored',
    );
  }
}

function main() {
  const command = process.argv[2];
  const platformAt = process.argv.indexOf('--platform');
  const platform = platformAt >= 0 ? process.argv[platformAt + 1] : null;
  const iosAppIdAt = process.argv.indexOf('--ios-app-id');
  const iosAppId = iosAppIdAt >= 0 ? process.argv[iosAppIdAt + 1] : null;
  const options = {
    ...(platform === null ? {} : { platform }),
    ...(iosAppId === null ? {} : { iosAppId }),
  };
  if (command === 'validate-config') {
    resolveNativeUpdateAuthority(process.env, options);
    return;
  }
  if (command === 'write-authority-receipt') {
    const output = process.argv[3];
    if (!output) throw new Error('write-authority-receipt requires output');
    writeNativeUpdateAuthorityReceipt(output, process.env, options);
    return;
  }
  resolveNativeUpdateAuthority(process.env, options);
  if (command === 'publish') {
    const output = process.argv[3];
    const releaseUrl = required('NATIVE_APP_UPDATE_ACTION_URL');
    if (!output || !releaseUrl)
      throw new Error('publish requires output and release URL');
    const release = new URL(releaseUrl);
    if (release.protocol !== 'https:')
      throw new Error('Release action URL must be HTTPS');
    writeFileSync(
      output,
      `${JSON.stringify({ channel: required('VITE_NATIVE_APP_UPDATE_CHANNEL'), version: required('VITE_NATIVE_APP_VERSION'), releaseUrl })}\n`,
    );
    const parsed = JSON.parse(readFileSync(output, 'utf8'));
    if (parsed.version !== required('VITE_NATIVE_APP_VERSION'))
      throw new Error('Published feed version drifted');
    return;
  }
  if (command === 'deploy') {
    const bytes = readFileSync(process.argv[3], 'utf8');
    return deployUpdateFeed({
      endpoint: required('VITE_NATIVE_APP_UPDATE_FEED_URL'),
      actionUrl: required('NATIVE_APP_UPDATE_ACTION_URL'),
      actionKind: required('NATIVE_APP_UPDATE_ACTION_KIND'),
      actionOrigins: required('NATIVE_APP_UPDATE_ACTION_ORIGINS'),
      channel: required('VITE_NATIVE_APP_UPDATE_CHANNEL'),
      version: required('VITE_NATIVE_APP_VERSION'),
      token: required('NATIVE_APP_UPDATE_PUBLISH_TOKEN'),
      bytes,
    });
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    await main();
  } catch (error) {
    if (error?.ambiguousFeedState) {
      console.error(error.message);
      process.exitCode = 75;
    } else {
      throw error;
    }
  }
}
