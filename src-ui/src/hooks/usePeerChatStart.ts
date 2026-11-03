import { listProjects } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  GLOBAL_CONTEXT,
  NO_PROJECT_LABEL,
} from '../components/modals/new-chat-modal-utils';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { peerChatApiBase } from '../lib/peer-chat';

/** A remote chat chooses the receiver's Project explicitly, never a local slug. */
export function usePeerChatStart(
  environmentId: string | undefined,
  enabled: boolean,
) {
  const host = useHostRequestAuthorityScope();
  const active = enabled && !!environmentId && environmentId !== 'current';
  const scope = active ? host : undefined;
  const apiBase =
    scope && environmentId
      ? peerChatApiBase(scope.apiBase, environmentId)
      : undefined;
  const projects = useQuery({
    queryKey: ['peer-chat-projects', apiBase, scope?.authorityKey],
    enabled: !!scope?.isCurrent(),
    retry: false,
    queryFn: ({ signal }) => {
      if (!scope?.isCurrent())
        throw new Error('Reconnect to the selected Station.');
      return listProjects(apiBase!, { requestScope: scope, signal });
    },
  });
  const [choice, setChoice] = useState<{
    environmentId: string;
    context: string;
  }>();
  const context =
    choice && choice.environmentId === environmentId
      ? choice.context
      : undefined;
  const project = projects.data?.find((entry) => entry.slug === context);
  return {
    active,
    scope,
    projects,
    context,
    project,
    ready: context === GLOBAL_CONTEXT || (projects.isSuccess && !!project),
    choose: (value: string) => {
      if (environmentId) setChoice({ environmentId, context: value });
    },
    options: [
      {
        value: GLOBAL_CONTEXT,
        label: NO_PROJECT_LABEL,
        glyph: 'globe' as const,
      },
      ...(projects.data ?? []).map((entry) => ({
        value: entry.slug,
        label: entry.name,
        icon: entry.icon,
        workingDirectory: entry.workingDirectory,
      })),
    ],
  };
}
