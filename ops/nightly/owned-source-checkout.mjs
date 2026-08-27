import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function runGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function checkedSha(value) {
  if (!/^[0-9a-f]{40}$/i.test(value))
    throw new Error(
      'Owned Nightly source checkout did not fetch a full main SHA.',
    );
  return value;
}

const OWNED_CHECKOUT_DIRNAME = 'build-checkout-v2';
const OWNERSHIP_FILENAME = `${OWNED_CHECKOUT_DIRNAME}.owner.json`;

function isWithin(root, path) {
  const value = relative(root, path);
  return (
    value === '' ||
    (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

function ownershipMarkerPath(ownedRoot) {
  return join(ownedRoot, OWNERSHIP_FILENAME);
}

function readOwnershipMarker(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value?.schemaVersion !== 1 ||
      typeof value.checkout !== 'string' ||
      typeof value.origin !== 'string'
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function assertOwnedCheckout({ source, ownedCheckout, ownedRoot, origin }) {
  const rootRequested = resolve(ownedRoot);
  const root = realpathSync(rootRequested);
  const expectedRequested = join(rootRequested, OWNED_CHECKOUT_DIRNAME);
  const expected = join(root, OWNED_CHECKOUT_DIRNAME);
  const ownedRequested = resolve(ownedCheckout);
  if (ownedRequested !== expectedRequested)
    throw new Error(
      `Owned Nightly checkout must be the cache root ${OWNED_CHECKOUT_DIRNAME}.`,
    );
  if (isWithin(source, root) || isWithin(root, source))
    throw new Error(
      'Owned Nightly checkout cache must not overlap the source checkout.',
    );

  const markerPath = ownershipMarkerPath(root);
  if (!existsSync(ownedRequested)) {
    if (existsSync(markerPath))
      throw new Error(
        'Owned Nightly checkout marker exists without its checkout.',
      );
    return { markerPath, owned: expected };
  }
  if (lstatSync(ownedRequested).isSymbolicLink())
    throw new Error('Owned Nightly checkout must not be a symbolic link.');
  const owned = realpathSync(ownedRequested);
  if (owned !== expected)
    throw new Error('Owned Nightly checkout escapes its canonical cache root.');
  if (!lstatSync(join(owned, '.git')).isDirectory())
    throw new Error(
      'Owned Nightly checkout must be a standalone Git checkout.',
    );
  const marker = readOwnershipMarker(markerPath);
  if (!marker || marker.checkout !== owned || marker.origin !== origin)
    throw new Error(
      'Owned Nightly checkout has no matching cache ownership marker.',
    );
  return { markerPath, owned };
}

function assertOwnedGitTopology(owned, run) {
  const topLevel = realpathSync(
    resolve(owned, run(['-C', owned, 'rev-parse', '--show-toplevel'])),
  );
  if (topLevel !== owned)
    throw new Error('Owned Nightly checkout Git worktree escapes the cache.');
  const commonDir = realpathSync(
    resolve(owned, run(['-C', owned, 'rev-parse', '--git-common-dir'])),
  );
  if (commonDir !== realpathSync(join(owned, '.git')))
    throw new Error(
      'Owned Nightly checkout Git common directory escapes the cache.',
    );
}

/**
 * Advances Station's machine-owned Nightly build checkout without modifying
 * the checkout that recorded install provenance. The caller must hold the
 * Nightly install lock before invoking this function.
 */
export function prepareOwnedNightlySourceCheckout({
  sourceCheckout,
  ownedCheckout,
  ownedRoot,
  run = runGit,
}) {
  const source = realpathSync(resolve(sourceCheckout));

  const origin = run(['-C', source, 'remote', 'get-url', 'origin']);
  if (!origin)
    throw new Error('Source checkout has no origin remote for Nightly update.');
  const { markerPath, owned } = assertOwnedCheckout({
    source,
    ownedCheckout,
    ownedRoot,
    origin,
  });

  if (existsSync(owned)) {
    assertOwnedGitTopology(owned, run);
    // The cache is Station-owned, but its remote is still reset explicitly so
    // an old or corrupted cache cannot select a different source repository.
    run(['-C', owned, 'remote', 'set-url', 'origin', '--', origin]);
  } else {
    run(['clone', '--no-checkout', '--no-tags', '--', origin, owned]);
    const cloned = realpathSync(owned);
    if (cloned !== owned || !lstatSync(join(cloned, '.git')).isDirectory())
      throw new Error(
        'Owned Nightly checkout clone did not create the expected cache.',
      );
    assertOwnedGitTopology(owned, run);
    writeFileSync(
      markerPath,
      `${JSON.stringify({ schemaVersion: 1, checkout: owned, origin })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  }

  run(['-C', owned, 'fetch', '--no-tags', 'origin', 'refs/heads/main']);
  const sourceSha = checkedSha(run(['-C', owned, 'rev-parse', 'FETCH_HEAD']));
  run(['-C', owned, 'checkout', '--detach', '--force', sourceSha]);
  const head = checkedSha(run(['-C', owned, 'rev-parse', 'HEAD']));
  if (head !== sourceSha)
    throw new Error(
      'Owned Nightly source checkout did not reach fetched main SHA.',
    );
  if (run(['-C', owned, 'status', '--porcelain', '--untracked-files=no']))
    throw new Error('Owned Nightly source checkout is dirty after refresh.');
  return sourceSha;
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [sourceCheckout, ownedCheckout, ownedRoot] = process.argv.slice(2);
  if (!sourceCheckout || !ownedCheckout || !ownedRoot) {
    console.error(
      'Usage: owned-source-checkout.mjs <source-checkout> <owned-checkout> <owned-root>',
    );
    process.exit(2);
  }
  console.log(
    prepareOwnedNightlySourceCheckout({
      sourceCheckout,
      ownedCheckout,
      ownedRoot,
    }),
  );
}
