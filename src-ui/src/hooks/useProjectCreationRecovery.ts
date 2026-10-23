import { environmentId } from '@kontourai/station-contracts/execution-target';
import type {
  ProjectCreationRequest,
  ProjectStartIntent,
} from '@kontourai/station-contracts/project';
import { getJson, readEnvelopeOrThrow } from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod/v3';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  type ProjectRecoveryScope,
  projectCreationRecoveryIdentity,
  readProjectCreationRecovery,
  removeProjectCreationRecovery,
  writeProjectCreationRecovery,
} from '../lib/project-onboarding-recovery';

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
    startIntent: z
      .enum(['workspace', 'knowledge', 'connections', 'blank'])
      .optional(),
  })
  .strict();
type ProjectCreationDraft = z.infer<typeof pendingSchema>['draft'];
type PendingCreation = z.infer<typeof pendingSchema>;

function retained(scope: ProjectRecoveryScope | undefined): {
  pending: PendingCreation | null;
  corrupt: boolean;
  raw: string | null;
} {
  let raw: string | null = null;
  if (!scope) return { pending: null, corrupt: false, raw };
  try {
    raw = readProjectCreationRecovery(scope);
    if (!raw) return { pending: null, corrupt: false, raw };
    if (raw.length > 65536)
      throw new Error('Saved creation request exceeds its bound.');
    return {
      pending: pendingSchema.parse(JSON.parse(raw)),
      corrupt: false,
      raw,
    };
  } catch {
    return { pending: null, corrupt: true, raw };
  }
}

/** Browser identity survives reload; only the server's exact receipt can establish an effect. */
export function useProjectCreationRecovery(isOpen: boolean, sending: boolean) {
  const scope = useHostRequestAuthorityScope();
  const apiBase = scope?.apiBase;
  const recoveryKey = scope?.draftRecoveryKey ?? scope?.authorityKey;
  const recoveryScope = useMemo(
    () =>
      apiBase !== undefined && recoveryKey !== undefined
        ? { apiBase, authorityKey: recoveryKey }
        : undefined,
    [apiBase, recoveryKey],
  );
  const key = recoveryScope
    ? projectCreationRecoveryIdentity(recoveryScope)
    : undefined;
  const [state, setState] = useState(() => ({
    key,
    ...retained(recoveryScope),
  }));
  const current =
    state.key === key ? state : { key, ...retained(recoveryScope) };
  useEffect(() => {
    setState({ key, ...retained(recoveryScope) });
  }, [key, recoveryScope]);
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
      startIntent: ProjectStartIntent = 'workspace',
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
        requestId: randomCorrelationId(),
        draft,
        starterLayoutId,
        startIntent,
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
      if (!scope) throw new Error('Station recovery identity is unavailable.');
      const existing = retained(recoveryScope);
      if (existing.corrupt)
        throw new Error(
          'The saved creation request could not be read. Clear it explicitly before creating another Project.',
        );
      if (existing.pending) {
        if (
          JSON.stringify(existing.pending.draft) !==
            JSON.stringify(pending.draft) ||
          existing.pending.starterLayoutId !== starterLayoutId ||
          (existing.pending.startIntent ?? 'workspace') !== startIntent
        )
          throw new Error(
            'Another Project setup is saved for this Station account. Reopen New Project to inspect it first.',
          );
        setState({ key, ...existing });
        return existing.pending;
      }
      writeProjectCreationRecovery(scope, JSON.stringify(pending));
      setState({ key, pending, corrupt: false, raw: JSON.stringify(pending) });
      return pending;
    },
    clear(expectedRequestId = current.pending?.requestId) {
      if (scope && !scope.isCurrent())
        throw new Error(
          'Station access changed. Return to the creating account.',
        );
      const existing = retained(recoveryScope);
      const matches = current.corrupt
        ? current.raw !== null &&
          current.raw === existing.raw &&
          existing.corrupt
        : existing.pending?.requestId === expectedRequestId;
      if (!matches && (existing.raw !== null || existing.corrupt)) {
        setState({ key, ...existing });
        throw new Error(
          'Saved setup changed in another tab. Inspect the newer request before setting it aside.',
        );
      }
      if (scope && matches) removeProjectCreationRecovery(scope);
      setState({ key, pending: null, corrupt: false, raw: null });
    },
  };
}
