#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_ANDROID = join('src-desktop', 'gen', 'android');

export function resetAndroidGeneratedProject({ root = ROOT } = {}) {
  const trustedRoot = resolve(root);
  const srcDesktop = resolve(trustedRoot, 'src-desktop');
  const generatedParent = resolve(srcDesktop, 'gen');
  const generated = resolve(root, GENERATED_ANDROID);
  if (dirname(generated) !== generatedParent) {
    throw new Error('Refusing to reset Android outside src-desktop/gen.');
  }
  for (const candidate of [
    trustedRoot,
    srcDesktop,
    generatedParent,
    generated,
  ]) {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'Refusing to reset through a non-directory or symlinked Android ancestor.',
      );
    }
  }
  const realRoot = realpathSync(trustedRoot);
  const realSrcDesktop = realpathSync(srcDesktop);
  const realGeneratedParent = realpathSync(generatedParent);
  const realGenerated = realpathSync(generated);
  if (
    dirname(realSrcDesktop) !== realRoot ||
    dirname(realGeneratedParent) !== realSrcDesktop ||
    dirname(realGenerated) !== realGeneratedParent
  ) {
    throw new Error(
      'Refusing to reset an Android project outside the trusted real path.',
    );
  }
  const gradle = readFileSync(
    join(generated, 'app', 'build.gradle.kts'),
    'utf8',
  );
  const settings = readFileSync(join(generated, 'settings.gradle'), 'utf8');
  const includesApp = /include\s*(?:\(\s*["']:app["']\s*\)|["']:app["'])/.test(
    settings,
  );
  if (!gradle.includes('id("rust")') || !includesApp) {
    throw new Error(
      'Refusing to reset an unrecognized generated Android project.',
    );
  }
  rmSync(generated, { recursive: true });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  resetAndroidGeneratedProject();
  console.log('Removed the incompatible generated Android namespace.');
}
