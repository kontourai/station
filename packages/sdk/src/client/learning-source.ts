import type { LearningSourceObservation } from '@kontourai/station-contracts/learning-review';
import {
  KNOWLEDGE_ROOT_IDENTITY_HEADER,
  KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS,
} from '@kontourai/station-shared/knowledge-root-identity';
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';

export interface LearningSourceReference {
  rootId: string;
  recordId: string;
  rootIdentity: string;
}

export async function observeLearningSource(
  apiBase: string,
  reference: LearningSourceReference,
  options?: ClientRequestOptions,
): Promise<LearningSourceObservation> {
  if (
    typeof reference.rootId !== 'string' ||
    !reference.rootId ||
    reference.rootId.length > 200 ||
    typeof reference.recordId !== 'string' ||
    !reference.recordId ||
    reference.recordId.length > 200 ||
    typeof reference.rootIdentity !== 'string' ||
    !reference.rootIdentity ||
    reference.rootIdentity.length > KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS
  )
    throw new Error('Invalid source registration identity.');
  const identityHeader = encodeURIComponent(reference.rootIdentity);
  if (identityHeader.length > KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS)
    throw new Error('Source registration identity exceeds the request budget.');
  const response = await getJson(
    `${apiBase}/api/knowledge/roots/${encodeURIComponent(reference.rootId)}/records/${encodeURIComponent(reference.recordId)}/source-observation`,
    {
      ...options,
      headers: {
        ...options?.headers,
        [KNOWLEDGE_ROOT_IDENTITY_HEADER]: identityHeader,
      },
    },
  );
  const envelope = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (!response.ok || envelope.success !== true)
    throw new Error(
      apiErrorMessage(envelope, 'Could not inspect the learning source.'),
    );
  const data = envelope.data as LearningSourceObservation | undefined;
  const failures = [
    'restricted',
    'unsupported',
    'missing',
    'busy',
    'corrupt',
    'unavailable',
    'invalid-input',
    'over-budget',
  ];
  if (data && failures.includes(data.state))
    return { state: data.state } as LearningSourceObservation;
  if (data?.state !== 'observed' || data.kind !== 'source-only')
    throw new Error('Invalid source observation.');
  const source = data.source;
  const observation = data.observation;
  if (
    !source ||
    source.rootId !== reference.rootId ||
    source.recordId !== reference.recordId ||
    source.adapterId !== 'kit-default-store' ||
    !['type', 'title', 'category', 'body', 'created_at', 'updated_at'].every(
      (key) =>
        typeof (source as unknown as Record<string, unknown>)[key] === 'string',
    ) ||
    !source.provenance ||
    typeof source.provenance.agent !== 'string' ||
    (source.provenance.note !== undefined &&
      typeof source.provenance.note !== 'string') ||
    (source.provenance.session_id !== undefined &&
      typeof source.provenance.session_id !== 'string') ||
    (source.provenance.source_ids !== undefined &&
      (!Array.isArray(source.provenance.source_ids) ||
        !source.provenance.source_ids.every((id) => typeof id === 'string'))) ||
    (source.status !== undefined &&
      !['active', 'implemented', 'retired'].includes(source.status)) ||
    !observation ||
    observation.ownerRevision !== 'unknown' ||
    observation.consistency !== 'non-atomic' ||
    observation.transactionState !== 'unknown' ||
    typeof observation.contentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(observation.contentDigest) ||
    typeof observation.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(observation.observedAt)) ||
    JSON.stringify(data).length > 2 * 1024 * 1024
  )
    throw new Error('Invalid source observation.');
  return {
    state: 'observed',
    kind: 'source-only',
    source: {
      rootId: source.rootId,
      recordId: source.recordId,
      adapterId: source.adapterId,
      type: source.type,
      title: source.title,
      category: source.category,
      body: source.body,
      provenance: {
        agent: source.provenance.agent,
        ...(source.provenance.note === undefined
          ? {}
          : { note: source.provenance.note }),
        ...(source.provenance.session_id === undefined
          ? {}
          : { session_id: source.provenance.session_id }),
        ...(source.provenance.source_ids === undefined
          ? {}
          : { source_ids: [...source.provenance.source_ids] }),
      },
      created_at: source.created_at,
      updated_at: source.updated_at,
      ...(source.status === undefined ? {} : { status: source.status }),
    },
    observation: {
      observedAt: observation.observedAt,
      contentDigest: observation.contentDigest,
      ownerRevision: 'unknown',
      consistency: 'non-atomic',
      transactionState: 'unknown',
    },
  };
}
