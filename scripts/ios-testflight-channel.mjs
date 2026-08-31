#!/usr/bin/env node
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const IOS_TESTFLIGHT_CHANNELS = Object.freeze({
  stable: Object.freeze({
    bundleId: 'io.kontourai.station',
    productName: 'Station',
    appStoreName: 'Station by Kontour AI',
    scheme: 'station-stable',
    icon: 'icons/icon.png',
    environment: 'native-release',
    internalGroup: 'Station Stable Internal',
  }),
  beta: Object.freeze({
    bundleId: 'io.kontourai.station.beta',
    productName: 'Station Beta',
    appStoreName: 'Station Beta by Kontour AI',
    scheme: 'station-beta',
    icon: 'icons/beta/icon.png',
    environment: 'ios-beta',
    internalGroup: 'Station Beta Internal',
  }),
  nightly: Object.freeze({
    bundleId: 'io.kontourai.station.nightly',
    productName: 'Station Nightly',
    appStoreName: 'Station Nightly by Kontour AI',
    scheme: 'station-nightly',
    icon: 'icons/nightly/icon.png',
    environment: 'ios-nightly',
    internalGroup: 'Station Nightly Internal',
  }),
});

const MARKETING_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const NUMERIC_BUILD = /^(?:0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(`Invalid iOS TestFlight channel: ${message}`);
}

export function iosTestFlightChannel(channel) {
  if (
    typeof channel !== 'string' ||
    !Object.hasOwn(IOS_TESTFLIGHT_CHANNELS, channel)
  )
    fail(`unknown channel ${JSON.stringify(channel)}`);
  return IOS_TESTFLIGHT_CHANNELS[channel];
}

export function createIosTestFlightConfig({
  channel,
  marketingVersion,
  bundleVersion,
}) {
  const identity = iosTestFlightChannel(channel);
  if (
    typeof marketingVersion !== 'string' ||
    !MARKETING_VERSION.test(marketingVersion)
  )
    fail('marketingVersion must be a numeric X.Y.Z App Store version');
  if (typeof bundleVersion !== 'string' || !NUMERIC_BUILD.test(bundleVersion))
    fail('bundleVersion must be a non-negative decimal integer');
  if (!Number.isSafeInteger(Number(bundleVersion)))
    fail('bundleVersion exceeds the supported integer range');
  return {
    productName: identity.productName,
    identifier: identity.bundleId,
    version: marketingVersion,
    bundle: {
      // Apple will reject iOS 14 uploads after Spring 2027. Pin delivery
      // candidates now; development/simulator config stays independently set.
      iOS: { minimumSystemVersion: '15.0', bundleVersion },
      icon: [identity.icon],
    },
    plugins: {
      'deep-link': {
        mobile: [{ scheme: [identity.scheme], appLink: false }],
      },
    },
  };
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}

function main(args) {
  const channel = option(args, 'channel');
  const marketingVersion = option(args, 'marketing-version');
  const bundleVersion = option(args, 'bundle-version');
  const output = option(args, 'output');
  if (!channel || !marketingVersion || !bundleVersion || !output)
    fail(
      'usage: --channel <stable|beta|nightly> --marketing-version <version> --bundle-version <number> --output <path>',
    );
  if (args.length !== 8)
    fail('every supported option must be supplied exactly once');
  const config = createIosTestFlightConfig({
    channel,
    marketingVersion,
    bundleVersion,
  });
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
