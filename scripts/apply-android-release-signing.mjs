#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_GRADLE = join(
  'src-desktop',
  'gen',
  'android',
  'app',
  'build.gradle.kts',
);

const SIGNING_CONFIG = `    // station:release-signing:start
    val releaseKeystorePath = System.getenv("TAURI_ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("TAURI_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TAURI_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("TAURI_ANDROID_KEY_PASSWORD")
            }
        }
    }
    // station:release-signing:end
`;

const RELEASE_ASSIGNMENT = `        getByName("release") {
            if (releaseKeystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }`;

export function gradleWithAndroidReleaseSigning(source) {
  if (source.includes('TAURI_ANDROID_KEYSTORE_PATH')) {
    for (const required of [
      'TAURI_ANDROID_KEYSTORE_PASSWORD',
      'TAURI_ANDROID_KEY_ALIAS',
      'TAURI_ANDROID_KEY_PASSWORD',
      'signingConfig = signingConfigs.getByName("release")',
    ]) {
      if (!source.includes(required)) {
        throw new Error(
          `Existing Android signing contract is missing ${required}.`,
        );
      }
    }
    return source;
  }
  if (!source.includes('    defaultConfig {')) {
    throw new Error(
      'Generated Android Gradle file has no defaultConfig insertion point.',
    );
  }
  if (!source.includes('        getByName("release") {')) {
    throw new Error('Generated Android Gradle file has no release build type.');
  }
  return source
    .replace('    defaultConfig {', `${SIGNING_CONFIG}    defaultConfig {`)
    .replace('        getByName("release") {', RELEASE_ASSIGNMENT);
}

export function applyAndroidReleaseSigning({ root = ROOT } = {}) {
  const path = join(root, BUILD_GRADLE);
  const current = readFileSync(path, 'utf8');
  const next = gradleWithAndroidReleaseSigning(current);
  if (next !== current) writeFileSync(path, next);
  return path;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  applyAndroidReleaseSigning();
  console.log('Android release signing contract applied.');
}
