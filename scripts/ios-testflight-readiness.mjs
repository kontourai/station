#!/usr/bin/env node
import {
  decodeProvisioningProfile,
  inspectAppStoreDistributionProfile,
} from './check-ios-store-profile.mjs';
import { iosTestFlightChannel } from './ios-testflight-channel.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

function required(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`Expected --${name} <value>`);
  return value;
}

export function iosTestFlightReadiness({
  channel,
  profilePath,
  team,
  groupId,
  decode = decodeProvisioningProfile,
  inspect = inspectAppStoreDistributionProfile,
}) {
  const identity = iosTestFlightChannel(channel);
  if (!/^[A-Za-z0-9-]+$/.test(groupId))
    throw new Error(
      'TestFlight internal group ID must be an App Store Connect resource ID.',
    );
  const profile = inspect(decode(profilePath), {
    label: profilePath,
    expectedTeam: team,
    expectedBundleIdentifier: identity.bundleId,
  });
  return {
    ready: true,
    channel,
    bundleId: identity.bundleId,
    appStoreName: identity.appStoreName,
    productName: identity.productName,
    groupId,
    profile,
  };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    console.log(
      JSON.stringify(
        iosTestFlightReadiness({
          channel: required(args, 'channel'),
          profilePath: required(args, 'station'),
          team: required(args, 'team'),
          groupId: required(args, 'group-id'),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
