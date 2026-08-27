/**
 * Data hooks — React Query wrappers over provider interfaces.
 *
 * All hooks follow the pattern:
 *   1. Resolve the active provider via getProvider(WORKSPACE, type)
 *   2. Use the provider id as part of the query key for cache isolation
 *   3. Delegate to the provider method
 */

import {
  getActiveProviderId,
  getProvider,
  hasProvider,
  invoke,
  useKnowledgeSaveMutation,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  getAccountAccess,
  recordAccountAccess,
  sortByAccessFrequency,
} from '../utils';
import type {
  CreateEventInput,
  CreateOpportunityInput,
  UpdateEventInput,
} from './providers';
import type { TaskVM } from './viewmodels';

export { sortByAccessFrequency };

const WORKSPACE = 'enterprise';

let _bgRefreshActive = false;

// ─── Calendar ────────────────────────────────────────────────────────────────

export function useCalendarEvents(date: Date, enabled = true) {
  const pid = getActiveProviderId(WORKSPACE, 'calendar');
  return useQuery({
    queryKey: ['calendar', 'events', date.toISOString().split('T')[0], pid],
    queryFn: () => getProvider(WORKSPACE, 'calendar').getEvents(date),
    enabled: enabled && hasProvider(WORKSPACE, 'calendar'),
  });
}

export function useMeetingDetails(
  meetingId: string | null,
  changeKey?: string,
) {
  const pid = getActiveProviderId(WORKSPACE, 'calendar');
  return useQuery({
    queryKey: ['calendar', 'meeting', meetingId, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'calendar').getMeetingDetails(
        meetingId!,
        changeKey,
      ),
    enabled: !!meetingId && hasProvider(WORKSPACE, 'calendar'),
  });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) =>
      getProvider(WORKSPACE, 'calendar').createEvent(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  });
}

export function useUpdateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEventInput) =>
      getProvider(WORKSPACE, 'calendar').updateEvent(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  });
}

export function useDeleteEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (meetingId: string) =>
      getProvider(WORKSPACE, 'calendar').deleteEvent(meetingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
  });
}

export function useContactSearch(query: string) {
  const pid = getActiveProviderId(WORKSPACE, 'calendar');
  return useQuery({
    queryKey: ['calendar', 'contacts', query, pid],
    queryFn: () => getProvider(WORKSPACE, 'calendar').searchContacts(query),
    enabled: query.length >= 2 && hasProvider(WORKSPACE, 'calendar'),
  });
}

// ─── User ─────────────────────────────────────────────────────────────────────

export function useUserProfile() {
  const pid = getActiveProviderId(WORKSPACE, 'user');
  return useQuery({
    queryKey: ['user', 'profile', pid],
    queryFn: () => getProvider(WORKSPACE, 'user').getMyProfile(),
    enabled: hasProvider(WORKSPACE, 'user'),
    staleTime: 5 * 60 * 1000,
  });
}

// ─── CRM — Accounts ──────────────────────────────────────────────────────────

