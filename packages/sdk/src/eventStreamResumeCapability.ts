import { hasCapability } from './capability.js';
import {
  fetchPublicStationCapabilities,
  resetPublicStationCapabilities,
} from './publicStationCapabilities.js';

/** Failed discovery remains fail-closed and can recover on the shared retry TTL. */
export function fetchEventStreamResumeCapability(
  apiBase: string,
): Promise<boolean> {
  return fetchPublicStationCapabilities(apiBase).then((handshake) =>
    hasCapability(handshake, 'eventStreamResume'),
  );
}

/** Test isolation for a new document lifetime. */
export function resetEventStreamResumeCapabilityCache(): void {
  resetPublicStationCapabilities();
}
