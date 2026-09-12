import {
  type OrchestrationQuoteSource,
  QUOTE_SOURCE_MAX_BYTES,
} from '@kontourai/station-contracts/orchestration';
import { type ClientRequestOptions, getJson, StationHttpError } from './http';

/** Reads one currently authorized completed answer without loading its Session history. */
export async function getAssistantQuoteSource(
  apiBase: string,
  sessionId: string,
  turnId: string,
  opts?: ClientRequestOptions,
): Promise<OrchestrationQuoteSource> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/quote-source`,
    opts,
  );
  if (!response.ok)
    throw new StationHttpError(response.status, 'Quote source unavailable');
  const body = (await response.json()) as {
    success?: boolean;
    data?: Partial<OrchestrationQuoteSource>;
  };
  const data = body?.success === true ? body.data : undefined;
  if (
    data?.version !== 1 ||
    data.sessionId !== sessionId ||
    data.turnId !== turnId ||
    typeof data.messageId !== 'string' ||
    data.messageId.length === 0 ||
    data.messageId.length > 1024 ||
    typeof data.text !== 'string' ||
    new TextEncoder().encode(data.text).byteLength > QUOTE_SOURCE_MAX_BYTES ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision)
  ) {
    throw new Error('Quote source returned an invalid exact-answer binding');
  }
  return data as OrchestrationQuoteSource;
}
