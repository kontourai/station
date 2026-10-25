// Refreshes the Sigstore trusted root that Station embeds for offline plugin
// signature verification (#2998). Station never runs a TUF client at runtime:
// the server loads the committed snapshot directly. This script is the one
// place that snapshot is produced.
//
// Source: `gh attestation trusted-root`, which fetches the trusted roots
// through sigstore-go's TUF client and verifies the TUF metadata against the
// root that ships inside gh. Its output is JSONL with one trusted root per
// Sigstore instance (today: the public-good instance and GitHub's own). Station
// trusts only the public-good instance, so exactly one line must match.
//
// Usage:
//   node scripts/sigstore-trusted-root-snapshot.mjs            # write snapshot
//   node scripts/sigstore-trusted-root-snapshot.mjs --check    # exit 1 on drift
//   node scripts/sigstore-trusted-root-snapshot.mjs --from <trusted_root.jsonl>
//
// The refreshed file is reviewed like any other trust-root change.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = join(
  ROOT,
  'src-server/services/plugins/sigstore-public-good-trusted-root.json',
);
const TRUSTED_ROOT_MEDIA_TYPE =
  'application/vnd.dev.sigstore.trustedroot+json;version=0.1';
const PUBLIC_GOOD_FULCIO = 'https://fulcio.sigstore.dev';
const PUBLIC_GOOD_REKOR = 'https://rekor.sigstore.dev';
const MAX_LINES = 16;

function isPublicGood(root) {
  return (
    root?.mediaType === TRUSTED_ROOT_MEDIA_TYPE &&
    Array.isArray(root.certificateAuthorities) &&
    root.certificateAuthorities.some((ca) => ca?.uri === PUBLIC_GOOD_FULCIO) &&
    Array.isArray(root.tlogs) &&
    root.tlogs.some((log) => log?.baseUrl === PUBLIC_GOOD_REKOR)
  );
}

/**
 * Selects the public-good trusted root from `gh attestation trusted-root`
 * output. Refuses unless exactly one line is the public-good instance, so a
 * changed output format cannot silently embed the wrong root.
 */
export function selectPublicGoodTrustedRoot(jsonl) {
  const lines = jsonl.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0 || lines.length > MAX_LINES)
    throw new Error(
      `expected 1..${MAX_LINES} trusted roots, got ${lines.length}`,
    );
  const matches = lines.map((line) => JSON.parse(line)).filter(isPublicGood);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one public-good trusted root, got ${matches.length}`,
    );
  return matches[0];
}

export function serializeSnapshot(root) {
  return `${JSON.stringify(root, null, 2)}\n`;
}

function fetchTrustedRoots() {
  return execFileSyncBounded('gh', ['attestation', 'trusted-root'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
}

function main(argv) {
  const fromIndex = argv.indexOf('--from');
  const jsonl =
    fromIndex >= 0
      ? readFileSync(argv[fromIndex + 1], 'utf8')
      : fetchTrustedRoots();
  const next = serializeSnapshot(selectPublicGoodTrustedRoot(jsonl));
  if (argv.includes('--check')) {
    const current = readFileSync(SNAPSHOT_PATH, 'utf8');
    if (current !== next) {
      console.error(
        'Embedded Sigstore trusted root differs from the TUF-verified root. Rerun without --check and review the change.',
      );
      return 1;
    }
    console.log('Embedded Sigstore trusted root is current.');
    return 0;
  }
  writeFileSync(SNAPSHOT_PATH, next);
  console.log(`Wrote ${SNAPSHOT_PATH}`);
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main(process.argv);
