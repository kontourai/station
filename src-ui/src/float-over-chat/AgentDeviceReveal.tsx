import { fetchDeviceAgentReveals } from '@kontourai/station-sdk/mobile-device';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  useNavigation,
  useNavigationOptional,
} from '../contexts/NavigationContext';
import { useOpenDeviceInRegion } from '../contexts/useOpenDeviceInRegion';

// Explicit intents survive chat remounts in this tab; neither IDs nor scopes grant access.
const handledIntents = new Map<string, Set<string>>();

export function AgentDeviceReveal({
  projectSlug,
  conversationId,
}: {
  projectSlug: string;
  conversationId: string;
}) {
  const navigation = useNavigationOptional();
  return navigation ? (
    <ProjectDeviceReveal
      projectSlug={projectSlug}
      conversationId={conversationId}
    />
  ) : null;
}

function ProjectDeviceReveal({
  projectSlug,
  conversationId,
}: {
  projectSlug: string;
  conversationId: string;
}) {
  const { selectedProject, lastProject } = useNavigation();
  const activeProject = selectedProject || lastProject;
  if (activeProject !== projectSlug) return null;
  return (
    <ActiveDeviceReveal
      key={`${projectSlug}:${conversationId}`}
      projectSlug={projectSlug}
      conversationId={conversationId}
    />
  );
}

function ActiveDeviceReveal({
  projectSlug,
  conversationId,
}: {
  projectSlug: string;
  conversationId: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const open = useOpenDeviceInRegion();
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  const query = useQuery({
    queryKey: [
      'device-agent-reveals',
      scope?.apiBase,
      scope?.authorityKey,
      projectSlug,
      conversationId,
    ],
    enabled: !!scope && !!open,
    queryFn: async ({ signal }) => {
      if (!scope?.isCurrent()) throw new Error('Station authority changed');
      return fetchDeviceAgentReveals(
        scope.apiBase,
        projectSlug,
        conversationId,
        { signal, requestScope: scope },
      );
    },
    retry: false,
    refetchInterval: 2_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  useEffect(() => {
    if (
      !scope ||
      !open ||
      !scope.isCurrent() ||
      !query.data ||
      query.isFetching ||
      query.isError
    )
      return;
    const key = JSON.stringify([
      scope.apiBase,
      scope.authorityKey,
      projectSlug,
      conversationId,
    ]);
    if (seen.current?.key !== key) {
      const ids = handledIntents.get(key) ?? new Set<string>();
      handledIntents.delete(key);
      handledIntents.set(key, ids);
      while (handledIntents.size > 200)
        handledIntents.delete(handledIntents.keys().next().value!);
      seen.current = { key, ids };
    }
    const previous = seen.current.ids;
    const fresh = query.data.filter((entry) => !previous.has(entry.intentId));
    for (const entry of query.data) previous.add(entry.intentId);
    while (previous.size > 400)
      previous.delete(previous.values().next().value!);
    const latest = fresh.at(-1);
    if (!latest) return;
    const outcome = open(scope, latest.session, { region: 'right' });
    if (!outcome.ok && outcome.reason === 'region-unavailable')
      open(scope, latest.session);
  }, [
    scope,
    open,
    query.data,
    query.isFetching,
    query.isError,
    projectSlug,
    conversationId,
  ]);
  return null;
}
