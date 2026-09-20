import type {
  ProjectSharedTaskPublication,
  ProjectSharedTaskPublicationExpectation,
} from '@kontourai/station-contracts/project-shared-task';
import {
  getProjectSharedTaskPublication,
  shareProjectTask,
  unshareProjectTask,
} from '@kontourai/station-sdk/project-shared-tasks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { errorText } from '../../utils/errorText';

export function ProjectTaskSharingControl({
  slug,
  projectId,
  task,
}: {
  slug: string;
  projectId?: string;
  task: { id: string; createdAt: string };
}) {
  const authority = useHostRequestAuthorityScope();
  const identity = [
    authority?.apiBase ?? 'unavailable',
    authority?.authorityKey ?? 'unavailable',
    projectId ?? 'unavailable',
    slug,
    task.id,
    task.createdAt,
  ].join('\u0000');
  return (
    <ProjectTaskSharingControlInner
      key={identity}
      authority={authority}
      slug={slug}
      projectId={projectId}
      task={task}
    />
  );
}

function ProjectTaskSharingControlInner({
  authority,
  slug,
  projectId,
  task,
}: {
  authority: ReturnType<typeof useHostRequestAuthorityScope>;
  slug: string;
  projectId?: string;
  task: { id: string; createdAt: string };
}) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const key = [
    'project-shared-task-publication',
    authority?.apiBase ?? 'unavailable',
    authority?.authorityKey ?? 'unavailable',
    projectId ?? 'unavailable',
    slug,
    task.id,
    task.createdAt,
  ] as const;
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(authority && projectId),
    retry: false,
    queryFn: ({ signal }) => {
      if (!authority || !projectId)
        throw new Error('Current Station authority is unavailable.');
      return getProjectSharedTaskPublication(authority.apiBase, slug, task.id, {
        requestScope: authority,
        signal,
      });
    },
  });
  const mutation = useMutation({
    mutationFn: async (input: {
      authority: NonNullable<typeof authority>;
      slug: string;
      queryKey: typeof key;
      expected: ProjectSharedTaskPublicationExpectation;
      shareId?: string;
    }) =>
      input.shareId
        ? unshareProjectTask(
            input.authority.apiBase,
            input.slug,
            input.shareId,
            input.expected,
            { requestScope: input.authority },
          )
        : shareProjectTask(
            input.authority.apiBase,
            input.slug,
            input.expected,
            {
              requestScope: input.authority,
            },
          ),
    onSettled: async (_data, _error, input) => {
      await client.invalidateQueries({ queryKey: input.queryKey });
    },
  });
  const publication = currentPublication(
    query.data,
    projectId ?? '',
    slug,
    task,
  );
  if (
    !authority ||
    !projectId ||
    query.isPending ||
    query.isError ||
    !publication
  )
    return null;
  const expected = expectation(publication);
  const shared = publication.kind === 'shared';
  const capturedAuthority = authority;
  const capturedPublication = publication;

  async function change() {
    setNotice(undefined);
    try {
      await mutation.mutateAsync({
        authority: { ...capturedAuthority },
        slug,
        queryKey: key,
        expected: structuredClone(expected),
        ...(capturedPublication.kind === 'shared'
          ? { shareId: capturedPublication.publication.shareId }
          : {}),
      });
      setNotice(
        shared ? 'Task sharing revoked.' : 'Task shared with Project viewers.',
      );
    } catch (cause) {
      setNotice(
        `Sharing state changed or could not be updated. ${errorText(cause)}`,
      );
    }
  }

  return (
    <div className="project-page__task-sharing" aria-live="polite">
      <strong>
        {shared
          ? 'Shared with Project viewers'
          : 'Not shared with Project viewers'}
      </strong>
      <p>
        Sharing exposes existing and future human room messages and the shared
        document verbatim to authorized Project viewers. Review them for paths,
        secrets, and other private text first. Structured tool events and
        attachment metadata are not included.
      </p>
      <Button pending={mutation.isPending} onClick={() => void change()}>
        {shared ? 'Revoke sharing' : 'Share Task'}
      </Button>
      {notice ? <p>{notice}</p> : null}
    </div>
  );
}

function currentPublication(
  publication: ProjectSharedTaskPublication | undefined,
  projectId: string,
  slug: string,
  task: { id: string; createdAt: string },
) {
  if (!publication) return undefined;
  const project =
    publication.kind === 'shared'
      ? publication.publication.project
      : publication.project;
  const publishedTask =
    publication.kind === 'shared'
      ? publication.publication.task
      : publication.task;
  return project.localProjectId === projectId &&
    project.localProjectSlug === slug &&
    publishedTask.id === task.id &&
    publishedTask.createdAt === task.createdAt
    ? publication
    : undefined;
}

function expectation(
  publication: ProjectSharedTaskPublication,
): ProjectSharedTaskPublicationExpectation {
  return publication.kind === 'shared'
    ? {
        project: publication.publication.project,
        task: {
          id: publication.publication.task.id,
          createdAt: publication.publication.task.createdAt,
        },
      }
    : { project: publication.project, task: publication.task };
}
