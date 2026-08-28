/**
 * The `devicePresentation` projection served on `GET /api/system/status`
 * (archive#3843 §1).
 *
 * ONE DERIVATION. `deviceClass` reads the local-operator flag the auth
 * boundary already bound for this request — mint-time
 * `locality: 'home-possession'` and nothing else. It deliberately does not
 * look at the socket peer, the attested proxy stamp, the pairing source, or
 * the credential authority: a browser on the host machine and an SSH-forward
 * from a laptop are indistinguishable at the socket, and D6 settled that
 * question once already for the redacted log read
 * (`src-server/routes/system/diagnostics.ts`). Reading the same bound flag
 * here is what keeps "the logs are redacted" and "this device is paired"
 * from ever disagreeing.
 *
 * Absent (a request that somehow skipped the boundary) reads as `paired`,
 * which is the fail-closed direction for presentation: it names the host
 * rather than offering a host-hands command as if it were local.
 */

import { hostname } from 'node:os';
import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { isBoundRuntimeLocalOperator } from '../../security/runtime-request-security.js';

/**
 * What the host machine calls itself.
 *
 * Station has no configured display name of its own to offer here — the
 * branding provider's `getAppName()` is the PRODUCT name ('Station'), the
 * Computers list renders browser-local `SavedConnection.name` labels, and
 * `STATION_INSTANCE_ID` is a lifecycle instance id that is literally
 * `default` on an ordinary install. None of those identify a machine, and
 * the copy this feeds ("Run this on X") is only useful if X is the machine
 * the person has to walk to.
 *
 * `os.hostname()` is read FROM the host, not inferred from the request: the
 * Host header, the URL and reverse DNS are all caller- or network-controlled
 * and are never consulted. The first label is used because the trailing
 * `.local` / search-domain suffix is noise in a sentence.
 */
export function resolveHostName(): string {
  const name = hostname().trim().split('.')[0] ?? '';
  // A host that reports no name at all still has to be nameable in a
  // sentence; "the host" is the honest fallback, not a fabricated identity.
  return name === '' ? 'the host' : name;
}

export function resolveDevicePresentation(
  request: Request,
): DevicePresentation {
  return {
    deviceClass: isBoundRuntimeLocalOperator(request) ? 'host' : 'paired',
    hostName: resolveHostName(),
  };
}
