import type {
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  readSkillExperienceInventory,
  readSkillExperienceSession,
} from '@kontourai/station-shared/skill-experience-reader';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

async function read<T>(
  response: Response,
  parse: (value: unknown) => Promise<T | null>,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok)
      throw envelopeError(
        response,
        undefined,
        `Experience request failed with HTTP ${response.status}`,
      );
    throw error;
  }
  if (
    !response.ok ||
    body === null ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true
  )
    throw envelopeError(
      response,
      body,
      `Experience request failed with HTTP ${response.status}`,
    );
  const parsed = await parse('data' in body ? body.data : undefined);
  if (!parsed)
    throw new Error(
      'Station returned an unsupported skill experience response.',
    );
  return parsed;
}

export async function fetchSkillExperienceInventory(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<SkillExperienceInventoryV1> {
  return read(
    await getJson(`${apiBase}/api/skills/experiences`, opts),
    async (value) => readSkillExperienceInventory(value),
  );
}

export async function fetchSkillExperienceSession(
  apiBase: string,
  threadId: string,
  cursor?: string,
  opts?: ClientRequestOptions & {
    expectedSkillExperience?: {
      identity: SkillExperienceIdentityV1;
      eventId: string;
    };
  },
): Promise<SkillExperienceSessionViewV1> {
  const { expectedSkillExperience, ...requestOptions } = opts ?? {};
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (expectedSkillExperience)
    query.set(
      'expectedSkillExperience',
      JSON.stringify(expectedSkillExperience),
    );
  return read(
    await getJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/skill-experience${query.size ? `?${query}` : ''}`,
      requestOptions,
    ),
    async (value) => readSkillExperienceSession(value),
  );
}