export function useMyAccounts() {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  const profile = useUserProfile();
  return useQuery({
    queryKey: ['crm', 'myAccounts', profile.data?.id, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getMyAccounts(profile.data!.id),
    enabled: !!profile.data?.id && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useMyTerritories() {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  const profile = useUserProfile();
  return useQuery({
    queryKey: ['crm', 'myTerritories', profile.data?.id, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getMyTerritories(profile.data!.id),
    enabled: !!profile.data?.id && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useTerritoryAccounts(territoryId: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'territoryAccounts', territoryId, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getTerritoryAccounts(territoryId!),
    enabled: !!territoryId && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useSearchAccounts(query: string) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'searchAccounts', query, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').searchAccounts({
        field: 'name',
        operator: 'CONTAINS',
        value: query,
      }),
    enabled: query.length >= 2 && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useAccountDetails(accountId: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'accountDetails', accountId, pid],
    queryFn: () => getProvider(WORKSPACE, 'crm').getAccountDetails(accountId!),
    enabled: !!accountId && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useAccountOpportunities(accountId: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'accountOpportunities', accountId, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getAccountOpportunities(accountId!),
    enabled: !!accountId && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useSearchOpportunities(query: string) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'searchOpportunities', query, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').searchOpportunities({
        field: 'name',
        operator: 'CONTAINS',
        value: query,
      }),
    enabled: query.length >= 2 && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useMyOpportunities() {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  const profile = useUserProfile();
  return useQuery({
    queryKey: ['crm', 'myOpportunities', profile.data?.id, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getMyOpportunities(profile.data!.id),
    enabled: !!profile.data?.id && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOpportunityInput) =>
      getProvider(WORKSPACE, 'crm').createOpportunity(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

// ─── CRM — Tasks ─────────────────────────────────────────────────────────────

export function useUserTasks(filters?: { limit?: number }) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  const profile = useUserProfile();
  return useQuery({
    queryKey: ['crm', 'userTasks', profile.data?.id, filters, pid],
    queryFn: () =>
      getProvider(WORKSPACE, 'crm').getUserTasks(profile.data!.id, filters),
    enabled: !!profile.data?.id && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useMyTasks() {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  const profile = useUserProfile();
  return useQuery({
    queryKey: ['crm', 'myTasks', profile.data?.id, pid],
    queryFn: () => getProvider(WORKSPACE, 'crm').getMyTasks(profile.data!.id),
    enabled: !!profile.data?.id && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useTaskDetails(taskId: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'crm');
  return useQuery({
    queryKey: ['crm', 'taskDetails', taskId, pid],
    queryFn: () => getProvider(WORKSPACE, 'crm').getTaskDetails(taskId!),
    enabled: !!taskId && hasProvider(WORKSPACE, 'crm'),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<TaskVM, 'id'>) =>
      getProvider(WORKSPACE, 'crm').createTask(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: Partial<TaskVM> }) =>
      getProvider(WORKSPACE, 'crm').updateTask(taskId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm'] }),
  });
}

// ─── Email ────────────────────────────────────────────────────────────────────

export function useEmailInbox(options?: { count?: number; filter?: string }) {
  const pid = getActiveProviderId(WORKSPACE, 'email');
  return useQuery({
    queryKey: ['email', 'inbox', options, pid],
    queryFn: () => getProvider(WORKSPACE, 'email').getInbox(options),
    enabled: hasProvider(WORKSPACE, 'email'),
  });
}

export function useSearchEmails(query: string) {
  const pid = getActiveProviderId(WORKSPACE, 'email');
  return useQuery({
    queryKey: ['email', 'search', query, pid],
    queryFn: () => getProvider(WORKSPACE, 'email').searchEmails(query),
    enabled: query.length >= 2 && hasProvider(WORKSPACE, 'email'),
  });
}

export function useReadEmail(id: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'email');
  return useQuery({
    queryKey: ['email', 'read', id, pid],
    queryFn: () => getProvider(WORKSPACE, 'email').readEmail(id!),
    enabled: !!id && hasProvider(WORKSPACE, 'email'),
  });
}

// ─── Directory ────────────────────────────────────────────────────────────────

export function usePersonLookup(alias: string | null) {
  const pid = getActiveProviderId(WORKSPACE, 'internal');
  return useQuery({
    queryKey: ['internal', 'person', alias, pid],
    queryFn: () => getProvider(WORKSPACE, 'internal').lookupPerson(alias!),
    enabled: !!alias && hasProvider(WORKSPACE, 'internal'),
  });
}

export function usePeopleSearch(query: string) {
  const pid = getActiveProviderId(WORKSPACE, 'internal');
  return useQuery({
    queryKey: ['internal', 'people', query, pid],
    queryFn: () => getProvider(WORKSPACE, 'internal').searchPeople(query),
    enabled: query.length >= 2 && hasProvider(WORKSPACE, 'internal'),
  });
}

// ─── Account Access ───────────────────────────────────────────────────────────

export function useAccountAccess() {
  return {
    record: (accountId: string) => recordAccountAccess(accountId),
    getAccess: () => getAccountAccess(),
  };
}

// ─── Background Refresh ───────────────────────────────────────────────────────

export function useBackgroundRefresh(intervalMs = 5 * 60 * 1000) {
  const qc = useQueryClient();
  useEffect(() => {
    if (_bgRefreshActive) return;
    _bgRefreshActive = true;
    const id = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['crm'] });
      qc.invalidateQueries({ queryKey: ['email'] });
    }, intervalMs);
    return () => {
      clearInterval(id);
      _bgRefreshActive = false;
    };
  }, [qc, intervalMs]);
}

// ─── Account Matcher (AI) ─────────────────────────────────────────────────────

export function useAccountMatcher() {
  return useMutation({
    mutationFn: async ({
      text,
      accounts,
    }: {
      text: string;
      accounts: { id: string; name: string }[];
    }) => {
      const result = await invoke({
        prompt: `Given this text: "${text}", which account from the list best matches? Return the account id.\nAccounts: ${JSON.stringify(accounts)}`,
        schema: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        model: 'amazon.nova-lite-v1:0',
      });
      return result as { accountId: string };
    },
  });
}

// ─── Note Enhancement (AI) ────────────────────────────────────────────────────

export function useEnhanceNote() {
  return useMutation({
    mutationFn: async (noteContent: string) => {
      const result = await invoke({
        prompt: `Enhance and clean up this note, preserving all facts:\n\n${noteContent}`,
        schema: {
          type: 'object',
          properties: { enhanced: { type: 'string' } },
          required: ['enhanced'],
        },
        model: 'amazon.nova-lite-v1:0',
      });
      return (result as { enhanced: string }).enhanced;
    },
  });
}

// ─── Vault (save to knowledge base) ──────────────────────────────────────────

export function useHasVault(projectSlug: string | undefined): boolean {
  const { data: projects } = useProjectsQuery();
  return (
    !!projectSlug &&
    !!(projects as any[])?.find((p: any) => p.slug === projectSlug)
  );
}

export function useVaultSave(projectSlug: string, namespace: string) {
  return useKnowledgeSaveMutation(projectSlug, namespace);
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { relTime } from '../utils';
export { calendarProvider } from './providers/calendar';
export { crmProvider } from './providers/crm';
export { directoryProvider } from './providers/directory';
export { emailProvider } from './providers/email';
