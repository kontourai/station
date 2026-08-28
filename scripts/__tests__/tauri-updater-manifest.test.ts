import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createUpdaterManifest,
  readUpdaterSignatureFile,
} from '../lib/tauri-updater-manifest.mjs';

const VALID = Object.freeze({
  version: '0.1.2-nightly.2430',
  pubDate: '2026-08-28T09:00:00Z',
  platform: 'darwin-aarch64',
  signature: 'base64-signature-bytes',
  releaseTag: 'nightly-desktop',
  url: 'https://github.com/kontourai/station/releases/download/nightly-desktop/station-nightly-desktop-macos-aarch64.app.tar.gz',
});

describe('the Tauri updater manifest (station#575)', () => {
  test('assembles one platform entry from valid input', () => {
    expect(createUpdaterManifest(VALID)).toEqual({
      version: VALID.version,
      notes: '',
      pub_date: VALID.pubDate,
      platforms: {
        'darwin-aarch64': {
          signature: VALID.signature,
          url: VALID.url,
        },
      },
    });
  });

  test('trims a signature read from a file with a trailing newline', () => {
    const manifest = createUpdaterManifest({
      ...VALID,
      signature: `${VALID.signature}\n`,
    });
    expect(manifest.platforms['darwin-aarch64'].signature).toBe(
      VALID.signature,
    );
  });

  test('carries an explicit notes string through unchanged', () => {
    const manifest = createUpdaterManifest({
      ...VALID,
      notes: 'Station Nightly desktop build',
    });
    expect(manifest.notes).toBe('Station Nightly desktop build');
  });

  test.each([
    ['version', { ...VALID, version: '' }, 'version must be non-empty'],
    [
      'pub_date',
      { ...VALID, pubDate: '2026-08-28' },
      'pub_date must be an ISO-8601 UTC timestamp',
    ],
    ['platform', { ...VALID, platform: '' }, 'platform must be non-empty'],
    [
      'signature',
      { ...VALID, signature: '   ' },
      'signature must be non-empty',
    ],
    [
      'url',
      { ...VALID, url: 'http://example.com/latest.json' },
      'url must be an https URL',
    ],
    [
      'releaseTag',
      { ...VALID, releaseTag: '' },
      'releaseTag must be non-empty',
    ],
  ])('fails closed on an invalid %s', (_field, input, message) => {
    expect(() => createUpdaterManifest(input)).toThrow(message);
  });

  test('refuses a url that names a DIFFERENT release than releaseTag (station#575 MED-2)', () => {
    // The asset name, --release-tag (notarization), and --url are three
    // independent literals in the workflow; nothing else stops one of them
    // drifting from the other two. A url whose download path names a
    // different tag must never assemble a "valid-looking" manifest.
    expect(() =>
      createUpdaterManifest({
        ...VALID,
        url: 'https://github.com/kontourai/station/releases/download/nightly-npm/station-nightly-desktop-macos-aarch64.app.tar.gz',
      }),
    ).toThrow(/url must be a release-asset download URL under releaseTag/);
    // A url for the right tag but missing the exact "/download/<tag>/"
    // shape (e.g. a tag name that is a prefix of another) must also fail.
    expect(() =>
      createUpdaterManifest({
        ...VALID,
        releaseTag: 'nightly-desktop',
        url: 'https://github.com/kontourai/station/releases/download/nightly-desktop-preview/station-nightly-desktop-macos-aarch64.app.tar.gz',
      }),
    ).toThrow(/url must be a release-asset download URL under releaseTag/);
  });

  test('never merges a previous platforms map: one call names exactly one platform', () => {
    const manifest = createUpdaterManifest(VALID);
    expect(Object.keys(manifest.platforms)).toEqual(['darwin-aarch64']);
  });

  test('readUpdaterSignatureFile converts a missing file into the teaching-message form, not a raw ENOENT (station#575 L4)', () => {
    expect(() =>
      readUpdaterSignatureFile('/nonexistent/station-signature.sig'),
    ).toThrow(/could not read --signature-file/);
    expect(() =>
      readUpdaterSignatureFile('/nonexistent/station-signature.sig'),
    ).toThrow(/notarize\/sign step must produce this file/);
  });

  test('the CLI writes the same manifest a direct call would produce', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-updater-manifest-'));
    const signatureFile = join(directory, 'signature.sig');
    const output = join(directory, 'latest.json');
    writeFileSync(signatureFile, `${VALID.signature}\n`);

    execFileSync(
      process.execPath,
      [
        'scripts/lib/tauri-updater-manifest.mjs',
        '--version',
        VALID.version,
        '--pub-date',
        VALID.pubDate,
        '--platform',
        VALID.platform,
        '--signature-file',
        signatureFile,
        '--url',
        VALID.url,
        '--release-tag',
        VALID.releaseTag,
        '--output',
        output,
      ],
      { cwd: join(import.meta.dirname, '../..') },
    );

    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(
      createUpdaterManifest(VALID),
    );
  });

  test('the CLI refuses a flag value that is itself another flag (station#575 L3)', () => {
    // `--signature-file --url ...` would otherwise silently swallow --url
    // as --signature-file's "value", shifting every argument after it by
    // one and producing a confusing failure far from the real cause.
    expect(() =>
      execFileSync(
        process.execPath,
        [
          'scripts/lib/tauri-updater-manifest.mjs',
          '--version',
          VALID.version,
          '--pub-date',
          VALID.pubDate,
          '--platform',
          VALID.platform,
          '--signature-file',
          '--url',
        ],
        { cwd: join(import.meta.dirname, '../..'), stdio: 'pipe' },
      ),
    ).toThrow();
  });
});
