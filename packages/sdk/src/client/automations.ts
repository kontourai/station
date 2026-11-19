/**
 * Canonical React-free client for the Automation operator surface
 * (`AUTOMATION_OPERATOR_SURFACE`, epic kontourai/station#3439, S5 #4513).
 * One function per operation. Mutations are refused by the server unless a
 * person makes them in person; they take the `configurationFingerprint`
 * from `listAutomationRules`/`listAutomationSources` where the server
 * requires one.
 */

import type {
  AutomationDeliveryPage,
  AutomationDispatchRuleInput,
  AutomationEpisodeRecord,
  AutomationEpisodeRetry,
  AutomationPollSourceInput,
  AutomationRule,
  AutomationRuleList,
  AutomationSourceList,
  AutomationSourceProjection,
} from '@kontourai/station-contracts/automation';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
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
  // An older host answers a path it does not know with 404, so every 404 is
  // "not supported" except the two this surface answers on purpose.
  if (
    response.status === 404 &&
    result?.code !== 'feature_preview_disabled' &&
    result?.code !== 'automation_not_found'
  )
    throw envelopeError(
      response,
      undefined,
      'This Automation operation is not supported on this Station. A compatible host is required.',
    );
  if (!response.ok || !result?.success) {
    throw envelopeError(response, result, fallback);
  }
  return result.data as T;
}

const segment = (value: string) => encodeURIComponent(value);
const limitQuery = (limit: number | undefined) =>
  limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;

/**
 * `GET /automations/deliveries` — the newest recorded deliveries, newest
 * first. The server refuses a `limit` outside 1–200; omitted means 50.
 */
export async function listAutomationDeliveries(
  apiBase: string,
  query: Readonly<{ limit?: number }> = {},
  opts?: ClientRequestOptions,
): Promise<AutomationDeliveryPage> {
  return unwrapAutomationResponse<AutomationDeliveryPage>(
    await getJson(
      `${apiBase}/automations/deliveries${limitQuery(query.limit)}`,
      opts,
    ),
  );
}

/** `GET /automations/sources` — sources without webhook secrets. */
export async function listAutomationSources(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<AutomationSourceList> {
  return unwrapAutomationResponse<AutomationSourceList>(
    await getJson(`${apiBase}/automations/sources`, opts),
  );
}

/** `POST /automations/sources` — a disabled `github-poll` source. */
export async function createAutomationSource(
  apiBase: string,
  input: AutomationPollSourceInput,
  opts?: ClientRequestOptions,
): Promise<{ source: AutomationSourceProjection }> {
  return unwrapAutomationResponse<{ source: AutomationSourceProjection }>(
    await mutateJson(`${apiBase}/automations/sources`, 'POST', opts, input),
  );
}

/** `PUT /automations/sources/:target/enable` at an expected fingerprint. */
export async function enableAutomationSource(
  apiBase: string,
  target: string,
  expectedFingerprint: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/sources/${segment(target)}/enable`,
      'PUT',
      opts,
      { expectedFingerprint },
    ),
  );
}

/** `PUT /automations/sources/:target/disable`. */
export async function disableAutomationSource(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/sources/${segment(target)}/disable`,
      'PUT',
      opts,
      {},
    ),
  );
}

/** `DELETE /automations/sources/:target` — only a source no rule names. */
export async function deleteAutomationSource(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/sources/${segment(target)}`,
      'DELETE',
      opts,
    ),
  );
}

/** `GET /automations/rules` — every rule, with the configuration fingerprint. */
export async function listAutomationRules(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<AutomationRuleList> {
  return unwrapAutomationResponse<AutomationRuleList>(
    await getJson(`${apiBase}/automations/rules`, opts),
  );
}

/** `POST /automations/rules` — a `dispatch-task` rule, created in `observe`. */
export async function createAutomationRule(
  apiBase: string,
  input: AutomationDispatchRuleInput & Readonly<{ sourceId: string }>,
  opts?: ClientRequestOptions,
): Promise<AutomationRule> {
  return unwrapAutomationResponse<AutomationRule>(
    await mutateJson(`${apiBase}/automations/rules`, 'POST', opts, input),
  );
}

/** `PUT /automations/rules/:target` — replace a `dispatch-task` rule's fields. */
export async function updateAutomationRule(
  apiBase: string,
  target: string,
  input: AutomationDispatchRuleInput &
    Readonly<{ expectedFingerprint: string }>,
  opts?: ClientRequestOptions,
): Promise<AutomationRule> {
  return unwrapAutomationResponse<AutomationRule>(
    await mutateJson(
      `${apiBase}/automations/rules/${segment(target)}`,
      'PUT',
      opts,
      input,
    ),
  );
}

/** `PUT /automations/rules/:target/enable` — set `live` at an expected fingerprint. */
export async function enableAutomationRule(
  apiBase: string,
  target: string,
  expectedFingerprint: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/rules/${segment(target)}/enable`,
      'PUT',
      opts,
      { expectedFingerprint },
    ),
  );
}

/** `PUT /automations/rules/:target/disable` — set `off`. */
export async function disableAutomationRule(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/rules/${segment(target)}/disable`,
      'PUT',
      opts,
      {},
    ),
  );
}

/** `DELETE /automations/rules/:target` — a `dispatch-task` rule. */
export async function deleteAutomationRule(
  apiBase: string,
  target: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await unwrapAutomationResponse<unknown>(
    await mutateJson(
      `${apiBase}/automations/rules/${segment(target)}`,
      'DELETE',
      opts,
    ),
  );
}

/** `GET /automations/episodes` — unclosed episodes, newest first. */
export async function listAutomationEpisodes(
  apiBase: string,
  query: Readonly<{ limit?: number }> = {},
  opts?: ClientRequestOptions,
): Promise<{ episodes: AutomationEpisodeRecord[] }> {
  return unwrapAutomationResponse<{ episodes: AutomationEpisodeRecord[] }>(
    await getJson(
      `${apiBase}/automations/episodes${limitQuery(query.limit)}`,
      opts,
    ),
  );
}

/**
 * `POST /automations/episodes/:ruleId:episodeId/retry` — one more attempt
 * for an exhausted episode, under the rule's current policy.
 */
export async function retryAutomationEpisode(
  apiBase: string,
  episode: Readonly<{ ruleId: string; episodeId: string }>,
  opts?: ClientRequestOptions,
): Promise<AutomationEpisodeRetry> {
  return unwrapAutomationResponse<AutomationEpisodeRetry>(
    await mutateJson(
      `${apiBase}/automations/episodes/${segment(`${episode.ruleId}:${episode.episodeId}`)}/retry`,
      'POST',
      opts,
      {},
    ),
  );
}
