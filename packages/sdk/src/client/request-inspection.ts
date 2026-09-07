import type {
  AttentionRequestInspection,
  AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import { normalizeRequestAnswerability } from '@kontourai/station-contracts/orchestration';
import { type ClientRequestOptions, getJson } from './http';

export type { AttentionRequestInspection, AttentionRequestReference };

/** A response cannot silently retarget an already captured request. */
export function parseAttentionRequestInspection(
  value: unknown,
  reference: AttentionRequestReference,
): AttentionRequestInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Request inspection unavailable');
  const data = value as Record<string, unknown>;
  const target = data.reference as Record<string, unknown> | undefined;
  if (
    !target ||
    target.threadId !== reference.threadId ||
    target.requestId !== reference.requestId ||
    target.requestEventId !== reference.requestEventId
  )
    throw new Error('Request inspection did not match the selected request');
  if (data.state === 'open') {
    if (
      (data.requestType !== 'approval' && data.requestType !== 'permission') ||
      typeof data.provider !== 'string' ||
      data.provider.length > 1_024 ||
      typeof data.title !== 'string' ||
      data.title.length > 1_024 ||
      (data.body !== undefined &&
        (typeof data.body !== 'string' || data.body.length > 2_048)) ||
      typeof data.openedAt !== 'string' ||
      data.openedAt.length > 128 ||
      !Number.isFinite(Date.parse(data.openedAt)) ||
      typeof data.canRespond !== 'boolean'
    )
      throw new Error('Request inspection unavailable');
    if (
      !data.answerability ||
      typeof data.answerability !== 'object' ||
      typeof (data.answerability as { answerable?: unknown }).answerable !==
        'boolean'
    )
      throw new Error('Request inspection is missing answerability');
    const answerability = normalizeRequestAnswerability(data.answerability);
    if (
      (data.answerability as { answerable: boolean }).answerable !==
        answerability.answerable ||
      (!answerability.answerable &&
        (answerability.observedBy.length > 1_024 ||
          answerability.observedAt.length > 128 ||
          !Number.isFinite(Date.parse(answerability.observedAt))))
    )
      throw new Error('Request inspection has incomplete answerability');
    if (data.canRespond && !answerability.answerable)
      throw new Error('Request inspection has inconsistent answerability');
    return {
      state: 'open',
      reference: { ...reference },
      requestType: data.requestType,
      provider: data.provider,
      title: data.title,
      ...(data.body ? { body: data.body as string } : {}),
      openedAt: data.openedAt,
      answerability,
      canRespond: data.canRespond,
    };
  }
  if (
    !['changed', 'resolved', 'unavailable'].includes(String(data.state)) ||
    typeof data.message !== 'string' ||
    data.message.length > 2_048
  )
    throw new Error('Request inspection unavailable');
  return {
    state: data.state as 'changed' | 'resolved' | 'unavailable',
    reference: { ...reference },
    message: data.message,
  };
}

export async function inspectAttentionRequest(
  apiBase: string,
  reference: AttentionRequestReference,
  options?: ClientRequestOptions,
): Promise<AttentionRequestInspection> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(reference.threadId)}/requests/${encodeURIComponent(reference.requestId)}?eventId=${encodeURIComponent(reference.requestEventId)}`,
    options,
  );
  const body = (await response.json()) as { success?: boolean; data?: unknown };
  if (!body.success) throw new Error('Request inspection unavailable');
  return parseAttentionRequestInspection(body.data, reference);
}
