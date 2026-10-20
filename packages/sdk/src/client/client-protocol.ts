import { CLIENT_PROTOCOL_HEADER } from '@kontourai/station-contracts/environment-security';
import { clientProtocolHeaders } from '@kontourai/station-shared/client-protocol';

/**
 * Set the client API protocol this build speaks, at the one SDK request seam
 * (when it may be sent: see `clientProtocolHeaders`). A caller-supplied copy
 * is always dropped: the SDK is the only writer, so a request never claims a
 * protocol other than the one this code was built against.
 */
export function withClientProtocolHeader(
  headers: Record<string, string> | undefined,
  url: string,
  viaTransport: boolean,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== CLIENT_PROTOCOL_HEADER.toLowerCase())
      result[name] = value;
  }
  Object.assign(result, clientProtocolHeaders(url, viaTransport));
  return Object.keys(result).length ? result : undefined;
}
