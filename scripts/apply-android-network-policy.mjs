#!/usr/bin/env node
/** Preserve Station's explicit HTTP host support after Tauri regenerates Android. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function manifestWithStationNetworkPolicy(source) {
  const applications = [...source.matchAll(/<application\b[^>]*>/g)];
  if (applications.length !== 1)
    throw new Error('Expected exactly one Android application element.');
  const application = applications[0][0];
  if (/android:networkSecurityConfig\s*=/.test(application))
    throw new Error(
      'Review the Android network security config before applying HTTP host support.',
    );
  const next = /android:usesCleartextTraffic\s*=\s*"[^"]*"/.test(application)
    ? application.replace(
        /android:usesCleartextTraffic\s*=\s*"[^"]*"/,
        'android:usesCleartextTraffic="true"',
      )
    : application.replace(
        /(\s*\/?)>$/,
        ' android:usesCleartextTraffic="true"$1>',
      );
  return source.replace(application, next);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const path = resolve(
    import.meta.dirname,
    '../src-desktop/gen/android/app/src/main/AndroidManifest.xml',
  );
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, manifestWithStationNetworkPolicy(source));
  console.log(
    'Android explicit HTTP host support applied to generated manifest.',
  );
}
