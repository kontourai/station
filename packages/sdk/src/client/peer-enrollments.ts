import type {
  PeerEnrollment,
  PeerEnrollmentInput,
} from '@kontourai/station-contracts/environment-security';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { rethrowDeadline } from './request-deadline';

interface EnrollmentEnvelope {
  success: boolean;
  data?: PeerEnrollment;
  error?: string;
  code?: string;
}

async function enrollmentResponse(response: Response): Promise<PeerEnrollment> {
  let result: EnrollmentEnvelope;
  try {
    result = (await response.json()) as EnrollmentEnvelope;
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok)
      throw envelopeError(response, undefined, 'Station enrollment failed.');
    throw error;
  }
  if (!response.ok || !result.success || result.data === undefined)
    throw envelopeError(response, result, 'Station enrollment failed.');
  return result.data;
}

function enrollmentUrl(apiBase: string, id?: string): string {
  const root = `${apiBase}/api/environments/peers/enrollments`;
  return id === undefined ? root : `${root}/${encodeURIComponent(id)}`;
}

export async function startPeerEnrollment(
  apiBase: string,
  input: PeerEnrollmentInput,
  options?: ClientRequestOptions,
): Promise<PeerEnrollment> {
  return enrollmentResponse(
    await mutateJson(enrollmentUrl(apiBase), 'POST', options, input),
  );
}

export async function getPeerEnrollment(
  apiBase: string,
  id: string,
  options?: ClientRequestOptions,
): Promise<PeerEnrollment> {
  return enrollmentResponse(await getJson(enrollmentUrl(apiBase, id), options));
}

export async function completePeerEnrollment(
  apiBase: string,
  id: string,
  options?: ClientRequestOptions,
): Promise<PeerEnrollment> {
  return enrollmentResponse(
    await mutateJson(`${enrollmentUrl(apiBase, id)}/complete`, 'POST', options),
  );
}

export async function cancelPeerEnrollment(
  apiBase: string,
  id: string,
  options?: ClientRequestOptions,
): Promise<PeerEnrollment> {
  return enrollmentResponse(
    await mutateJson(enrollmentUrl(apiBase, id), 'DELETE', options),
  );
}
