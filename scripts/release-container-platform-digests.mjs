#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUIRED = ['linux/amd64', 'linux/arm64'];

export function platformDigests(manifest, manifestDigest) {
  if (!DIGEST.test(manifestDigest ?? ''))
    throw new Error('container manifest digest is invalid');
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !Array.isArray(manifest.manifests)
  )
    throw new Error('container manifest list is invalid');
  const found = new Map();
  for (const item of manifest.manifests) {
    const platform = `${item?.platform?.os}/${item?.platform?.architecture}`;
    if (!REQUIRED.includes(platform)) continue;
    if (!DIGEST.test(item?.digest ?? '') || found.has(platform))
      throw new Error('container platform manifest is ambiguous');
    found.set(platform, item.digest);
  }
  if (found.size !== REQUIRED.length)
    throw new Error('container manifest is missing a required platform');
  if (new Set(found.values()).size !== REQUIRED.length)
    throw new Error('container platform digests are not distinct');
  return Object.fromEntries(
    REQUIRED.map((platform) => [platform, found.get(platform)]),
  );
}

if (process.argv[1]?.endsWith('release-container-platform-digests.mjs')) {
  const [input, manifestDigest] = process.argv.slice(2);
  if (!input || !manifestDigest)
    throw new Error('usage: <manifest.json> <manifest digest>');
  const result = platformDigests(
    JSON.parse(readFileSync(input, 'utf8')),
    manifestDigest,
  );
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  const fs = await import('node:fs');
  fs.appendFileSync(
    output,
    `amd64=${result['linux/amd64']}\narm64=${result['linux/arm64']}\n`,
  );
}
