import type {
  ChatStationBindingV1,
  StationConnection,
} from './station-connection';

export type StationStateScope = Pick<
  StationConnection,
  'binding' | 'runtimeKey' | 'isCurrent' | 'targetApiBase' | 'requestScope'
> & { readonly authorityNamespace?: string };

export function outboundStationIdentity(station: StationStateScope) {
  return {
    binding: station.binding,
    apiBase: station.targetApiBase,
    environmentId: station.binding.environmentId,
    authorityNamespace: station.authorityNamespace,
    host: station.binding.affinity.kind === 'host',
  };
}

type ChatOwner = {
  stationBinding?: ChatStationBindingV1;
  stationBindingInvalid?: boolean;
  peerChat?: unknown;
  peerChatInvalid?: boolean;
};

/** Persist identity and principal affinity, never a resolved endpoint or credential. */
export function readChatStationBinding(
  value: unknown,
): ChatStationBindingV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.environmentId !== 'string' ||
    !v.environmentId ||
    typeof v.stationName !== 'string'
  )
    return;
  if (
    !v.affinity ||
    typeof v.affinity !== 'object' ||
    Array.isArray(v.affinity)
  )
    return;
  const a = v.affinity as Record<string, unknown>;
  const text = (key: string) => typeof a[key] === 'string' && Boolean(a[key]);
  if (a.kind === 'host')
    return {
      version: 1,
      environmentId: v.environmentId,
      stationName: v.stationName,
      affinity: { kind: 'host' },
    };
  if (a.kind === 'device' && text('connectionId') && text('principalNamespace'))
    return {
      version: 1,
      environmentId: v.environmentId,
      stationName: v.stationName,
      affinity: {
        kind: 'device',
        connectionId: a.connectionId as string,
        principalNamespace: a.principalNamespace as string,
      },
    };
  if (
    a.kind === 'peer' &&
    text('sourceEnvironmentId') &&
    text('sourceConnectionId') &&
    text('principalNamespace')
  )
    return {
      version: 1,
      environmentId: v.environmentId,
      stationName: v.stationName,
      affinity: {
        kind: 'peer',
        sourceEnvironmentId: a.sourceEnvironmentId as string,
        sourceConnectionId: a.sourceConnectionId as string,
        principalNamespace: a.principalNamespace as string,
      },
    };
}

export function stationStateKey(binding?: ChatStationBindingV1): string {
  const affinity = binding?.affinity;
  if (!binding || affinity?.kind === 'host') return 'host';
  return affinity?.kind === 'device'
    ? JSON.stringify([
        binding.environmentId,
        'device',
        affinity.connectionId,
        affinity.principalNamespace,
      ])
    : affinity?.kind === 'peer'
      ? JSON.stringify([
          binding.environmentId,
          'peer',
          affinity.sourceEnvironmentId,
          affinity.sourceConnectionId,
          affinity.principalNamespace,
        ])
      : 'invalid';
}

export function chatBelongsToStation(
  chat: ChatOwner,
  station?: StationStateScope,
): boolean {
  if (station && !station.isCurrent()) return false;
  if (chat.stationBindingInvalid) return false;
  const binding = readChatStationBinding(chat.stationBinding);
  if (chat.stationBinding !== undefined && !binding) return false;
  // Even malformed legacy peer markers must never acquire host authority.
  if (!binding)
    return (
      chat.peerChat === undefined &&
      !chat.peerChatInvalid &&
      (!station || station.binding.affinity.kind === 'host')
    );
  if (station && binding.environmentId !== station.binding.environmentId)
    return false;
  return stationStateKey(binding) === stationStateKey(station?.binding);
}
