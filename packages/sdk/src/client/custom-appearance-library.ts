import type {
  CustomAppearanceLibraryDocument,
  CustomAppearanceLibrarySaveInput,
  CustomAppearanceLibraryUpdateInput,
} from '@kontourai/station-contracts/custom-appearance';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

const path = (apiBase: string) => `${apiBase}/api/me/appearance/library`;

/** 404 means the host is older or Appearance Studio is disabled. */
export async function getCustomAppearanceLibrary(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(await getJson(path(apiBase), opts));
}
export async function saveCustomAppearanceLibraryTheme(
  apiBase: string,
  input: CustomAppearanceLibrarySaveInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(path(apiBase), 'POST', opts, input),
  );
}
export async function updateCustomAppearanceLibraryTheme(
  apiBase: string,
  input: CustomAppearanceLibraryUpdateInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(path(apiBase), 'PATCH', opts, input),
  );
}
export async function removeCustomAppearanceLibraryTheme(
  apiBase: string,
  input: { revision: string; id: string },
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(path(apiBase), 'DELETE', opts, input),
  );
}
