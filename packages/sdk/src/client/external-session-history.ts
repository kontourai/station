import type {
  ExternalSessionHistoryImport,
  ExternalSessionHistoryPage,
  ExternalSessionTranscriptPage,
} from '@kontourai/station-contracts/orchestration';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

const path = '/api/orchestration/external-history';

async function resultData<T>(response: Response): Promise<T> {
  const result = (await readJsonBody(response)) as
    | {
        success?: boolean;
        data?: T;
        error?: string;
      }
    | undefined;
  if (!response.ok || !result?.success || result.data === undefined) {
    throw envelopeError(response, result, 'Third-party history is unavailable');
  }
  return result.data;
}

export async function fetchExternalSessionHistory(
  apiBase: string,
  offset: number,
  search: string,
  provider: string | undefined,
  opts: ClientRequestOptions,
): Promise<ExternalSessionHistoryPage> {
  const query = new URLSearchParams({ offset: String(offset), search });
  if (provider) query.set('provider', provider);
  return resultData(await getJson(`${apiBase}${path}?${query}`, opts));
}

export async function fetchExternalSessionTranscript(
  apiBase: string,
  id: string,
  cursor: string | null,
  fromStart: boolean,
  opts: ClientRequestOptions,
): Promise<ExternalSessionTranscriptPage> {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (fromStart) query.set('from', 'start');
  return resultData(
    await getJson(
      `${apiBase}${path}/${encodeURIComponent(id)}/transcript?${query}`,
      { ...opts, maxResponseBytes: 4 * 1024 * 1024 },
    ),
  );
}

export async function importExternalSessionHistory(
  apiBase: string,
  id: string,
  operationId: string,
  opts: ClientRequestOptions,
): Promise<ExternalSessionHistoryImport> {
  return resultData(
    await mutateJson(
      `${apiBase}${path}/${encodeURIComponent(id)}/import?operationId=${encodeURIComponent(operationId)}`,
      'POST',
      opts,
    ),
  );
}

export async function cancelExternalSessionHistoryImport(
  apiBase: string,
  id: string,
  operationId: string,
  opts: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}${path}/${encodeURIComponent(id)}/import/${encodeURIComponent(operationId)}`,
    'DELETE',
    opts,
  );
  if (!response.ok) await resultData(response);
}
