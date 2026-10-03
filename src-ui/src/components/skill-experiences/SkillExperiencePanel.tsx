import {
  useSkillExperienceInventoryQuery,
  useSkillExperienceSessionQuery,
} from '@kontourai/station-sdk';
import {
  skillExperienceInputDefaults,
  skillExperienceInputErrors,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import { useState } from 'react';
import {
  useActiveChatActions,
  useActiveChatSelector,
} from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { ChatSession } from '../../types';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import { SkillExperienceForm } from './SkillExperienceForm';
import './skill-experiences.css';

const loadRichExperiencePane = () =>
  import('./RichExperiencePane').then((module) => ({
    default: module.RichExperiencePane,
  }));

export function SkillExperiencePanel({ session }: { session: ChatSession }) {
  const { updateChat } = useActiveChatActions();
  const [richOpened, setRichOpened] = useState(false);
  const authority = useHostRequestAuthorityScope();
  const { namespace, status } = useAuthorityPersistence();
  const threadId = session.currentSessionId ?? session.conversationId;
  const view = useSkillExperienceSessionQuery(threadId, {
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const [historyPage, setHistoryPage] = useState<{
    threadId: string | undefined;
    cursor?: string;
  } | null>(null);
  const historyCursor =
    historyPage?.threadId === threadId ? historyPage?.cursor : undefined;
  const olderView = useSkillExperienceSessionQuery(
    threadId,
    { enabled: Boolean(historyCursor) },
    historyCursor,
  );
  const historyView = historyCursor ? olderView : view;
  const attachmentStages = useActiveChatSelector(
    session.id,
    (state) => state?.attachmentStages,
  );
  const draft = session.skillExperienceDraft;
  const invocation = view.data?.current;
  const snapshot = invocation?.snapshot;
  const definition = draft?.definition ?? snapshot?.definition;
  const stages = useSkillExperienceInventoryQuery({
    enabled: Boolean(snapshot?.definition.transitions?.length),
    refetchOnMount: 'always',
  });

  const mode =
    session.skillExperienceMode ??
    definition?.presentation.defaultMode ??
    'guided';
  const errors = draft
    ? skillExperienceInputErrors(
        draft.definition,
        draft.start.inputs,
        Math.max(session.attachments.length, attachmentStages?.length ?? 0),
      )
    : {};
  if (
    !draft &&
    !session.skillExperienceDraftInvalid &&
    !session.skillExperienceActive &&
    !invocation
  )
    return null;
  return (
    <section
      className="skill-experience-panel"
      aria-label="Visual skill"
      data-presentation={mode}
    >
      <h2>{definition?.title ?? 'Visual skill'}</h2>
      <fieldset className="skill-experience-panel__actions">
        <legend>Presentation</legend>
        {[
          ...(definition?.presentation.modes ?? ['guided', 'alongside']),
          'chat' as const,
        ].map((presentation) => (
          <Button
            key={presentation}
            aria-pressed={mode === presentation}
            onClick={() =>
              updateChat(session.id, { skillExperienceMode: presentation })
            }
          >
            {presentation === 'guided'
              ? 'Guided'
              : presentation === 'alongside'
                ? 'Alongside chat'
                : 'Chat'}
          </Button>
        ))}
      </fieldset>
      {session.skillExperienceDraftInvalid && (
        <p role="alert">
          The saved visual skill selection could not be read. Remove it
          explicitly before sending an ordinary chat.
        </p>
      )}
      {definition && mode !== 'chat' && (
        <>
          <p>{definition.purpose}</p>
          <p className="skill-experience-panel__source">
            {(draft?.start.identity ?? snapshot?.identity)?.pluginId} ·{' '}
            {(draft?.start.identity ?? snapshot?.identity)?.pluginVersion}
          </p>
          {draft ? (
            <>
              <SkillExperienceForm
                definition={definition}
                values={draft.start.inputs}
                errors={errors}
                onChange={(inputs) =>
                  updateChat(session.id, {
                    skillExperienceDraft: {
                      ...draft,
                      start: { ...draft.start, inputs },
                    },
                  })
                }
              />
              <p>
                Review these inputs, attach required files in the composer, then
                send to start. Questions, approvals and Stop use the
                conversation controls below.
              </p>
            </>
          ) : (
            <>
              {view.error ? (
                <p role="alert">The recorded skill could not be loaded.</p>
              ) : (
                invocation?.availability.status !== 'available' && (
                  <p role="alert">
                    {invocation?.availability.message ??
                      'This source is unavailable. The recorded snapshot is retained.'}
                  </p>
                )
              )}
              <details>
                <summary>Inputs used for this stage</summary>
                <dl>
                  {Object.entries(snapshot?.inputs ?? {}).map(
                    ([key, value]) => (
                      <div key={key}>
                        <dt>
                          {definition.inputs.find((input) => input.id === key)
                            ?.label ?? key}
                        </dt>
                        <dd>{value}</dd>
                      </div>
                    ),
                  )}
                </dl>
              </details>
              <p>
                Declared outputs:{' '}
                {definition.outputs.map((output) => output.label).join(', ')}.
                Results appear in the conversation and its artifact controls
                when the Agent produces them.
              </p>
              <Button
                disabled={
                  invocation?.availability.status !== 'available' ||
                  !authority?.isCurrent() ||
                  status !== 'verified' ||
                  !namespace
                }
                onClick={() => {
                  if (
                    !snapshot ||
                    !invocation ||
                    !authority?.isCurrent() ||
                    !namespace
                  )
                    return;
                  updateChat(session.id, {
                    input:
                      session.input || `Continue ${snapshot.definition.title}.`,
                    skillExperienceDraft: {
                      namespace,
                      apiBase: authority.apiBase,
                      definition: snapshot.definition,
                      start: {
                        identity: snapshot.identity,
                        inputs: skillExperienceInputDefaults(
                          snapshot.definition,
                        ),
                        expectedPreviousInvocationEventId: invocation.eventId,
                      },
                    },
                  });
                }}
              >
                Prepare another stage in this conversation
              </Button>
              {!!snapshot?.definition.transitions?.length && (
                <div className="skill-experience-panel__actions">
                  {stages.error && (
                    <p role="alert">
                      The available stages could not be checked.{' '}
                      <Button onClick={() => void stages.refetch()}>
                        Retry stages
                      </Button>
                    </p>
                  )}
                  {snapshot.definition.transitions.map((stage) => {
                    const selected = stages.data?.experiences.find(
                      (entry) =>
                        entry.definition.id === stage.experienceId &&
                        entry.identity.pluginId ===
                          snapshot.identity.pluginId &&
                        entry.identity.pluginVersion ===
                          snapshot.identity.pluginVersion &&
                        entry.identity.incarnation ===
                          snapshot.identity.incarnation &&
                        entry.identity.materialization ===
                          snapshot.identity.materialization &&
                        entry.identity.contentDigest ===
                          snapshot.identity.contentDigest,
                    );
                    return (
                      <Button
                        key={stage.experienceId}
                        disabled={
                          !selected ||
                          !skillExperiencesCanExecute(stages.data) ||
                          stages.isFetching ||
                          Boolean(stages.error) ||
                          invocation?.availability.status !== 'available' ||
                          !authority?.isCurrent() ||
                          status !== 'verified' ||
                          !namespace
                        }
                        onClick={() => {
                          if (
                            !selected ||
                            !invocation ||
                            !authority?.isCurrent() ||
                            !namespace
                          )
                            return;
                          updateChat(session.id, {
                            input:
                              session.input ||
                              `Continue ${selected.definition.title}.`,
                            skillExperienceMode:
                              selected.definition.presentation.defaultMode,
                            skillExperienceDraft: {
                              namespace,
                              apiBase: authority.apiBase,
                              definition: selected.definition,
                              start: {
                                identity: selected.identity,
                                inputs: skillExperienceInputDefaults(
                                  selected.definition,
                                ),
                                expectedPreviousInvocationEventId:
                                  invocation.eventId,
                              },
                            },
                          });
                        }}
                      >
                        Prepare {stage.label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
      {snapshot?.definition.presentation.richView && invocation && (
        <>
          <Button onClick={() => setRichOpened(true)}>
            Open declared rich view
          </Button>
          {richOpened && (
            <div hidden={mode === 'chat'}>
              <LazyBoundary
                load={loadRichExperiencePane}
                componentProps={{
                  session,
                  invocation,
                  active: mode !== 'chat',
                }}
                pending={<p role="status">Loading declared rich view…</p>}
              />
            </div>
          )}
        </>
      )}
      {(draft || session.skillExperienceDraftInvalid) && (
        <Button
          onClick={() =>
            updateChat(session.id, {
              skillExperienceDraft: undefined,
              skillExperienceDraftInvalid: undefined,
            })
          }
        >
          Remove unsent visual skill
        </Button>
      )}
      {!draft && view.isPending && threadId && (
        <p role="status">Loading recorded skill…</p>
      )}
      {view.error && (
        <Button onClick={() => void view.refetch()}>
          Retry recorded skill
        </Button>
      )}
      {!!view.data?.history.length && (
        <details className="skill-experience-panel__history">
          <summary>Previous stages</summary>
          {historyView.isFetching && <p role="status">Loading stages…</p>}
          {historyView.error && (
            <p role="alert">
              These stages could not be loaded.{' '}
              <Button onClick={() => void historyView.refetch()}>Retry</Button>
            </p>
          )}
          {historyView.data?.history.map((row) => (
            <details key={row.eventId}>
              <summary>
                {row.snapshot?.definition.title ?? 'Snapshot unavailable'} ·{' '}
                {row.availability.status}
              </summary>
              <p>{row.availability.message}</p>
              {row.snapshot && (
                <dl>
                  {Object.entries(row.snapshot.inputs).map(([id, value]) => (
                    <div key={id}>
                      <dt>
                        {row.snapshot?.definition.inputs.find(
                          (input) => input.id === id,
                        )?.label ?? id}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </details>
          ))}
          {historyView.data?.hasMore && historyView.data.nextCursor && (
            <Button
              disabled={historyView.isFetching}
              onClick={() =>
                setHistoryPage({
                  threadId,
                  cursor: historyView.data?.nextCursor,
                })
              }
            >
              Older stages
            </Button>
          )}
          {historyCursor && (
            <Button onClick={() => setHistoryPage(null)}>Latest stages</Button>
          )}
        </details>
      )}
    </section>
  );
}
