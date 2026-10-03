import type {
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  readSkillExperienceInventory,
  readSkillExperienceSession,
} from '@kontourai/station-shared/skill-experience-values';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

async function read<T>(
  response: Response,
  parse: (value: unknown) => T | null,
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
  const parsed = parse('data' in body ? body.data : undefined);
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
    readSkillExperienceInventory,
  );
}

export async function fetchSkillExperienceSession(
  apiBase: string,
  threadId: string,
  cursor?: string,
  opts?: ClientRequestOptions,
): Promise<SkillExperienceSessionViewV1> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return read(
    await getJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/skill-experience${query}`,
      opts,
    ),
    readSkillExperienceSession,
  );
}
