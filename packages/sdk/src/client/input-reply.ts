import type {
  AttentionInputReplyContext,
  AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import { type ClientRequestOptions, getJson, StationHttpError } from './http';

export async function getInputReplyContext(
  apiBase: string,
  reference: AttentionRequestReference,
  opts?: ClientRequestOptions,
): Promise<AttentionInputReplyContext> {
  const response = await getJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(reference.threadId)}/input-requests/${encodeURIComponent(reference.requestId)}?eventId=${encodeURIComponent(reference.requestEventId)}`,
    opts,
  );
  if (!response.ok)
    throw new StationHttpError(response.status, 'Input request unavailable');
  const body = (await response.json()) as {
    success?: boolean;
    data?:
      | Partial<Extract<AttentionInputReplyContext, { state: 'open' }>>
      | { state: 'unavailable'; reference: AttentionRequestReference };
  };
  const data = body.success ? body.data : undefined;
  const exact =
    data?.reference?.threadId === reference.threadId &&
    data.reference.requestId === reference.requestId &&
    data.reference.requestEventId === reference.requestEventId;
  if (!exact)
    throw new Error('Input reply context has no exact request binding');
  if (data?.state === 'unavailable') return { state: 'unavailable', reference };
  if (
    data?.state !== 'open' ||
    ![data.agentId, data.conversationId, data.provider, data.engineId].every(
      (value) =>
        typeof value === 'string' && value.length > 0 && value.length <= 1024,
    ) ||
    (data.modelId !== undefined &&
      (typeof data.modelId !== 'string' || data.modelId.length > 1024)) ||
    !Array.isArray(data.capabilities) ||
    !data.capabilities.every(
      (value) => value === 'image-input' || value === 'file-input',
    )
  )
    throw new Error('Input reply context is invalid');
  return data as AttentionInputReplyContext;
}
