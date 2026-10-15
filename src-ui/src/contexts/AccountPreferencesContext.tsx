import type {
  AccountPreferencesPatch,
  AccountPreferencesUpdate,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import {
  getAccountPreferences,
  patchAccountPreferences,
} from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
} from 'react';
import { StartupScreen } from '../components/StartupScreen';
import { applyAccentColor } from '../lib/accent-contrast';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { useApiBase, useHostRequestAuthorityScope } from './ApiBaseContext';
import { useAuthorityPersistence } from './AuthorityPersistenceContext';
import { toastStore } from './ToastContext';

interface PreferenceState {
  status: 'loading' | 'account' | 'device' | 'error';
  saving: boolean;
  error: boolean;
  data?: AccountPreferencesView;
  save: (patch: AccountPreferencesPatch, onlyMissing?: boolean) => void;
  retry: () => void;
}
const AccountPreferencesContext = createContext<PreferenceState>({
  status: 'device',
  saving: false,
  error: false,
  save: () => {},
  retry: () => {},
});

/** Mounted inside the verified authority boundary; no account values persist to device storage. */
export function AccountPreferencesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { apiBase } = useApiBase();
  const scope = useHostRequestAuthorityScope();
  const authority = useAuthorityPersistence();
  const queryClient = useQueryClient();
  const principal = authority.observation?.principal;
  const eligible =
    authority.status === 'verified' &&
    principal?.kind === 'human' &&
    !principal.id.startsWith('human:device:');
  const queryKey = ['account-preferences', authority.namespace] as const;
  const query = useQuery({
    queryKey,
    enabled: eligible && !!scope,
    queryFn: ({ signal }) =>
      getAccountPreferences(apiBase, { signal, requestScope: scope }),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const mutation = useMutation({
    scope: { id: `account-preferences:${authority.namespace}` },
    mutationFn: ({ patch, onlyMissing }: AccountPreferencesUpdate) => {
      if (!scope?.isCurrent() || !eligible)
        throw new Error('Account access changed.');
      return patchAccountPreferences(
        apiBase,
        patch,
        { requestScope: scope },
        onlyMissing,
      );
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
    },
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey });
      if (scope?.isCurrent()) queryClient.setQueryData(queryKey, data);
    },
    onError: () => {
      if (scope?.isCurrent())
        toastStore.show(
          'Account preferences were not saved. Your previous choices are still active. Open Settings to reload and try again.',
          undefined,
          0,
          undefined,
          undefined,
          'error',
        );
    },
  });
  const mutate = mutation.mutate;
  const save = useCallback(
    (patch: AccountPreferencesPatch, onlyMissing = false) =>
      mutate({ patch, onlyMissing }),
    [mutate],
  );
  const available = eligible && query.isSuccess;
  useLayoutEffect(() => {
    if (!eligible || !scope?.isCurrent()) return;
    return deviceSettingsStore.bindAccountPreferences(
      query.data?.values,
      available
        ? save
        : () => {
            toastStore.show(
              'Account preferences are unavailable. Reload them in Settings before changing a personal preference.',
              undefined,
              0,
              undefined,
              undefined,
              'error',
            );
          },
    );
  }, [eligible, available, query.data, save, scope]);
  useLayoutEffect(() => {
    let failureShown = false;
    const apply = () => {
      const settings = deviceSettingsStore.getSnapshot();
      document.documentElement.setAttribute('data-theme', settings.theme);
      applyAccentColor(document.documentElement, settings.accentColor);
      if (deviceSettingsStore.isPersistenceFailed() && !failureShown) {
        toastStore.show(
          'This device could not save its preferences. Changes may be lost when you reload.',
          undefined,
          0,
          undefined,
          undefined,
          'error',
        );
      }
      failureShown = deviceSettingsStore.isPersistenceFailed();
    };
    apply();
    return deviceSettingsStore.subscribe(apply);
  }, []);
  if (
    eligible &&
    (query.isPending || (query.isFetching && !query.isFetchedAfterMount))
  )
    return <StartupScreen message="Loading your preferences" />;
  return (
    <AccountPreferencesContext.Provider
      value={{
        status: !eligible
          ? 'device'
          : query.isError
            ? 'error'
            : available
              ? 'account'
              : 'loading',
        saving: mutation.isPending,
        error: mutation.isError,
        data: available ? query.data : undefined,
        save,
        retry: () => {
          mutation.reset();
          void query.refetch();
        },
      }}
    >
      {children}
    </AccountPreferencesContext.Provider>
  );
}

export function useAccountPreferences(): PreferenceState {
  return useContext(AccountPreferencesContext);
}
