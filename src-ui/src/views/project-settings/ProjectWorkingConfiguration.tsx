import {
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
import { SettingsGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import './ProjectWorkingConfiguration.css';

export function ProjectWorkingConfiguration({
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
  const [advanced, setAdvanced] = useState(false);
  const [sourcePath, setSourcePath] = useState('');
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
  const selectedSource = review?.view.sources.find(
    (source) => source.path === sourcePath,
  );
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
    setAdvanced(false);
    setSourcePath('');
    save.reset();
  };
  return (
    <section
      className="project-sources__form project-working-configuration"
      aria-label="Project working configuration"
    >
      <h3>Working configuration</h3>
      <p>Choose the repository instructions and checks agents should use.</p>
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
              : `Instructions (${view.suggested.rules.length}) · Checks (${view.suggested.validationCommands.length})`}
          </p>
          {view.stale && (
            <p>
              Saved edits are retained. Review the changed sources before
              applying a new revision.
            </p>
          )}
          {view.omissions.length > 0 && (
            <ul className="project-working-configuration__omissions">
              {view.omissions.map((text, index) => (
                <li key={`${index}:${text}`}>{text}</li>
              ))}
            </ul>
          )}
          {view.sources.length === 0 && (
            <Empty label="Repository instructions not found" />
          )}
          {review && (
            <>
              <fieldset className="project-working-configuration__checklist">
                <legend>Instruction files</legend>
                {review.view.sources
                  .filter((source) => source.kind === 'instructions')
                  .map((source) => {
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
                          <p className="project-working-configuration__excerpt">
                            {rule.text}
                          </p>
                        )}
                      </div>
                    );
                  })}
              </fieldset>

              <fieldset className="project-working-configuration__checklist">
                <legend>Checks</legend>
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
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={advanced}
                aria-controls={`${id}-advanced`}
                onClick={() => setAdvanced(!advanced)}
              >
                <SettingsGlyph /> Advanced defaults
              </Button>
              <div
                id={`${id}-advanced`}
                className="project-working-configuration__advanced"
                hidden={!advanced}
              >
                {review.view.sources.length > 0 && (
                  <label>
                    Discovered source
                    <select
                      value={sourcePath}
                      onChange={(event) => setSourcePath(event.target.value)}
                    >
                      <option value="">Choose a source</option>
                      {review.view.sources.map((source) => (
                        <option key={source.path} value={source.path}>
                          {source.path}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selectedSource && (
                  <div>
                    <p>
                      {selectedSource.scope || 'Project root'}
                      {selectedSource.shortened ? ' · Excerpt' : ''}
                    </p>
                    <pre>{selectedSource.text}</pre>
                  </div>
                )}
                {review.draft.rules.map((rule, index) => (
                  <label key={rule.sourcePath}>
                    {rule.sourcePath}
                    <textarea
                      className="editor-input"
                      rows={4}
                      maxLength={6000}
                      value={rule.text}
                      disabled={save.isPending}
                      onChange={(event) =>
                        change({
                          rules: review.draft.rules.map((item, itemIndex) =>
                            index === itemIndex
                              ? { ...item, text: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
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
              </div>
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
            className="project-working-configuration__actions"
            overflowLabel="More configuration actions"
            primary={
              review ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  Apply defaults
                </Button>
              ) : (
                <Button size="sm" onClick={() => begin(false)}>
                  Review defaults
                </Button>
              )
            }
            secondary={
              review ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={save.isPending}
                  onClick={() => guard(() => setReview(null))}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={read.isFetching || save.isPending}
                  onClick={() => void read.refetch()}
                >
                  Refresh discovery
                </Button>
              )
            }
            overflow={
              review
                ? [
                    {
                      key: 'discover',
                      label: 'Refresh discovery',
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
