import { parsePeerChatTargetRefusal } from '@kontourai/station-contracts/peer-chat';
import { envelopeReasons } from '@kontourai/station-sdk/client';
import type { StationConnection } from '../connections/station-connection';
import {
  type ChatErrorTranslation,
  translateChatError,
} from './chatErrorTranslation';
import { StationUiError } from './StationUiError';
import { isStationTransportFailure } from './stationTransportFailure';

const TERMINAL_RECOVERY_COPY = new Map([
  [
    'raw-egress-unavailable',
    'Terminals need a direct Station connection. Select a direct connection and try again.',
  ],
  ['credential-unavailable', 'Reconnect to this Station to use this terminal.'],
  [
    'unsupported-host',
    'This host does not support terminal sessions. Update the host to use this feature.',
  ],
  ['refused', 'Terminal access was refused.'],
]);

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
  const message = value?.message ?? (typeof error === 'string' ? error : '');
  const localCopy = [
    'Attachments must complete supervised staging before Send.',
    'Choose the file again before sending this attachment.',
    'This Station cannot be forgotten here.',
    "This app's own Station cannot be forgotten.",
    'Learning review is unsupported on this host. Enable its Feature Preview or update this Station.',
    'Another sign-in is starting. Try again shortly.',
  ].find((copy) => copy === message);
  const startingEngine =
    value?.name === 'EngineStillStartingError' &&
    'engineName' in value &&
    typeof value.engineName === 'string'
      ? value.engineName
      : undefined;
  const applicationCopy =
    value instanceof StationUiError
      ? value.userMessage
      : startingEngine
        ? `${startingEngine} is still starting for the first time. If it connects while Station is running, its Agent is added then; otherwise add it again later.`
        : value?.name === 'TerminalHistoryUnsupportedError'
          ? 'This Station does not report terminal history.'
          : localCopy;
  // TerminalSessionError carries terminal transport codes, not model errors.
  // Use fixed recovery copy; even a typed error's message may be diagnostic.
  const terminalCopy =
    value?.name === 'TerminalSessionError' && code
      ? TERMINAL_RECOVERY_COPY.get(code)
      : undefined;
  const domain = terminalCopy
    ? { title: 'Terminal unavailable', body: terminalCopy, retryable: false }
    : code
      ? translateChatError({ code, message })
      : undefined;
  if (code === 'approval_delivery_unconfirmed')
    return {
      title: 'Decision not confirmed',
      body: 'Check this request before trying again.',
      retryable: false,
      authority,
      delivery: 'uncertain',
      recovery: 'check',
    };
  if (
    (remoteStatus === 401 || remoteStatus === 403) &&
    !applicationCopy &&
    (!domain || domain.title === 'Error')
  ) {
    const body =
      remoteStatus === 401
        ? `Reconnect to ${target || connection?.routeKind !== 'relay' ? station : 'the source Station'}.`
        : `${target || connection?.routeKind !== 'relay' ? station : 'The source Station'} didn't accept this message.`;
    return {
      title: refused ? 'Not sent' : 'Access unavailable',
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
  const translated =
    domain ??
    translateChatError({
      // Only legacy chat responses use prose-based provider classification.
      // A settings/read diagnostic mentioning credentials is not model evidence.
      message: value && 'stationEnvelope' in value ? message : '',
    });
  const reasons = envelopeReasons(details);
  const safe = applicationCopy
    ? { title: 'Request not ready', body: applicationCopy, retryable: false }
    : connection?.routeKind !== 'relay' && status === 400 && reasons.length > 0
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

/**
 * Why a saved engine has not connected, from its last probe. A failure the
 * probe could name (`code`) is said in Station's words; any other probe text
 * is not shown, and the reason reads as the request-failure fallback.
 */
export function describeEngineProbeFailure(
  lastError: { message: string; phase: string; code?: string },
  engineName: string,
): string {
  if (lastError.code === 'managed-runtime-not-installed')
    return `${engineName} isn't installed yet. Install it from its sign-in panel.`;
  return describeStationFailure(lastError).body;
}
