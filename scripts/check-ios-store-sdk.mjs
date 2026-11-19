#!/usr/bin/env node
import { invokedDirectly } from './lib/module-entry.mjs';

// Adopt the iOS 27 SDK ahead of Apple’s April 2027 upload requirement.
// https://developer.apple.com/news/upcoming-requirements/
const MIN_IOS_STORE_SDK_MAJOR = 27;

export function assertIosStoreSdk(version) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(version) ||
    Number(version.split('.')[0]) < MIN_IOS_STORE_SDK_MAJOR
  ) {
    throw new Error(
      `App Store uploads require iOS SDK ${MIN_IOS_STORE_SDK_MAJOR} or later; observed ${JSON.stringify(version)}`,
    );
  }
}

if (invokedDirectly(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Expected one iOS SDK version');
  assertIosStoreSdk(process.argv[2]);
  console.log(`App Store SDK preflight passed: iOS ${process.argv[2]}`);
}
