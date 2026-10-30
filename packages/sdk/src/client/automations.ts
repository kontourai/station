/**
 * Canonical React-free client for the Automation operator surface
 * (`AUTOMATION_OPERATOR_SURFACE`, epic kontourai/station#3439). Slice S2
 * ships the read-only delivery history only.
 */

import type { AutomationDeliveryPage } from '@kontourai/station-contracts/automation';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

interface AutomationEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

async function unwrapAutomationResponse<T>(response: Response): Promise<T> {
  const fallback = `Automations API error: ${response.status}`;
  let result: AutomationEnvelope<T> | null = null;
  try {
    result = (await response.json()) as AutomationEnvelope<T>;
  } catch (error) {
    rethrowDeadline(error);
    throw envelopeError(response, undefined, fallback);
  }
  if (response.status === 404 && result?.code !== 'feature_preview_disabled')
    throw envelopeError(
      response,
      undefined,
      'Automation delivery history is not supported on this Station. A compatible host is required.',
    );
  if (!response.ok || !result?.success) {
    throw envelopeError(response, result, fallback);
  }
  return result.data as T;
}

/**
 * `GET /automations/deliveries` — the newest recorded deliveries, newest
 * first. The server refuses a `limit` outside 1–200; omitted means 50.
 */
export async function listAutomationDeliveries(
  apiBase: string,
  query: Readonly<{ limit?: number }> = {},
  opts?: ClientRequestOptions,
): Promise<AutomationDeliveryPage> {
  const search =
    query.limit === undefined
      ? ''
      : `?limit=${encodeURIComponent(query.limit)}`;
  return unwrapAutomationResponse<AutomationDeliveryPage>(
    await getJson(`${apiBase}/automations/deliveries${search}`, opts),
  );
}
