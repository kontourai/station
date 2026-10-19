import type {
  AccountPreferencesPatch,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import type { ClientRequestOptions } from './http';
import { getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

export async function getAccountPreferences(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<AccountPreferencesView> {
  return (await unwrapProjectResponse(
    await getJson(`${apiBase}/api/me/preferences`, options),
  )) as AccountPreferencesView;
}

export async function patchAccountPreferences(
  apiBase: string,
  patch: AccountPreferencesPatch,
  options?: ClientRequestOptions,
  onlyMissing = false,
): Promise<AccountPreferencesView> {
  return (await unwrapProjectResponse(
    await mutateJson(
      `${apiBase}/api/me/preferences${onlyMissing ? '?onlyMissing=true' : ''}`,
      'PATCH',
      options,
      patch,
    ),
  )) as AccountPreferencesView;
}
