import { describe, expect, it } from 'vitest';
import {
  UI_IMMUTABLE_ASSET_PATTERN,
  uiDocumentContentSecurityPolicy,
} from '../ui-document-policy';

describe('UI document policy', () => {
  it.each([
    'assets/main-Bjeujjya.js',
    'assets/index-PdibzA2x.css',
    'assets/shiki/typescript-0123456789abcdef.js',
    'assets/78-EUC-H-Uf9aYsyl.bcmap',
    'assets/openjpeg-tw7Aizcv.wasm',
    'assets/LiberationSans-Bold-BPt4bU5Z.ttf',
  ])('treats hashed build output %s as immutable', (asset) => {
    expect(UI_IMMUTABLE_ASSET_PATTERN.test(asset)).toBe(true);
  });

  it.each([
    'index.html',
    'sw.js',
    'startup-theme.js',
    'fonts/dm-sans-latin.woff2',
    'assets/main.js',
    '/assets/main-Bjeujjya.js',
    'assets/../main-Bjeujjya.js',
    'assets/main-Bjeujjya.js?v=1',
  ])('never treats %s as immutable', (asset) => {
    expect(UI_IMMUTABLE_ASSET_PATTERN.test(asset)).toBe(false);
  });

  it('binds scripts to the request nonce and otherwise keeps one policy offline', () => {
    const live = uiDocumentContentSecurityPolicy('abc123');
    const offline = uiDocumentContentSecurityPolicy();
    expect(live).toContain(
      "script-src 'self' 'nonce-abc123' 'wasm-unsafe-eval'",
    );
    expect(offline).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(offline).not.toContain('nonce-');
    for (const policy of [live, offline]) {
      const scripts = policy
        .split('; ')
        .find((directive) => directive.startsWith('script-src'));
      expect(scripts).not.toContain('unsafe-inline');
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("manifest-src 'self'");
    }
    expect(live.replace(" 'nonce-abc123'", '')).toBe(offline);
  });
});
