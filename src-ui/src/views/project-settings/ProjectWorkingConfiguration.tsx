import {
  PROJECT_WORKING_CONFIGURATION_PREVIEW,
  type ProjectWorkingConfigurationView,
  type ProjectWorkingDraft,
} from '@kontourai/station-contracts/project-working-configuration';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import {
  applyProjectWorkingConfiguration,
  fetchProjectWorkingConfiguration,
} from '@kontourai/station-sdk/client/project-working-configuration';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import './ProjectWorkingConfiguration.css';

export function ProjectWorkingConfiguration(props: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const visible = useSurfaceVisibilityFlags();
  return visible.has(PROJECT_WORKING_CONFIGURATION_PREVIEW) ? (
    <WorkingConfigurationEditor {...props} />
  ) : null;
}

function WorkingConfigurationEditor({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
}) {
  const client = useQueryClient();
  const key = [
    'project-working-configuration',
    authority.apiBase,
    authority.authorityKey,
    projectId,
  ];
  const read = useQuery({
    queryKey: key,
    retry: false,
    queryFn: () =>
      fetchProjectWorkingConfiguration(authority.apiBase, slug, {
        requestScope: authority,
      }),
  });
  const [review, setReview] = useState<{
    view: ProjectWorkingConfigurationView;
    draft: ProjectWorkingDraft;
    operationId: string;
  } | null>(null);
  const id = useId();
  const { guard, DiscardModal } = useUnsavedGuard(review !== null);
  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!review) throw new Error('Review the discovered defaults first.');
      return applyProjectWorkingConfiguration(
        authority.apiBase,
        slug,
        {
          expectedProjectId: projectId,
          expectedRevision: review.view.current?.revision ?? 0,
          sourceDigest: review.view.sourceDigest,
          operationId: review.operationId,
          draft: {
            ...review.draft,
            checkpoints: review.draft.checkpoints.filter(Boolean),
            evidencePointers: review.draft.evidencePointers.filter(Boolean),
          },
        },
        { requestScope: authority },
      );
    },
    onSuccess: () => {
      setReview(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const view = read.data;
  const change = (update: Partial<ProjectWorkingDraft>) =>
    setReview(
      (current) =>
        current && {
          ...current,
          draft: { ...current.draft, ...update },
          operationId: randomCorrelationId(),
        },
    );
  const begin = (suggested: boolean) => {
    if (!view || view.projectId !== projectId) return;
    setReview({
      view,
      draft: structuredClone(
        suggested
          ? {
              ...view.suggested,
              completionCriteria: view.current?.draft.completionCriteria ?? '',
              checkpoints: view.current?.draft.checkpoints ?? [],
              evidencePointers: view.current?.draft.evidencePointers ?? [],
            }
          : (view.current?.draft ?? view.suggested),
      ),
      operationId: randomCorrelationId(),
    });
    save.reset();
  };
  return (
    <section
      className="project-sources__form project-working-configuration"
      aria-label="Project working configuration"
    >
      <h3>Working configuration</h3>
      <p>
        Review repository rules and validation defaults. Applying them does not
        run commands or authorize setup.
      </p>
      {read.isLoading && <SkeletonBlock />}
      {read.isError && (
        <ErrorState
          variant="compact"
          title={errorText(read.error)}
          action={
            <Button onClick={() => void read.refetch()}>
              Reload configuration
            </Button>
          }
        />
      )}
      {view && (
        <>
          <p role="status">
            {view.current
              ? `Reviewed revision ${view.current.revision}${view.stale ? ' · Repository sources changed' : ''}`
              : 'No reviewed configuration'}
          </p>
          {view.stale && (
            <p>
              Saved edits are retained. Review the changed sources before
              applying a new revision.
            </p>
          )}
          {view.omissions.length > 0 && (
            <details>
              <summary>Discovery gaps ({view.omissions.length})</summary>
              <ul>
                {view.omissions.map((text, index) => (
                  <li key={`${index}:${text}`}>{text}</li>
                ))}
              </ul>
            </details>
          )}
          {view.sources.length === 0 ? (
            <Empty label="Repository instructions not found" />
          ) : (
            <details>
              <summary>Discovered sources ({view.sources.length})</summary>
              <ul>
                {view.sources.map((source) => (
                  <li key={source.path}>
                    <details>
                      <summary>
                        {source.path}
                        {source.shortened ? ' · excerpt' : ''}
                      </summary>
                      <p>
                        Scope: {source.scope || 'Project root'} · SHA256:{' '}
                        {source.sha256}
                      </p>
                      <pre>{source.text}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {review && (
            <>
              <p>
                Rules apply at the root or their selected path scope. Other
                scoped rules remain source pointers.
              </p>
              {review.view.sources
                .filter((source) => source.kind === 'instructions')
                .map((source, index) => {
                  const rule = review.draft.rules.find(
                    (item) => item.sourcePath === source.path,
                  );
                  return (
                    <div key={source.path}>
                      <label className="project-working-configuration__choice">
                        <input
                          type="checkbox"
                          checked={Boolean(rule)}
                          disabled={save.isPending}
                          onChange={(event) =>
                            change({
                              rules: event.target.checked
                                ? [
                                    ...review.draft.rules,
                                    {
                                      sourcePath: source.path,
                                      text: source.text,
                                    },
                                  ]
                                : review.draft.rules.filter(
                                    (item) => item.sourcePath !== source.path,
                                  ),
                            })
                          }
                        />{' '}
                        <span>{source.path}</span>
                      </label>
                      {rule && (
                        <>
                          <label htmlFor={`${id}-rule-${index}`}>
                            Reviewed rule fragment
                          </label>
                          <textarea
                            id={`${id}-rule-${index}`}
                            className="editor-input"
                            rows={4}
                            maxLength={6000}
                            value={rule.text}
                            disabled={save.isPending}
                            onChange={(event) =>
                              change({
                                rules: review.draft.rules.map((item) =>
                                  item.sourcePath === source.path
                                    ? { ...item, text: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              <label htmlFor={`${id}-completion`}>Completion criteria</label>
              <textarea
                id={`${id}-completion`}
                className="editor-input"
                rows={3}
                maxLength={2000}
                value={review.draft.completionCriteria}
                disabled={save.isPending}
                onChange={(event) =>
                  change({ completionCriteria: event.target.value })
                }
              />
              <label htmlFor={`${id}-checkpoints`}>
                Checkpoints, one per line
              </label>
              <textarea
                id={`${id}-checkpoints`}
                className="editor-input"
                rows={3}
                value={review.draft.checkpoints.join('\n')}
                disabled={save.isPending}
                onChange={(event) =>
                  change({ checkpoints: event.target.value.split('\n') })
                }
              />
              <label htmlFor={`${id}-evidence`}>
                Evidence and instruction pointers, one per line
              </label>
              <textarea
                id={`${id}-evidence`}
                className="editor-input"
                rows={3}
                value={review.draft.evidencePointers.join('\n')}
                disabled={save.isPending}
                onChange={(event) =>
                  change({ evidencePointers: event.target.value.split('\n') })
                }
              />
              <fieldset>
                <legend>Declared validation commands</legend>
                {review.view.suggested.validationCommands.map(
                  (command, index) => (
                    <label
                      className="project-working-configuration__choice"
                      key={`${index}:${command.sourcePath}:${command.command}`}
                    >
                      <input
                        type="checkbox"
                        checked={review.draft.validationCommands.some(
                          (item) =>
                            item.sourcePath === command.sourcePath &&
                            item.command === command.command,
                        )}
                        disabled={save.isPending}
                        onChange={(event) =>
                          change({
                            validationCommands: event.target.checked
                              ? [...review.draft.validationCommands, command]
                              : review.draft.validationCommands.filter(
                                  (item) =>
                                    item.sourcePath !== command.sourcePath ||
                                    item.command !== command.command,
                                ),
                          })
                        }
                      />{' '}
                      <span>
                        {command.command} <small>({command.sourcePath})</small>
                      </span>
                    </label>
                  ),
                )}
              </fieldset>
              {save.isError && (
                <ErrorState
                  variant="compact"
                  title={errorText(save.error)}
                  action={
                    <Button onClick={() => void read.refetch()}>
                      Check current configuration
                    </Button>
                  }
                />
              )}
            </>
          )}
          <ActionRow
            overflowLabel="More configuration actions"
            primary={
              review ? (
                <Button
                  variant="primary"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  Apply reviewed defaults
                </Button>
              ) : (
                <Button onClick={() => begin(false)}>
                  Review working configuration
                </Button>
              )
            }
            secondary={
              review ? (
                <Button
                  disabled={save.isPending}
                  onClick={() => guard(() => setReview(null))}
                >
                  Cancel review
                </Button>
              ) : (
                <Button
                  disabled={read.isFetching || save.isPending}
                  onClick={() => void read.refetch()}
                >
                  Discover repository instructions again
                </Button>
              )
            }
            overflow={
              review
                ? [
                    {
                      key: 'discover',
                      label: 'Discover repository instructions again',
                      disabled: read.isFetching || save.isPending,
                      onSelect: () => {
                        void read.refetch();
                      },
                    },
                    {
                      key: 'suggestions',
                      label: 'Review new suggestions',
                      disabled: save.isPending,
                      onSelect: () => guard(() => begin(true)),
                    },
                  ]
                : []
            }
          />
        </>
      )}
      <DiscardModal />
    </section>
  );
}
