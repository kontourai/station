import { createDirectHttpAccessMethod } from './accessMethods';
import { isLoopbackUrl } from './connectionProfile';
import type {
  AccessEndpoint,
  EnvironmentAccessMethod,
  SavedConnection,
} from './types';

interface SuccessInput {
  url: string;
  at: number;
  bootId?: string;
  accessMethodId?: string;
  endpointFor: (url: string) => AccessEndpoint;
}

function successEvidence(
  item: SavedConnection,
  input: SuccessInput,
  endpointId?: string,
): Partial<SavedConnection> {
  const restarted =
    Boolean(input.bootId) &&
    Boolean(item.lastBootId) &&
    input.bootId !== item.lastBootId;
  return {
    lastConnected: input.at,
    lastSuccessAt: input.at,
    ...(input.bootId ? { lastBootId: input.bootId } : {}),
    lastError: undefined,
    ...(restarted
      ? {
          lastTransition: {
            reason: 'server-restarted',
            ...(endpointId ? { endpointId } : {}),
            at: input.at,
          },
        }
      : {}),
  };
}

function recordHostSuccess(
  item: SavedConnection,
  method: Extract<EnvironmentAccessMethod, { kind: 'host-tunnel' }>,
  input: SuccessInput,
): SavedConnection {
  if (!isLoopbackUrl(input.url)) {
    throw new Error('Host tunnel success must use a loopback endpoint');
  }
  return {
    ...item,
    selectedAccessMethodId: method.id,
    ...successEvidence(item, input),
  };
}

function recordDirectSuccess(
  item: SavedConnection,
  input: SuccessInput,
): SavedConnection {
  const endpoint =
    item.endpoints.find((candidate) => candidate.url === input.url) ??
    input.endpointFor(input.url);
  const verified = { ...endpoint, verifiedAt: input.at };
  const accessMethod = createDirectHttpAccessMethod(verified);
  return {
    ...item,
    url: verified.url,
    endpoints: [
      ...item.endpoints.filter((candidate) => candidate.id !== verified.id),
      verified,
    ],
    selectedEndpointId: verified.id,
    accessMethods: [
      ...item.accessMethods.filter(
        (method) =>
          method.kind === 'host-tunnel' ||
          (method.kind === 'direct-http' && method.endpointId !== verified.id),
      ),
      accessMethod,
    ],
    selectedAccessMethodId: accessMethod.id,
    ...successEvidence(item, input, verified.id),
  };
}

export function recordConnectionSuccess(
  item: SavedConnection,
  input: SuccessInput,
): SavedConnection {
  const selectedAccess = item.accessMethods.find(
    (method) =>
      method.id === (input.accessMethodId ?? item.selectedAccessMethodId),
  );
  if (input.accessMethodId && !selectedAccess) {
    throw new Error('Access method does not belong to this environment');
  }
  return selectedAccess?.kind === 'host-tunnel'
    ? recordHostSuccess(item, selectedAccess, input)
    : recordDirectSuccess(item, input);
}
