import type {
  SkillCommand,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import {
  fetchRegistrySkills,
  fetchSkillDetail,
  fetchSystemSkills,
  importSkills,
  installRegistrySkill,
  recordSkillOutcome,
  type SkillImportFile,
  trackSkillRun,
} from '../client/skills';
import { type QueryConfig, useApiQuery } from '../query-core';

export type {
  SkillImportFile,
  SkillImportResult,
  SkillImportResultRow,
  SkillUsageResult,
  SkillUsageStats,
} from '../client/skills';

export function useSkillsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['skills', 'local'],
    async () => {
      const apiBase = await _getApiBase();
      return fetchSystemSkills(apiBase);
    },
    config,
  );
}

export function useRegistrySkillsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['skills', 'registry'],
    async () => {
      const apiBase = await _getApiBase();
      return fetchRegistrySkills(apiBase);
    },
    config,
  );
}

export function useInstallSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      return installRegistrySkill(apiBase, id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUninstallSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/registry/skills/${id}`,
        {
          method: 'DELETE',
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || 'Uninstall failed');
      }
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUpdateSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/registry/skills/${id}/update`,
        {
          method: 'POST',
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || 'Update failed');
      }
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useCreateLocalSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      body: string;
      description?: string;
      category?: string;
      tags?: string[];
      agent?: string;
      global?: boolean;
      command?: SkillCommand;
      variables?: SkillVariable[];
    }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/api/skills/local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Create failed'));
      }
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUpdateLocalSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      ...updates
    }: {
      name: string;
      body?: string;
      description?: string;
      category?: string;
      tags?: string[];
      agent?: string;
      global?: boolean;
      command?: SkillCommand;
      variables?: SkillVariable[];
    }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/skills/${name}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Update failed'));
      }
      return result;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useSkillContentQuery(
  id: string | undefined,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['skills', 'content', id ?? ''],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/registry/skills/${id}/content`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data as string;
    },
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

/** One key for a skill's detail read, so the query and the on-demand read hit
 * the same cache entry. */
const skillDetailQueryKey = (nameOrLegacyId: string): string[] => [
  'skills',
  'detail',
  nameOrLegacyId,
];

export function useSkillQuery(
  name: string | undefined,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    skillDetailQueryKey(name ?? ''),
    async () => {
      const apiBase = await _getApiBase();
      return fetchSkillDetail(apiBase, name ?? '');
    },
    { ...config, enabled: !!name && (config?.enabled ?? true) },
  );
}

/**
 * Read one skill's full record on demand, through the SAME cache entry
 * `useSkillQuery` fills.
 *
 * The slash handler needs a body at the moment a `/command` is typed, which is
 * not a render — so it cannot be a query. Going through `fetchQuery` rather
 * than a bare fetch means the editor's open detail and the command expansion
 * are one cached read, and a second `/command` in the same session costs
 * nothing.
 */
export function useSkillDetailReader() {
  const queryClient = useQueryClient();
  return useCallback(
    (nameOrLegacyId: string) =>
      queryClient.fetchQuery({
        queryKey: skillDetailQueryKey(nameOrLegacyId),
        queryFn: async () => {
          const apiBase = await _getApiBase();
          return fetchSkillDetail(apiBase, nameOrLegacyId);
        },
      }),
    [queryClient],
  );
}

import { authenticatedFetch } from '../client/http';

/**
 * Count one use of a skill. Accepts a skill name OR a legacy identifier the
 * skill records in `legacyIds`, so a caller holding a migrated id keeps
 * working.
 */
export function useRunSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (nameOrLegacyId: string) => {
      const apiBase = await _getApiBase();
      return trackSkillRun(apiBase, nameOrLegacyId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

/** Record how a skill's run turned out. */
export function useSkillOutcome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      outcome,
    }: {
      name: string;
      outcome: 'success' | 'failure';
    }) => {
      const apiBase = await _getApiBase();
      return recordSkillOutcome(apiBase, name, outcome);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}

/** Import markdown files as local skills in one request. */
export function useImportSkills(apiBase?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: SkillImportFile[]) => {
      const resolvedApiBase = apiBase ?? (await _getApiBase());
      return importSkills(resolvedApiBase, files);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
}
