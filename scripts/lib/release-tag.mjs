#!/usr/bin/env node
// The one parser for a tagged Stable release's tag (#4929). Every staging
// script that reads the tag asks here instead of carrying its own grammar.
//
// A tag is a final release `vX.Y.Z` or a release candidate `vX.Y.Z-rc.N`.
// Both build Stable bytes at the bare base version `X.Y.Z`; the tag is only
// where those bytes live (release assets, the draft, SBOM and attestation
// subjects). Retired `vX.Y.Z-preview.N` tags, and anything else, are refused.
//
// Kept free of package imports so scripts/package-portable-release.sh can run
// it from a bare checkout:
//
//   node scripts/lib/release-tag.mjs <tag>   (prints the parse as JSON)
import { invokedDirectly } from './module-entry.mjs';

const RELEASE_TAG =
  /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-rc\.([1-9][0-9]*))?$/;
/**
 * Store build slot 99 belongs to the final tag (native-release-config.mjs),
 * so a candidate is numbered 1-98.
 */
export const MAX_RELEASE_CANDIDATE = 98;

/**
 * `{ tag, baseVersion, kind: 'rc' | 'final', rc: N | null }` for a release
 * tag; throws for anything else.
 */
export function parseReleaseTag(tag) {
  const match = typeof tag === 'string' ? RELEASE_TAG.exec(tag) : null;
  if (!match)
    throw new Error(
      `${JSON.stringify(tag)} is not a vX.Y.Z or vX.Y.Z-rc.N release tag`,
    );
  const rc = match[2] === undefined ? null : Number(match[2]);
  if (rc !== null && rc > MAX_RELEASE_CANDIDATE)
    throw new Error(
      `${tag}: a release candidate is numbered 1-${MAX_RELEASE_CANDIDATE}, because store build slot 99 belongs to the final tag`,
    );
  return { tag, baseVersion: match[1], kind: rc === null ? 'final' : 'rc', rc };
}

/** True when `tag` is a release tag `parseReleaseTag` accepts. */
export function isReleaseTag(tag) {
  try {
    parseReleaseTag(tag);
    return true;
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('usage: release-tag.mjs <tag>');
    process.stdout.write(`${JSON.stringify(parseReleaseTag(args[0]))}\n`);
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
