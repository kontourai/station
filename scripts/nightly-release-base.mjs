import { readFileSync, statSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { parseReleaseTag } from './lib/release-tag.mjs';
import { assertProductVersion } from './product-version.mjs';

export function compareProductVersions(left, right) {
  const a = assertProductVersion(left).split('.').map(BigInt);
  const b = assertProductVersion(right).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** Public RC/final releases freeze a product base; Nightly must use a later one. */
export function assertNightlyReleaseBase(version, history) {
  assertProductVersion(version);
  if (!Array.isArray(history))
    throw new Error('Release history must be an array');
  let latest = null;
  for (const release of history.flat()) {
    if (
      !release ||
      typeof release !== 'object' ||
      typeof release.tag_name !== 'string'
    )
      throw new Error('Release history contains a malformed record');
    if (!/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(release.tag_name)) continue;
    if (
      typeof release.draft !== 'boolean' ||
      typeof release.prerelease !== 'boolean'
    )
      throw new Error('Release history omits publication state');
    if (release.draft) continue;
    const identity = parseReleaseTag(release.tag_name);
    if (
      latest === null ||
      compareProductVersions(identity.baseVersion, latest.baseVersion) > 0
    )
      latest = identity;
  }
  if (latest && compareProductVersions(version, latest.baseVersion) <= 0)
    throw new Error(
      `Nightly product base ${version} must be greater than published ${latest.tag}; run the release-cut base bump through normal delivery`,
    );
  return {
    version,
    latestPublishedTag: latest?.tag ?? null,
    state: latest ? 'ahead' : 'bootstrap',
  };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const value = (name) => {
      const index = args.indexOf(name);
      if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
        throw new Error(`Missing ${name}`);
      return args[index + 1];
    };
    const historyPath = value('--release-history');
    if (statSync(historyPath).size > 1_048_576)
      throw new Error('Release history exceeds its size bound');
    const version = JSON.parse(
      readFileSync(value('--package-json'), 'utf8'),
    ).version;
    if (
      args.includes('--expected-base') &&
      value('--expected-base') !== version
    )
      throw new Error(
        'Nightly caller product base differs from the frozen source',
      );
    const result = assertNightlyReleaseBase(
      version,
      JSON.parse(readFileSync(historyPath, 'utf8')),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
