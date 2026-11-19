import type { CustomAppearanceDocument } from '@kontourai/station-contracts/custom-appearance';
import { type ClientRequestOptions, getJson } from './http';
import { unwrapProjectResponse } from './project-response';

/** The calling person's custom appearance (docs/decisions/custom-appearance.md). */
export async function getCustomAppearance(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await getJson(`${apiBase}/api/me/appearance`, opts),
  );
}
