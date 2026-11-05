import { parsePeerChatTargetRefusal } from '@kontourai/station-contracts/peer-chat';
import { envelopeReasons } from '@kontourai/station-sdk/client';
import type { StationConnection } from '../connections/station-connection';
import {
  type ChatErrorTranslation,
  translateChatError,
} from './chatErrorTranslation';
import { isStationTransportFailure } from './stationTransportFailure';

export interface StationFailure extends ChatErrorTranslation {
  authority: 'source' | 'target' | 'unknown';
  delivery: 'refused' | 'uncertain';
  recovery: 'reconnect' | 'check' | 'retry';
}

/** Error text and codes are diagnostics; only verified outcomes prove refusal. */
export function describeStationFailure(
  error: unknown,
  connection?: Pick<
    StationConnection,
    'stationName' | 'environmentId' | 'routeKind' | 'isCurrent'
  >,
  mutationKey?: string,
): StationFailure {
  const value = error instanceof Error ? error : undefined;
  const status =
    value && 'status' in value && typeof value.status === 'number'
      ? value.status
      : undefined;
  const code =
    value && 'code' in value && typeof value.code === 'string'
      ? value.code
      : undefined;
  const details = value && 'details' in value ? value.details : undefined;
  const verified =
    value &&
    'stationEnvelope' in value &&
    value.stationEnvelope === true &&
    (!connection || connection.isCurrent());
  const target =
    connection?.routeKind === 'relay' && verified && status === 424
      ? parsePeerChatTargetRefusal(
          { success: false, code, details },
          { environmentId: connection.environmentId, mutationKey },
        )
      : null;
  const remoteStatus = target?.remoteStatus ?? status;
  const refused = Boolean(
    verified &&
      (target ||
        (status !== undefined &&
          status >= 400 &&
          status < 500 &&
          (connection?.routeKind !== 'relay' ||
            status === 401 ||
            status === 403))),
  );
  const authority = target
    ? 'target'
    : connection?.routeKind === 'relay'
      ? 'source'
      : connection
        ? 'target'
        : 'unknown';
  const station = connection?.stationName ?? 'Station';
  if (remoteStatus === 401 || remoteStatus === 403) {
    const body =
      remoteStatus === 401
        ? `Reconnect to ${target || connection?.routeKind !== 'relay' ? station : 'the source Station'}.`
        : `This connection cannot send to ${target || connection?.routeKind !== 'relay' ? station : 'the source Station'}.`;
    return {
      title: 'Not sent',
      body,
      disclosureRaw: true,
      retryable: false,
      authority,
      delivery:
        verified &&
        (connection?.routeKind !== 'relay' ||
          target ||
          status === 401 ||
          status === 403)
          ? 'refused'
          : 'uncertain',
      recovery: 'reconnect',
    };
  }
  if (
    value instanceof SyntaxError ||
    (value instanceof DOMException && value.name === 'SyntaxError')
  )
    return {
      title: 'Response unavailable',
      body: 'Station sent a response this app could not read.',
      authority,
      delivery: 'uncertain',
      recovery: 'check',
    };
  if (value && isStationTransportFailure(value))
    return {
      title: 'Connection unavailable',
      body: 'Could not reach Station. Check the connection, then try again.',
      authority,
      delivery: 'uncertain',
      recovery: 'check',
    };
  const translated = translateChatError({
    status: remoteStatus,
    code,
    message: value?.message ?? '',
  });
  const reasons = envelopeReasons(details);
  const safe =
    status === 400 && reasons.length > 0
      ? { title: 'Not sent', body: reasons.join(' '), retryable: false }
      : translated.title === 'Error'
        ? {
            title: 'Request failed',
            body: 'Try again in a moment.',
            disclosureRaw: true,
          }
        : translated;
  return {
    ...safe,
    authority,
    delivery: refused ? 'refused' : 'uncertain',
    recovery: refused ? 'retry' : 'check',
  };
}
