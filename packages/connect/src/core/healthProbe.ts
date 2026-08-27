/**
 * Shared browser health-probe timeout (ms). Used by `probeServerConnection`
 * (src-ui) and applied as the AbortController deadline on the SDK's
 * `requestSystemStatus` fetch so the two paths cannot diverge.
 *
 * The value itself now lives in `@kontourai/station-contracts/http`: the SDK is
 * a published package and this one is not, so the SDK cannot import it from
 * here without shipping an unresolvable import to every external plugin
 * author. Re-exported so existing `@kontourai/station-connect` consumers keep
 * their import path.
 */
export { HEALTH_PROBE_TIMEOUT_MS } from '@kontourai/station-contracts/http';
