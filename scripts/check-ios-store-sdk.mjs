#!/usr/bin/env node
// Apple requires the iOS 26 SDK for App Store uploads since April 28, 2026.
// https://developer.apple.com/news/upcoming-requirements/
export function assertIosStoreSdk(version) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(version) ||
    Number(version.split('.')[0]) < 26
  ) {
    throw new Error(
      `App Store uploads require iOS SDK 26 or later; observed ${JSON.stringify(version)}`,
    );
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv.length !== 3)
    throw new Error('Expected one iOS SDK version');
  assertIosStoreSdk(process.argv[2]);
  console.log(`App Store SDK preflight passed: iOS ${process.argv[2]}`);
}
