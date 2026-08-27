import type {
  ConnectionCandidate,
  ConnectionCandidateProvider,
  ConnectionCandidateSource,
} from './types';

export type ConnectionCandidateProviderStatus =
  | 'available'
  | 'empty'
  | 'failed';

export interface ConnectionCandidateProviderResult {
  providerId: string;
  status: ConnectionCandidateProviderStatus;
}

export interface ConnectionCandidateDiscoveryResult {
  candidates: ConnectionCandidate[];
  providers: ConnectionCandidateProviderResult[];
}

const providers = new Map<string, ConnectionCandidateProvider>();
const MAX_PROVIDERS = 16;
const MAX_CANDIDATES_PER_PROVIDER = 64;
const MAX_CANDIDATES = 256;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCE_RANK: Record<ConnectionCandidateSource, number> = {
  tailnet: 0,
  'lan-dns-sd': 1,
  'desktop-host': 2,
};

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function normalizeCandidate(
  providerId: string,
  input: Omit<ConnectionCandidate, 'id' | 'providerId'>,
): ConnectionCandidate | null {
  if (
    input.candidateVersion !== 1 ||
    !Number.isFinite(input.discoveredAt) ||
    SOURCE_RANK[input.source] === undefined
  ) {
    return null;
  }
  const name = input.name.trim();
  if (!name || name.length > 100 || hasControlCharacters(name)) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(input.url);
  } catch {
    return null;
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password
  ) {
    return null;
  }
  const url = endpoint.origin;
  return {
    candidateVersion: 1,
    id: `candidate:${input.source}:${encodeURIComponent(url)}`,
    name,
    url,
    source: input.source,
    providerId,
    discoveredAt: input.discoveredAt,
  };
}

function rankAndDeduplicate(
  candidates: readonly ConnectionCandidate[],
): ConnectionCandidate[] {
  const ranked = [...candidates].sort(
    (left, right) =>
      SOURCE_RANK[left.source] - SOURCE_RANK[right.source] ||
      right.discoveredAt - left.discoveredAt ||
      left.url.localeCompare(right.url),
  );
  const seen = new Set<string>();
  return ranked.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

export function registerConnectionCandidateProvider(
  provider: ConnectionCandidateProvider,
): () => void {
  if (!PROVIDER_ID.test(provider.id)) {
    throw new Error(
      'Connection candidate provider id must be a safe, bounded identifier',
    );
  }
  if (providers.has(provider.id)) {
    throw new Error(
      `Connection candidate provider already registered: ${provider.id}`,
    );
  }
  if (providers.size >= MAX_PROVIDERS) {
    throw new Error('Connection candidate provider capacity reached');
  }
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

export function connectionCandidateProviderCount(): number {
  return providers.size;
}

export async function discoverConnectionCandidates(
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ConnectionCandidateDiscoveryResult> {
  const activeProviders = [...providers.values()];
  if (activeProviders.length === 0) {
    return { candidates: [], providers: [] };
  }
  const timeoutMs = options.timeoutMs ?? 3_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Connection candidate discovery aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new Error('Connection candidate discovery aborted')),
      { once: true },
    );
  });
  try {
    const results = await Promise.all(
      activeProviders.map(async (provider) => {
        try {
          const discovered = await Promise.race([
            provider.discover({ signal }),
            aborted,
          ]);
          const candidates = discovered
            .slice(0, MAX_CANDIDATES_PER_PROVIDER)
            .flatMap((candidate) => {
              const normalized = normalizeCandidate(provider.id, candidate);
              return normalized ? [normalized] : [];
            });
          return {
            candidates,
            provider: {
              providerId: provider.id,
              status:
                candidates.length > 0
                  ? ('available' as const)
                  : ('empty' as const),
            },
          };
        } catch {
          return {
            candidates: [],
            provider: {
              providerId: provider.id,
              status: 'failed' as const,
            },
          };
        }
      }),
    );
    return {
      candidates: rankAndDeduplicate(
        results.flatMap((result) => result.candidates),
      ).slice(0, MAX_CANDIDATES),
      providers: results.map((result) => result.provider),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
