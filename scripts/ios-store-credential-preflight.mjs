#!/usr/bin/env node
import { writeIosStoreSigningConfig } from './ios-store-signing-config.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const REQUIRED = [
  'station',
  'identity',
  'team',
  'bundle-id',
  'template',
  'template-output',
  'overlay-output',
];

export function parseCredentialPreflightOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = flag?.startsWith('--') ? flag.slice(2) : '';
    if (
      !REQUIRED.includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error(
        'Expected every required iOS credential preflight option exactly once.',
      );
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== REQUIRED.length) {
    throw new Error('Missing required iOS credential preflight option.');
  }
  return {
    profile: values.station,
    identity: values.identity,
    team: values.team,
    bundleId: values['bundle-id'],
    template: values.template,
    templateOutput: values['template-output'],
    overlayOutput: values['overlay-output'],
  };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const profile = writeIosStoreSigningConfig(
      parseCredentialPreflightOptions(process.argv.slice(2)),
    );
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        distribution: profile.distribution,
        team: profile.team,
        applicationIdentifier: profile.applicationIdentifier,
        expiration: profile.expiration,
      })}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
