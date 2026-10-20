import type {
  AccountPreferences,
  AccountPreferencesPatch,
  AccountPreferencesUpdate,
} from '@kontourai/station-contracts/account-preferences';
import {
  getAccountPreferences,
  patchAccountPreferences,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { StartupScreen } from '../components/StartupScreen';
import { applyAccentColor } from '../lib/accent-contrast';
import { applyAccountPreferencePatch } from '../lib/account-preference-values';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { AccountPreferencesContext } from './AccountPreferencesContext';
import { useApiBase, useHostRequestAuthorityScope } from './ApiBaseContext';
import { useAuthorityPersistence } from './AuthorityPersistenceContext';
import { activeChatsStore } from './active-chats-store';
import { toastStore } from './ToastContext';

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
  const queryKey = useMemo(
    () =>
      [
        'account-preferences',
        authority.namespace,
        scope?.authorityKey,
      ] as const,
    [authority.namespace, scope?.authorityKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request authority owns a separate pending-write queue.
  const pending = useMemo(() => new Map<number, PendingWrite>(), [queryKey]);
  const nextWrite = useRef(0);
  const [pendingVersion, publishPending] = useReducer(
    (value: number) => value + 1,
    0,
  );
  type PendingWrite = AccountPreferencesUpdate & {
    apiBase: string;
    scope: NonNullable<typeof scope>;
    queryKey: typeof queryKey;
    client: typeof queryClient;
    pending: Map<number, PendingWrite>;
    id: number;
    revision?: string;
  };
  const query = useQuery({
    queryKey,
    enabled: eligible && !!scope,
    queryFn: ({ signal }) =>
      getAccountPreferences(apiBase, { signal, requestScope: scope }),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    retry: false,
  });
  const mutation = useMutation({
    mutationKey: queryKey,
    scope: { id: JSON.stringify(queryKey) },
    mutationFn: (write: PendingWrite) => {
      if (!write.scope.isCurrent()) throw new Error('Account access changed.');
      return patchAccountPreferences(
        write.apiBase,
        write.patch,
        {
          requestScope: write.scope,
          ...(write.revision
            ? { headers: { 'If-Match': write.revision } }
            : {}),
        },
        write.onlyMissing,
      );
    },
    onMutate: async (write) => {
      await write.client.cancelQueries({ queryKey: write.queryKey });
    },
    onSuccess: async (data, write) => {
      write.pending.delete(write.id);
      if (Object.hasOwn(write.patch, 'modelPickerPreferences'))
        for (const queued of write.pending.values())
          if (queued.revision === write.revision)
            queued.revision = data.revision;
      await write.client.cancelQueries({ queryKey: write.queryKey });
      if (write.scope.isCurrent()) {
        write.client.setQueryData(write.queryKey, data);
        publishPending();
      }
    },
    onError: (error, write) => {
      write.pending.delete(write.id);
      if (write.scope.isCurrent()) {
        publishPending();
        toastStore.show(
          error instanceof StationHttpError && error.status === 409
            ? 'Preferences changed on another device. Reload them in Settings before trying again.'
            : 'Couldn’t confirm the preference was saved. Reload it in Settings.',
          undefined,
          0,
          undefined,
          undefined,
          'error',
        );
      }
    },
  });
  const mutate = mutation.mutate;
  const available = eligible && query.isSuccess && query.isFetchedAfterMount;
  const save = useCallback(
    (patch: AccountPreferencesPatch, onlyMissing = false) => {
      if (!eligible || !scope?.isCurrent()) return;
      const id = ++nextWrite.current;
      const write: PendingWrite = {
        patch,
        onlyMissing,
        apiBase,
        scope,
        queryKey,
        client: queryClient,
        pending,
        id,
        revision:
          [...pending.values()].find((item) =>
            Object.hasOwn(item.patch, 'modelPickerPreferences'),
          )?.revision ?? query.data?.revision,
      };
      pending.set(id, write);
      publishPending();
      mutate(write);
    },
    [
      eligible,
      scope,
      apiBase,
      queryKey,
      queryClient,
      pending,
      query.data?.revision,
      mutate,
    ],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingVersion invalidates this projection after in-place queue mutations.
  const projected = useMemo(() => {
    if (!query.data) return undefined;
    let values: AccountPreferences = query.data.values;
    for (const write of pending.values())
      values = applyAccountPreferencePatch(
        values,
        write.patch,
        write.onlyMissing,
      );
    return { ...query.data, values };
  }, [query.data, pending, pendingVersion]);
  useLayoutEffect(() => {
    // No person here: this device's own appearance applies, not the account
    // appearance the startup path painted from its cache. Only definite
    // answers count: a refused credential (401), or a verified authority whose
    // principal is not a person. 'unavailable' without a refusal also covers
    // states still resolving (no connection yet, a native relay account not
    // ready), and 'unverified' (offline, an older server) may still be the
    // same person; the cached appearance stays for those.
    const definite =
      authority.refused === true || authority.status === 'verified';
    if (!eligible && definite) deviceSettingsStore.releaseBootAppearance();
  }, [eligible, authority.refused, authority.status]);
  useLayoutEffect(() => {
    if (!eligible || !scope?.isCurrent()) return;
    return deviceSettingsStore.bindAccountPreferences(
      query.isFetchedAfterMount ? projected?.values : undefined,
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
      available,
      // Keys any appearance held after this binding ends to this account.
      authority.namespace ?? undefined,
    );
  }, [
    eligible,
    available,
    projected,
    query.isFetchedAfterMount,
    save,
    scope,
    authority.namespace,
  ]);
  useLayoutEffect(() => {
    if (authority.status !== 'verified' || !authority.namespace) return;
    for (const [sessionId, chat] of Object.entries(
      activeChatsStore.getSnapshot(),
    ))
      if (
        chat.queuedApprovalDefaultNamespace &&
        chat.queuedApprovalDefaultNamespace !== authority.namespace
      )
        activeChatsStore.updateChat(sessionId, {
          queuedApprovalMode: undefined,
          queuedApprovalDefaultNamespace: undefined,
        });
  }, [authority.namespace, authority.status]);
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
        saving: pending.size > 0,
        waitingForConnection:
          pending.size > 0 && mutation.isPaused && !onlineManager.isOnline(),
        error: mutation.isError,
        conflict:
          mutation.isError &&
          mutation.error instanceof StationHttpError &&
          mutation.error.status === 409,
        data: available ? projected : undefined,
        save,
        requestScope: scope,
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
