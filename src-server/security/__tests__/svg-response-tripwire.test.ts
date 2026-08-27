import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
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

  test('requires app-origin route sources in the scanned roots to guard any SVG response', () => {
    const unguardedSvgRoutes = APP_ORIGIN_ROUTE_ROOTS.flatMap((root) =>
      routeSourceFiles(root).flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return SVG_RESPONSE_MARKER.test(source) &&
          !SVG_HARDENING_CALL.test(source)
          ? [path]
          : [];
      }),
    );

    expect(unguardedSvgRoutes).toEqual([]);
  });
});
