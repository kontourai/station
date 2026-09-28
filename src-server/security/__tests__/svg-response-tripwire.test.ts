import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  applySvgResponseSecurityHeaders,
  SVG_RESPONSE_SECURITY_HEADERS,
} from '../svg-response-headers.js';

// Station's conventional app-origin route roots. This is a best-effort
// tripwire, not path-sensitive enforcement: it catches an ordinary literal
// SVG route added to these roots and forces a reviewer to it. It does not
// (and cannot cheaply) cover every possible app-origin responder — a MIME
// assembled from variables, a mime lookup table, or a route factory outside
// these roots can still evade it. Closing those needs data-flow analysis or
// centralized response mediation, disproportionate with no current exposure.
const APP_ORIGIN_ROUTE_ROOTS = [
  fileURLToPath(new URL('../../routes/', import.meta.url)),
  fileURLToPath(new URL('../../runtime/routes/', import.meta.url)),
  fileURLToPath(new URL('../../monitoring/', import.meta.url)),
];
const SVG_RESPONSE_MARKER = /image\/svg\+xml|\.svg(?:['"`/?]|$)/i;
const SVG_HARDENING_CALL = /applySvgResponseSecurityHeaders\s*\(/;

function routeSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : routeSourceFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function unguardedSvgRouteSources(roots: readonly string[]): string[] {
  return roots.flatMap((root) =>
    routeSourceFiles(root).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return SVG_RESPONSE_MARKER.test(source) &&
        !SVG_HARDENING_CALL.test(source)
        ? [path]
        : [];
    }),
  );
}

const makeTempDir = trackTempDirs();

describe('app-origin SVG response tripwire', () => {
  test('applies the exact hardening headers through the shared helper', () => {
    const header = vi.fn();

    applySvgResponseSecurityHeaders({ header });

    expect(header).toHaveBeenCalledTimes(2);
    expect(header).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(header).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(SVG_RESPONSE_SECURITY_HEADERS).toEqual({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  });

  test('flags an unguarded SVG route and passes a guarded one (positive control)', () => {
    // Without this, the scan below could stop matching anything and still
    // report an empty list.
    const root = makeTempDir('svg-tripwire-');
    const write = (relative: string, source: string) => {
      const path = join(root, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, source);
      return path;
    };
    const rawSvg = write(
      'avatars/raw-avatar.ts',
      "app.get('/avatar', (c) => { c.header('Content-Type', 'image/svg+xml'); return c.body(svg); });\n",
    );
    const svgFile = write(
      'static-logo.ts',
      "app.get('/logo', (c) => c.redirect('/static/logo.svg'));\n",
    );
    write(
      'guarded-avatar.ts',
      "app.get('/avatar', (c) => { applySvgResponseSecurityHeaders(c); c.header('Content-Type', 'image/svg+xml'); return c.body(svg); });\n",
    );
    write('plain.ts', "app.get('/ping', (c) => c.text('ok'));\n");
    write(
      '__tests__/fixture.ts',
      "c.header('Content-Type', 'image/svg+xml');\n",
    );

    expect(unguardedSvgRouteSources([root]).sort()).toEqual(
      [rawSvg, svgFile].sort(),
    );
  });

  test('requires app-origin route sources in the scanned roots to guard any SVG response', () => {
    expect(unguardedSvgRouteSources(APP_ORIGIN_ROUTE_ROOTS)).toEqual([]);
  });
});
