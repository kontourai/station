import {
  type ConnectionCandidate,
  ConnectionCandidateProviderError,
  registerConnectionCandidateProvider,
} from '@kontourai/station-connect';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { invokeTauri } from './tauriInvoke';

const RESULTS = new Set([
  'available',
  'empty',
  'permission-required',
  'permission-denied',
  'unavailable',
  'timed-out',
  'cancelled',
  'failed',
]);

function privateLanHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

/** Called only after the trusted profile establishes a native mobile target. */
export function registerNativeConnectionDiscovery(): () => void {
  const active = new Map<string, AbortController>();
  const unregister = registerConnectionCandidateProvider({
    id: 'native.lan-dns-sd',
    async discover({ signal }) {
      if (signal.aborted || document.visibilityState === 'hidden')
        throw new ConnectionCandidateProviderError('cancelled');
      // Android's permission Activity may hide the WebView. Admit permission
      // before owning a scan; permission completion never starts browsing.
      let admission: unknown;
      try {
        admission = await invokeTauri<unknown>(
          'plugin:station-discovery|prepare',
        );
      } catch {
        throw new ConnectionCandidateProviderError('unavailable');
      }
      if (signal.aborted)
        throw new ConnectionCandidateProviderError('cancelled');
      if (!admission || typeof admission !== 'object')
        throw new ConnectionCandidateProviderError('failed');
      const status = (admission as Record<string, unknown>).status;
      if (
        status === 'permission-required' ||
        status === 'permission-denied' ||
        status === 'unavailable'
      )
        throw new ConnectionCandidateProviderError(status);
      if (status !== 'ready')
        throw new ConnectionCandidateProviderError('failed');
      if (document.visibilityState === 'hidden')
        throw new ConnectionCandidateProviderError('cancelled');
      const scanId = randomCorrelationId();
      const controller = new AbortController();
      active.set(scanId, controller);
      const cancelNative = () => {
        controller.abort();
        void invokeTauri('plugin:station-discovery|cancel', { scanId }).catch(
          () => undefined,
        );
      };
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') cancelNative();
      };
      signal.addEventListener('abort', cancelNative, { once: true });
      document.addEventListener('visibilitychange', onVisibility);
      try {
        const response = await invokeTauri<unknown>(
          'plugin:station-discovery|discover',
          { scanId },
        );
        if (signal.aborted || controller.signal.aborted)
          throw new ConnectionCandidateProviderError('cancelled');
        if (!response || typeof response !== 'object')
          throw new ConnectionCandidateProviderError('failed');
        const record = response as Record<string, unknown>;
        if (
          typeof record.status !== 'string' ||
          !RESULTS.has(record.status) ||
          !Array.isArray(record.candidates) ||
          record.candidates.length > 32
        )
          throw new ConnectionCandidateProviderError('failed');
        switch (record.status) {
          case 'available':
          case 'empty':
            break;
          case 'permission-required':
          case 'permission-denied':
          case 'unavailable':
          case 'timed-out':
          case 'cancelled':
          case 'failed':
            throw new ConnectionCandidateProviderError(record.status);
          default:
            throw new ConnectionCandidateProviderError('failed');
        }
        const candidates: Omit<ConnectionCandidate, 'id' | 'providerId'>[] = [];
        for (const entry of record.candidates) {
          if (
            !entry ||
            typeof entry !== 'object' ||
            typeof entry.name !== 'string' ||
            typeof entry.host !== 'string' ||
            !privateLanHost(entry.host) ||
            !Number.isInteger(entry.port) ||
            entry.port < 1 ||
            entry.port > 65535 ||
            (entry.transport !== 'http' && entry.transport !== 'https')
          )
            continue;
          const host = entry.host.includes(':')
            ? `[${entry.host}]`
            : entry.host;
          try {
            const url = new URL(`${entry.transport}://${host}:${entry.port}`);
            candidates.push({
              candidateVersion: 1,
              name: entry.name,
              url: url.origin,
              source: 'lan-dns-sd',
              discoveredAt: Date.now(),
            });
          } catch {
            /* Invalid OS result cannot become routing intent. */
          }
        }
        return candidates;
      } catch (error) {
        if (error instanceof ConnectionCandidateProviderError) throw error;
        throw new ConnectionCandidateProviderError('unavailable');
      } finally {
        signal.removeEventListener('abort', cancelNative);
        document.removeEventListener('visibilitychange', onVisibility);
        active.delete(scanId);
      }
    },
  });
  return () => {
    unregister();
    for (const [scanId, controller] of active) {
      controller.abort();
      void invokeTauri('plugin:station-discovery|cancel', { scanId }).catch(
        () => undefined,
      );
    }
    active.clear();
  };
}
