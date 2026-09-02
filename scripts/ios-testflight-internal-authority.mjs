import { assertProductVersion } from './product-version.mjs';

export const IOS_TESTFLIGHT_INTERNAL_TAG_PREFIX = 'refs/tags/ios-testflight/';
export const IOS_TESTFLIGHT_INTERNAL_RELEASE_SLOT = 11_100;

const CHANNELS = new Set(['stable', 'beta', 'nightly']);
const INTERNAL_TAG = new RegExp(
  `^${IOS_TESTFLIGHT_INTERNAL_TAG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(stable|beta|nightly)/v((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))/(0|[1-9]\\d*)$`,
);

function fail(message) {
  throw new Error(`Invalid internal iOS TestFlight authority: ${message}`);
}

export function internalTestFlightBuild({ channel, version }) {
  if (!CHANNELS.has(channel))
    fail(`unknown channel ${JSON.stringify(channel)}`);
  assertProductVersion(version);
  // Stable and Beta intentionally occupy a protected internal-only slot. The
  // ordinary release authority retains the surrounding release build range.
  return channel === 'nightly'
    ? null
    : String(IOS_TESTFLIGHT_INTERNAL_RELEASE_SLOT);
}

export function internalTestFlightAuthorityRef({
  channel,
  version,
  bundleVersion,
}) {
  if (!CHANNELS.has(channel))
    fail(`unknown channel ${JSON.stringify(channel)}`);
  assertProductVersion(version);
  if (
    typeof bundleVersion !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(bundleVersion)
  )
    fail('bundleVersion must be a non-negative decimal integer');
  if (!Number.isSafeInteger(Number(bundleVersion)))
    fail('bundleVersion exceeds the supported integer range');
  const fixedBuild = internalTestFlightBuild({ channel, version });
  if (fixedBuild !== null && bundleVersion !== fixedBuild) {
    fail(
      `${channel} must use reserved internal build ${fixedBuild}; release slots 11101 through 11199 remain external authority`,
    );
  }
  return `${IOS_TESTFLIGHT_INTERNAL_TAG_PREFIX}${channel}/v${version}/${bundleVersion}`;
}

export function parseInternalTestFlightAuthorityRef(ref) {
  const match = typeof ref === 'string' ? INTERNAL_TAG.exec(ref) : null;
  if (!match) fail('ref is not an internal iOS TestFlight authority tag');
  const [, channel, version, bundleVersion] = match;
  internalTestFlightAuthorityRef({ channel, version, bundleVersion });
  return { channel, version, bundleVersion };
}
