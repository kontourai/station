import { writeFileSync } from 'node:fs';

export function nightlySourceStamp({
  sha,
  createdAt,
  originUrl,
  sourceCheckout,
}) {
  const repository = originUrl
    .replace(/^ssh:\/\/git@([^/:]+)(?::\d+)?\//, 'https://$1/')
    .replace(/^git@([^:]+):/, 'https://$1/');
  return {
    schemaVersion: 1,
    channel: 'nightly',
    ref: 'origin/main',
    sha,
    createdAt,
    repository,
    ...(sourceCheckout ? { sourceCheckout } : {}),
  };
}

export function writeNightlySourceStamp(path, input) {
  writeFileSync(
    path,
    `${JSON.stringify(nightlySourceStamp(input), null, 2)}\n`,
    {
      mode: 0o644,
    },
  );
}
