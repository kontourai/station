import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  SNAPSHOT_PATH,
  selectPublicGoodTrustedRoot,
  serializeSnapshot,
} from '../sigstore-trusted-root-snapshot.mjs';

const committed = readFileSync(SNAPSHOT_PATH, 'utf8');
const publicGood = JSON.parse(committed);
// The shape `gh attestation trusted-root` emits for GitHub's own instance:
// its Fulcio and timestamp authority, and no transparency log.
const githubInstance = {
  mediaType: publicGood.mediaType,
  tlogs: [],
  certificateAuthorities: [{ uri: 'fulcio.githubapp.com' }],
  ctlogs: [],
  timestampAuthorities: [{ uri: 'timestamp.githubapp.com' }],
};
const jsonl = (...roots: unknown[]) =>
  roots.map((root) => JSON.stringify(root)).join('\n');

describe('sigstore trusted-root snapshot selection', () => {
  test('selects the public-good root from TUF output and reproduces the committed snapshot', () => {
    const selected = selectPublicGoodTrustedRoot(
      `${jsonl(publicGood, githubInstance)}\n`,
    );
    expect(serializeSnapshot(selected)).toBe(committed);
  });

  test('refuses output with no public-good root', () => {
    expect(() => selectPublicGoodTrustedRoot(jsonl(githubInstance))).toThrow(
      /exactly one public-good trusted root, got 0/,
    );
    expect(() => selectPublicGoodTrustedRoot('')).toThrow(/got 0/);
  });

  test('refuses output with two public-good roots rather than picking one', () => {
    expect(() =>
      selectPublicGoodTrustedRoot(jsonl(publicGood, publicGood)),
    ).toThrow(/got 2/);
  });

  test('refuses a public-good-looking root of another media type', () => {
    expect(() =>
      selectPublicGoodTrustedRoot(
        jsonl({ ...publicGood, mediaType: 'application/json' }),
      ),
    ).toThrow(/got 0/);
  });
});
