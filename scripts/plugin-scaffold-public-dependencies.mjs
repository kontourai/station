#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const DEPENDENCIES_PATH = fileURLToPath(
  new URL('../config/plugin-scaffold-dependencies.json', import.meta.url),
);
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
const EXPECTED_PACKAGES = [
  '@kontourai/station-sdk',
  '@kontourai/station-shared',
];

function parseVersions(raw, packageName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for ${packageName}`, {
      cause: error,
    });
  }
  const versions = typeof parsed === 'string' ? [parsed] : parsed;
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    versions.some(
      (version) => typeof version !== 'string' || !semver.valid(version),
    )
  ) {
    throw new Error(
      `npm returned no valid published versions for ${packageName}`,
    );
  }
  return versions;
}

export function readPluginScaffoldDependencies(path = DEPENDENCIES_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    JSON.stringify(Object.keys(parsed).sort()) !==
      JSON.stringify([...EXPECTED_PACKAGES].sort())
  ) {
    throw new Error(
      'plugin scaffold dependency authority has an unexpected shape',
    );
  }
  return parsed;
}

export function assertPublishedPluginScaffoldDependencies(
  dependencies,
  lookupVersions,
) {
  const qualified = [];
  for (const packageName of EXPECTED_PACKAGES) {
    const range = dependencies[packageName];
    if (
      typeof range !== 'string' ||
      !semver.validRange(range) ||
      /^(?:workspace|file|link|git|https?):/i.test(range)
    ) {
      throw new Error(`${packageName} has a non-registry scaffold range`);
    }
    const versions = lookupVersions(packageName);
    const resolved = semver.maxSatisfying(versions, range);
    if (!resolved) {
      throw new Error(
        `${packageName}@${range} does not resolve to a published npm version`,
      );
    }
    qualified.push({ packageName, range, resolved });
  }
  return qualified;
}

function livePublishedVersions(packageName) {
  const raw = execFileSync(
    'npm',
    [
      'view',
      packageName,
      'versions',
      '--json',
      `--registry=${PUBLIC_REGISTRY}`,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return parseVersions(raw, packageName);
}

export function verifyPublicPluginScaffoldDependencies() {
  return assertPublishedPluginScaffoldDependencies(
    readPluginScaffoldDependencies(),
    livePublishedVersions,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const qualified = verifyPublicPluginScaffoldDependencies();
    for (const item of qualified) {
      console.log(
        `${item.packageName}@${item.range} resolves to ${item.resolved}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
