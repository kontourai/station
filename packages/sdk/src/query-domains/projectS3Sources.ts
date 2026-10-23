import type {
  ProjectS3ObjectPage,
  ProjectS3ObjectRead,
  ProjectS3Source,
} from '@kontourai/station-contracts/project';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import {
  type AttachProjectS3SourceInput,
  attachProjectS3Source,
  disconnectProjectS3Source,
  getProjectS3Capabilities,
  getProjectS3Profiles,
  listProjectS3Objects,
  listProjectS3Sources,
  readProjectS3Object,
} from '../client/knowledge';
import { type ApiRequestScope, useApiQuery } from '../query-core';

function scopeOptions(scope: ApiRequestScope) {
  if (!isApiRequestScope(scope)) throw new StationRequestAuthorityError();
  return { requestScope: scope };
}
const fresh = {
  staleTime: 0,
  keepPreviousData: false,
  refetchOnMount: 'always' as const,
  retry: false,
};
const key = (scope: ApiRequestScope) => [
  'project-s3',
  scope.apiBase,
  scope.authorityKey,
];

export function useProjectS3CapabilitiesQuery(scope: ApiRequestScope) {
  return useApiQuery<{ enabled: boolean; canManage: boolean }>(
    [...key(scope), 'capabilities'],
    () => getProjectS3Capabilities(scope.apiBase, scopeOptions(scope)),
    fresh,
  );
}
export function useProjectS3ProfilesQuery(
  scope: ApiRequestScope,
  enabled: boolean,
) {
  return useApiQuery<{ available: boolean; profiles: string[] }>(
    [...key(scope), 'profiles'],
    () => getProjectS3Profiles(scope.apiBase, scopeOptions(scope)),
    { ...fresh, enabled },
  );
}
export function useProjectS3SourcesQuery(
  scope: ApiRequestScope,
  projectSlug: string,
  projectId: string,
  enabled: boolean,
) {
  return useApiQuery<ProjectS3Source[]>(
    [...key(scope), projectSlug, 'sources', projectId],
    () => listProjectS3Sources(scope.apiBase, projectSlug, scopeOptions(scope)),
    { ...fresh, enabled },
  );
}
export function useProjectS3ObjectsQuery(
  scope: ApiRequestScope,
  projectSlug: string,
  sourceId: string | undefined,
  cursor: string | undefined,
  enabled: boolean,
) {
  return useApiQuery<ProjectS3ObjectPage>(
    [...key(scope), projectSlug, sourceId ?? null, 'objects', cursor ?? null],
    () => {
      if (!enabled || !sourceId) throw new StationRequestAuthorityError();
      return listProjectS3Objects(
        scope.apiBase,
        projectSlug,
        sourceId,
        cursor,
        scopeOptions(scope),
      );
    },
    { ...fresh, enabled: enabled && Boolean(sourceId) },
  );
}
export function useProjectS3ObjectQuery(
  scope: ApiRequestScope,
  projectSlug: string,
  sourceId: string | undefined,
  object: { key: string; etag: string } | undefined,
  enabled: boolean,
) {
  return useApiQuery<ProjectS3ObjectRead>(
    [
      ...key(scope),
      projectSlug,
      sourceId ?? null,
      'object',
      object?.key ?? null,
      object?.etag ?? null,
    ],
    () => {
      if (!enabled || !sourceId || !object)
        throw new StationRequestAuthorityError();
      return readProjectS3Object(
        scope.apiBase,
        projectSlug,
        sourceId,
        object.key,
        object.etag,
        scopeOptions(scope),
      );
    },
    { ...fresh, enabled: enabled && Boolean(sourceId && object) },
  );
}
export function useAttachProjectS3SourceMutation(
  scope: ApiRequestScope,
  projectSlug: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AttachProjectS3SourceInput) =>
      attachProjectS3Source(
        scope.apiBase,
        projectSlug,
        input,
        scopeOptions(scope),
      ),
    retry: false,
    onSettled: () =>
      client.invalidateQueries({ queryKey: [...key(scope), projectSlug] }),
  });
}
export function useDisconnectProjectS3SourceMutation(
  scope: ApiRequestScope,
  projectSlug: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (source: ProjectS3Source) =>
      disconnectProjectS3Source(
        scope.apiBase,
        projectSlug,
        source,
        scopeOptions(scope),
      ),
    retry: false,
    onSettled: () =>
      client.invalidateQueries({ queryKey: [...key(scope), projectSlug] }),
  });
}
