/**
 * Required response hardening when Station serves untrusted SVG from its own
 * origin. SVG is an active document format, not a passive image format.
 */
export const SVG_RESPONSE_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
} as const;

interface HeaderWriter {
  header(name: string, value: string): void;
}

/** Apply the mandatory hardening headers before returning an SVG response. */
export function applySvgResponseSecurityHeaders(response: HeaderWriter): void {
  for (const [name, value] of Object.entries(SVG_RESPONSE_SECURITY_HEADERS)) {
    response.header(name, value);
  }
}
