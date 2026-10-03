import type { SkillExperienceDefinitionV1 } from '@kontourai/station-contracts/skill-experience';
import {
  useSkillExperienceInventoryQuery,
  useSkillExperienceSessionQuery,
} from '@kontourai/station-sdk';
import {
  skillExperienceAttachmentInputs,
  skillExperienceInputDefaults,
  skillExperienceInputErrors,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import { useId, useState } from 'react';
import {
  useActiveChatActions,
  useActiveChatSelector,
} from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { ChatSession } from '../../types';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonList } from '../state';
import { SkillExperienceForm } from './SkillExperienceForm';
import './skill-experiences.css';

const loadRichExperiencePane = () =>
  import('./RichExperiencePane').then((module) => ({
    default: module.RichExperiencePane,
  }));

function RecordedAttachmentRoles({
  definition,
  roles,
}: {
  definition: SkillExperienceDefinitionV1;
  roles: Record<string, number[]> | undefined;
}) {
  if (!roles || !Object.keys(roles).length) return null;
  return (
    <dl className="skill-experience-panel__outputs">
      {Object.entries(roles).map(([id, indices]) => (
        <div key={id}>
          <dt>
            {definition.inputs.find((input) => input.id === id)?.label ?? id}
          </dt>
          <dd>
            {indices.length
              ? `Original-turn file positions: ${indices.map((index) => index + 1).join(', ')}`
              : 'Unassigned'}{' '}
            (content stays in the canonical conversation)
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SkillExperiencePanel({ session }: { session: ChatSession }) {
  const { updateChat } = useActiveChatActions();
  const [richOpened, setRichOpened] = useState(false);
  const presentationId = useId();
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
  const attachmentChoices = session.attachments.length
    ? session.attachments.map((file) => ({ id: file.id, name: file.name }))
    : (attachmentStages?.map((file) => ({
        id: file.clientAttachmentId,
        name: file.name,
      })) ?? []);
  const errors = draft
    ? skillExperienceInputErrors(
        draft.definition,
        draft.start.inputs,
        attachmentChoices.length,
        skillExperienceAttachmentInputs(
          draft.definition.inputs
            .filter((input) => input.kind === 'attachments')
            .map((input) => input.id),
          attachmentChoices.map((file) => file.id),
          draft.attachmentAssignments,
        ),
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
      <fieldset className="skill-experience-panel__presentation">
        <legend>Presentation</legend>
        {[
          ...(definition?.presentation.modes ?? ['guided', 'alongside']),
          'chat' as const,
        ].map((presentation) => (
          <label className="skill-experience-panel__mode" key={presentation}>
            <input
              type="radio"
              name={presentationId}
              value={presentation}
              checked={mode === presentation}
              onChange={() =>
                updateChat(session.id, { skillExperienceMode: presentation })
              }
            />
            {presentation === 'guided'
              ? 'Guided'
              : presentation === 'alongside'
                ? 'Alongside chat'
                : 'Chat'}
          </label>
        ))}
      </fieldset>
      {session.skillExperienceDraftInvalid && (
        <p role="alert">
          The saved visual skill selection could not be read. Remove it
          explicitly before sending an ordinary chat.
        </p>
      )}
      {!draft &&
        invocation &&
        invocation.availability.status !== 'available' && (
          <p role="alert">
            {invocation.availability.message ??
              (invocation.snapshot === null
                ? 'The recorded stage snapshot is unavailable. Its canonical conversation remains below.'
                : 'This source is unavailable. The recorded snapshot is retained.')}
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
                attachmentChoices={attachmentChoices}
                attachmentAssignments={draft.attachmentAssignments}
                onAttachmentsChange={(attachmentAssignments) =>
                  updateChat(session.id, {
                    skillExperienceDraft: {
                      ...draft,
                      attachmentAssignments,
                    },
                  })
                }
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
              {view.error && (
                <p role="alert">The recorded skill could not be loaded.</p>
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
                {snapshot && (
                  <RecordedAttachmentRoles
                    definition={snapshot.definition}
                    roles={snapshot.attachmentInputs}
                  />
                )}
              </details>
              <p>
                Declared outputs:{' '}
                {snapshot?.definition.outputs
                  .map((output) => output.label)
                  .join(', ')}
                . Results appear in the conversation and its artifact controls
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
                  <label className="skill-experience-form__field">
                    Prepare a declared next stage
                    <select
                      value=""
                      disabled={
                        stages.isFetching ||
                        Boolean(stages.error) ||
                        !skillExperiencesCanExecute(stages.data) ||
                        invocation?.availability.status !== 'available' ||
                        !authority?.isCurrent() ||
                        status !== 'verified' ||
                        !namespace
                      }
                      onChange={(event) => {
                        const target = snapshot.definition.transitions?.find(
                          (stage) => stage.experienceId === event.target.value,
                        );
                        const selected = stages.data?.experiences.find(
                          (entry) =>
                            target &&
                            entry.definition.id === target.experienceId &&
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
                      <option value="">Choose a stage</option>
                      {snapshot.definition.transitions.map((stage) => (
                        <option
                          key={stage.experienceId}
                          value={stage.experienceId}
                        >
                          {stage.label}
                        </option>
                      ))}
                    </select>
                  </label>
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
                pending={
                  <SkeletonList count={2} label="Loading declared rich view" />
                }
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
        <SkeletonList count={1} label="Loading recorded skill" />
      )}
      {view.error && (
        <Button onClick={() => void view.refetch()}>
          Retry recorded skill
        </Button>
      )}
      {!!view.data?.history.length && (
        <details className="skill-experience-panel__history">
          <summary>Previous stages</summary>
          {historyView.isFetching && (
            <SkeletonList count={2} label="Loading stages" />
          )}
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
              {row.snapshot && (
                <RecordedAttachmentRoles
                  definition={row.snapshot.definition}
                  roles={row.snapshot.attachmentInputs}
                />
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
