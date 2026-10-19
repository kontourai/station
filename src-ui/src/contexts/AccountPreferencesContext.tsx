import type {
  AccountPreferencesPatch,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import { createContext, useContext } from 'react';
import type { useHostRequestAuthorityScope } from './ApiBaseContext';

interface PreferenceState {
  status: 'loading' | 'account' | 'device' | 'error';
  saving: boolean;
  waitingForConnection: boolean;
  error: boolean;
  conflict: boolean;
  data?: AccountPreferencesView;
  save: (patch: AccountPreferencesPatch, onlyMissing?: boolean) => void;
  retry: () => void;
  requestScope?: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}
export const AccountPreferencesContext = createContext<PreferenceState>({
  status: 'device',
  saving: false,
  waitingForConnection: false,
  error: false,
  conflict: false,
  save: () => {},
  retry: () => {},
});

export function useAccountPreferences(): PreferenceState {
  return useContext(AccountPreferencesContext);
}
