import {
  CLIENT_ORIGIN_HEADER,
  type ClientReportedOrigin,
  serializeClientReportedOrigin,
} from '@kontourai/station-contracts/client-origin';

let resolver: (() => ClientReportedOrigin | undefined) | undefined;

/** Configure bounded, client-reported provenance without loading the SDK UI barrel. */
export function setClientOriginResolver(
  next?: () => ClientReportedOrigin | undefined,
): void {
  resolver = next;
}

/** Merge the optional header only at an authenticated same-Station request seam. */
export function withClientOriginHeaders(
  headers: RequestInit['headers'] | undefined,
  eligible = false,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  if (headers) {
    new Headers(headers).forEach((value, name) => {
      if (name.toLowerCase() !== CLIENT_ORIGIN_HEADER.toLowerCase())
        result[name] = value;
    });
  }
  if (eligible) {
    const value = serializeClientReportedOrigin(
      resolver?.() ?? { version: 1, surface: 'unknown', build: null },
    );
    if (value) result[CLIENT_ORIGIN_HEADER] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
