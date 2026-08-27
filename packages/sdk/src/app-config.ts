import type { AppConfig } from '@kontourai/station-contracts/config';
import { apiErrorMessage } from './api-core';
import { authenticatedFetch } from './client/http';
export interface UpdateAppLogLevelResult {
  value: AppConfig['logLevel'];
  revision: string;
  operationId?: string;
}

async function readEnvelope<T extends { success?: boolean; error?: string }>(
  response: Response,
): Promise<T> {
  if (!response.ok) {
    let payload: T | undefined;
    try {
      payload = (await response.json()) as T;
    } catch {}
    if (payload?.error) throw new Error(payload.error);
    throw new Error(`Request failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as T;
  if (!payload.success) {
    throw new Error(apiErrorMessage(payload, 'Log Level request failed.'));
  }
  return payload;
}

/** Shared conditional-write client for UI and CLI log-level edits. */
export async function updateAppLogLevel(
  apiBase: string,
  value: AppConfig['logLevel'],
): Promise<UpdateAppLogLevelResult> {
  const currentResponse = await authenticatedFetch(
    `${apiBase}/config/app/log-level`,
  );
  const current = await readEnvelope<{
    success?: boolean;
    revision?: string;
    error?: string;
  }>(currentResponse);
  if (!current.revision) {
    throw new Error(
      apiErrorMessage(current, 'Could not read the current Log Level.'),
    );
  }
  const response = await authenticatedFetch(`${apiBase}/config/app/log-level`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': current.revision,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ value }),
  });
  const result = await readEnvelope<{
    success?: boolean;
    value?: AppConfig['logLevel'];
    revision?: string;
    operationId?: string;
    error?: string;
  }>(response);
  if (!result.value || !result.revision) {
    throw new Error(apiErrorMessage(result, 'Could not save Log Level.'));
  }
  return {
    value: result.value,
    revision: result.revision,
    ...(result.operationId ? { operationId: result.operationId } : {}),
  };
}
