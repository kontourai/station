/**
 * `projectIconProblem` — the one rule for what a stored project icon may be.
 * The routes, the pickers and the renderer all call it, so these cases are
 * the boundary every one of them enforces.
 */

import { describe, expect, test } from 'vitest';
import {
  PROJECT_ICON_MAX_GLYPH_LENGTH,
  PROJECT_ICON_MAX_IMAGE_BYTES,
  projectIconProblem,
  projectIconSignatureMatches,
} from '../project.js';
import {
  PROJECT_MANIFEST_SCHEMA_VERSION,
  validateProjectManifest,
} from '../project-identity.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A data URL whose payload decodes to exactly `byteLength` bytes. */
function imageDataUrl(
  byteLength: number,
  mediaType = 'image/png',
  signature: number[] = PNG_SIGNATURE,
): string {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from(signature).copy(bytes);
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function manifestWithIcon(icon: string) {
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: 'prj_icon',
    slug: 'icon',
    name: 'Icon',
    icon,
    repos: [],
    knowledge: [],
    agents: [],
    integrations: [],
    layouts: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

// Pinned beside the constants they come from: a change to either bound must
// be a deliberate edit here too, not a silent widening.
test('the bounds are the ones discovery reads under', () => {
  expect(PROJECT_ICON_MAX_IMAGE_BYTES).toBe(131072);
  expect(PROJECT_ICON_MAX_GLYPH_LENGTH).toBe(16);
});

const ACCEPTED: Array<[string, string]> = [
  ['an emoji', '🚀'],
  ['a ZWJ emoji sequence', '👩‍💻'],
  ['a ZWJ family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
  ['a ZWJ flag with a variation selector', '\u{1F3F3}\uFE0F\u200D\u{1F308}'],
  ['a right-to-left letter', 'ש'],
  ['a symbol', '⌘'],
  ['letters', 'AB'],
  ['a PNG', imageDataUrl(64)],
  ['a JPEG', imageDataUrl(64, 'image/jpeg', [0xff, 0xd8, 0xff])],
  ['an ICO', imageDataUrl(64, 'image/x-icon', [0, 0, 1, 0])],
  [
    'a WebP',
    imageDataUrl(64, 'image/webp', [
      ...Buffer.from('RIFF'),
      0,
      0,
      0,
      0,
      ...Buffer.from('WEBP'),
    ]),
  ],
];

describe('accepted icons', () => {
  test.each(ACCEPTED)('%s is an icon', (_label, icon) => {
    expect(projectIconProblem(icon)).toBeUndefined();
  });

  test.each(ACCEPTED)(
    '%s also keeps the portable manifest readable',
    (_label, icon) => {
      expect(validateProjectManifest(manifestWithIcon(icon)).ok).toBe(true);
    },
  );
});

describe('refused values', () => {
  test.each([
    ['a local absolute path', '/Users/me/secrets/logo.png', 'glyph-shape'],
    ['a tilde path', '~/logo', 'glyph-shape'],
    ['a drive-letter path', 'C:\\logo', 'glyph-shape'],
    ['a UNC path', '\\\\host\\share', 'glyph-shape'],
    ['a relative image path', 'logo.png', 'glyph-shape'],
    ['a remote URL', 'https://example.com/a.png', 'glyph-shape'],
    ['a same-origin URL', '/provider-icons/goose.svg', 'glyph-shape'],
    ['a brand reference', 'brand:station', 'glyph-shape'],
    ['a control character', 'a\u0007', 'glyph-shape'],
    ['surrounding whitespace', ' 🚀', 'glyph-shape'],
    ['blank text', '   ', 'empty'],
    ['a left-to-right embedding', 'A\u202A', 'glyph-characters'],
    ['a right-to-left override', '\u202E🚀', 'glyph-characters'],
    ['a pop directional formatting', 'A\u202C', 'glyph-characters'],
    ['a left-to-right isolate', '\u2066A', 'glyph-characters'],
    ['a pop directional isolate', 'A\u2069', 'glyph-characters'],
    ['a left-to-right mark', 'A\u200E', 'glyph-characters'],
    ['a right-to-left mark', '\u200FA', 'glyph-characters'],
    ['an Arabic letter mark', 'A\u061C', 'glyph-characters'],
    ['a lone high surrogate', '\uD83D', 'glyph-characters'],
    ['a lone low surrogate', 'A\uDE80', 'glyph-characters'],
    ['only a zero-width space', '\u200B', 'glyph-characters'],
    ['only a zero-width joiner', '\u200D', 'glyph-characters'],
    ['only invisible joiners', '\u200B\u200D\u2060', 'glyph-characters'],
    ['only a variation selector', '\uFE0F', 'glyph-characters'],
    ['only a Hangul filler', '\u3164', 'glyph-characters'],
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zy8+', 'image-type'],
    ['a non-base64 data URL', 'data:image/png,abc', 'image-encoding'],
    [
      'an upper-case media type',
      imageDataUrl(64).replace('image/png', 'image/PNG'),
      'image-type',
    ],
    ['an empty payload', 'data:image/png;base64,', 'image-encoding'],
    ['a truncated payload', 'data:image/png;base64,iVBORw0', 'image-encoding'],
    [
      'a JPEG labelled PNG',
      imageDataUrl(64, 'image/png', [0xff, 0xd8, 0xff]),
      'image-signature',
    ],
  ])('%s is refused', (_label, icon, problem) => {
    expect(projectIconProblem(icon)).toBe(problem);
  });

  test('a non-string is refused', () => {
    expect(projectIconProblem(42)).toBe('not-a-string');
    expect(projectIconProblem(null)).toBe('not-a-string');
  });

  test('a glyph at the bound is accepted and one past it is refused', () => {
    expect(
      projectIconProblem('x'.repeat(PROJECT_ICON_MAX_GLYPH_LENGTH)),
    ).toBeUndefined();
    expect(
      projectIconProblem('x'.repeat(PROJECT_ICON_MAX_GLYPH_LENGTH + 1)),
    ).toBe('glyph-too-long');
  });

  test('an image at the byte bound is accepted and one byte past it is refused', () => {
    // Both padding shapes, so the decoded length is computed, not estimated.
    for (const byteLength of [
      PROJECT_ICON_MAX_IMAGE_BYTES,
      PROJECT_ICON_MAX_IMAGE_BYTES - 1,
    ]) {
      expect(projectIconProblem(imageDataUrl(byteLength))).toBeUndefined();
    }
    expect(
      projectIconProblem(imageDataUrl(PROJECT_ICON_MAX_IMAGE_BYTES + 1)),
    ).toBe('image-too-large');
  });
});

test('the signature check reads each format', () => {
  expect(projectIconSignatureMatches(PNG_SIGNATURE, 'image/png')).toBe(true);
  expect(projectIconSignatureMatches(PNG_SIGNATURE, 'image/jpeg')).toBe(false);
  expect(projectIconSignatureMatches([0, 0, 1], 'image/x-icon')).toBe(false);
  expect(projectIconSignatureMatches(PNG_SIGNATURE, 'image/gif')).toBe(false);
});
