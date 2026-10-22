import { environmentId } from '@kontourai/station-contracts/execution-target';
import type { ProjectCreationRequest } from '@kontourai/station-contracts/project';
import { getJson, readEnvelopeOrThrow } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod/v3';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

const pendingSchema = z
  .object({
    requestId: z.string().uuid(),
    draft: z
      .object({
        name: z.string().min(1),
        slug: z.string().min(1),
        icon: z.string().optional(),
        description: z.string().optional(),
        workingDirectory: z.string().optional(),
        repositoryAcquisitionId: z.string().uuid().optional(),
        defaultEnvironment: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('current') }),
            z.object({
              kind: z.literal('saved'),
              id: z.string().transform(environmentId),
            }),
          ])
          .optional(),
      })
      .strict(),
    starterLayoutId: z.string().nullable(),
  })
  .strict();
type ProjectCreationDraft = z.infer<typeof pendingSchema>['draft'];
type PendingCreation = z.infer<typeof pendingSchema>;

function retained(key: string | undefined): {
  pending: PendingCreation | null;
  corrupt: boolean;
} {
  if (!key) return { pending: null, corrupt: false };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { pending: null, corrupt: false };
    if (raw.length > 65536)
      throw new Error('Saved creation request exceeds its bound.');
    return { pending: pendingSchema.parse(JSON.parse(raw)), corrupt: false };
  } catch {
    return { pending: null, corrupt: true };
  }
}

/** Browser identity survives reload; only the server's exact receipt can establish an effect. */
export function useProjectCreationRecovery(isOpen: boolean, sending: boolean) {
  const scope = useHostRequestAuthorityScope();
  const key = scope
    ? JSON.stringify([
        'project-creation',
        scope.apiBase,
        scope.draftRecoveryKey ?? scope.authorityKey,
      ])
    : undefined;
  const [state, setState] = useState(() => ({ key, ...retained(key) }));
  const current = state.key === key ? state : { key, ...retained(key) };
  useEffect(() => {
    setState({ key, ...retained(key) });
  }, [key]);
  const capability = useQuery({
    queryKey: [
      'project-creation-available',
      scope?.apiBase,
      scope?.authorityKey,
    ],
    enabled: isOpen && Boolean(scope),
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      if (!scope) throw new Error('Station authority is unavailable.');
      const response = await getJson(
        `${scope.apiBase}/api/projects/creation-requests`,
        { requestScope: scope },
      );
      // Older Stations retain the existing create protocol, without durability metadata.
      if (response.status === 404) return false;
      const data = await readEnvelopeOrThrow<{ available: boolean }>(response);
      if (typeof data?.available !== 'boolean')
        throw new Error('Project recovery availability was not returned.');
      return data.available;
    },
  });
  const operation = useQuery({
    queryKey: [
      'project-creation-request',
      scope?.apiBase,
      scope?.authorityKey,
      current.pending?.requestId,
    ],
    enabled: isOpen && Boolean(scope && current.pending) && !sending,
    retry: false,
    staleTime: 0,
    queryFn: async (): Promise<
      ProjectCreationRequest | { phase: 'absent' }
    > => {
      if (!scope || !current.pending)
        throw new Error('No retained creation request.');
      const response = await getJson(
        `${scope.apiBase}/api/projects/creation-requests/${encodeURIComponent(current.pending.requestId)}`,
        { requestScope: scope },
      );
      if (response.status === 404) return { phase: 'absent' };
      const data = await readEnvelopeOrThrow<ProjectCreationRequest>(response);
      if (!data || data.requestId !== current.pending.requestId)
        throw new Error('Creation result did not match its request.');
      if (
        data.phase === 'created' &&
        (!data.project ||
          data.project.id !== data.projectId ||
          typeof data.project.slug !== 'string')
      )
        throw new Error('The creation response did not identify its Project.');
      if (data.starter?.phase === 'applied' && !data.starter.layoutSlug)
        throw new Error('The starter response did not identify its layout.');
      return data;
    },
  });
  return {
    pending: current.pending,
    corrupt: current.corrupt,
    outcome: operation.data,
    operation,
    statusMessage:
      operation.error instanceof Error
        ? operation.error.message
        : operation.data?.phase === 'uncertain'
          ? 'Station cannot confirm whether this creation completed. Check its result before starting another.'
          : operation.data?.phase === 'unavailable'
            ? 'The original Project is no longer available. This setup will not recreate it.'
            : operation.data?.phase === 'absent'
              ? 'No server request is recorded yet. Continue creation sends the saved request.'
              : operation.data?.phase === 'created' &&
                  operation.data.starter?.phase === 'uncertain'
                ? 'Project created. Retry layout checks for completed work and explicitly retries the saved starter.'
                : undefined,

    async prepare(
      draft: ProjectCreationDraft,
      starterLayoutId: string | null,
    ): Promise<PendingCreation | null> {
      if (current.corrupt)
        throw new Error(
          'The saved creation request could not be read. Clear it explicitly before creating another Project.',
        );
      if (current.pending) return current.pending;
      if (!scope) return null;
      const availability = capability.isSuccess
        ? capability.data
        : (await capability.refetch()).data;
      if (availability === undefined)
        throw new Error('Project recovery could not be checked. Try again.');
      if (!scope.isCurrent())
        throw new Error(
          'Station access changed. Try again on the selected Station.',
        );
      if (!availability) return null;
      const pending = pendingSchema.parse({
        requestId: crypto.randomUUID(),
        draft,
        starterLayoutId,
      });
      if (
        new TextEncoder().encode(
          JSON.stringify({
            ...pending.draft,
            creationRequestId: pending.requestId,
            starterLayoutId,
          }),
        ).length > 32768
      )
        throw new Error(
          'Project setup is too large to retain. Shorten its description and try again.',
        );
      if (!key) throw new Error('Station recovery identity is unavailable.');
      const existing = retained(key);
      if (existing.corrupt)
        throw new Error(
          'The saved creation request could not be read. Clear it explicitly before creating another Project.',
        );
      if (existing.pending) {
        if (
          JSON.stringify(existing.pending.draft) !==
            JSON.stringify(pending.draft) ||
          existing.pending.starterLayoutId !== starterLayoutId
        )
          throw new Error(
            'Another Project setup is saved for this Station account. Reopen New Project to inspect it first.',
          );
        setState({ key, ...existing });
        return existing.pending;
      }
      localStorage.setItem(key, JSON.stringify(pending));
      setState({ key, pending, corrupt: false });
      return pending;
    },
    clear(expectedRequestId = current.pending?.requestId) {
      if (scope && !scope.isCurrent())
        throw new Error(
          'Station access changed. Return to the creating account.',
        );
      const existing = retained(key);
      if (
        key &&
        (current.corrupt || existing.pending?.requestId === expectedRequestId)
      )
        localStorage.removeItem(key);
      setState({ key, pending: null, corrupt: false });
    },
  };
}
