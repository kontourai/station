import type {
  PersonalBoardDefinition,
  PersonalBoardDocument,
} from '@kontourai/station-contracts/personal-board';
import {
  usePersonalBoardQuery,
  useSavePersonalBoardMutation,
} from '@kontourai/station-sdk';
import { personalBoardDefinitionSchema } from '@kontourai/station-sdk/personal-board';
import { type ReactNode, useState } from 'react';
import { Button } from '../../components/Button';
import { PageFrame, PageFrameActions } from '../../components/page-frame';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { requestProjectChat } from '../../lib/projectChatEvents';
import { BoardEditor } from './BoardEditor';
import { BoardSetup } from './BoardSetup';
import { BoardToolbar } from './BoardToolbar';

import { PersonalBoardDashboard } from './PersonalBoardDashboard';

export function PersonalBoardWorkspace({
  slug,
  children,
}: {
  slug: string;
  children?: ReactNode;
}) {
  const scope = useHostRequestAuthorityScope();
  if (!scope)
    return <ErrorState title="Connect to your Station to open this Board" />;
  return (
    <BoardWorkspace
      key={`${scope.authorityKey}:${slug}`}
      slug={slug}
      scope={scope}
    >
      {children}
    </BoardWorkspace>
  );
}

function BoardWorkspace({
  slug,
  scope,
  children,
}: {
  slug: string;
  children?: ReactNode;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const query = usePersonalBoardQuery(slug, scope);
  const save = useSavePersonalBoardMutation(slug, scope);
  const projects = useScopedProjectsQuery();
  const [edit, setEdit] = useState<{
    definition: PersonalBoardDefinition;
    revision: string;
    original: string;
  } | null>(null);
  const [preview, setPreview] = useState(false);
  const [chatError, setChatError] = useState(false);
  const dirty = !!edit && JSON.stringify(edit.definition) !== edit.original;
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  const begin = (
    document: PersonalBoardDocument,
    definition: PersonalBoardDefinition,
    asPreview = false,
  ) => {
    save.reset();
    setEdit({
      definition,
      revision: document.revision,
      original: JSON.stringify(asPreview ? definition : document.definition),
    });
    setPreview(asPreview);
  };
  const chat = () => {
    if (!query.data) return;
    const message = `Help me ${query.data.definition ? 'revise' : 'build'} my Personal Board ${JSON.stringify(query.data.layout.name)} (slug: ${JSON.stringify(slug)}). Ask what I want to see. Use get_personal_board, then propose_personal_board with its current revision. Keep existing sections unless I ask to change them. Save a proposal for me to preview at /boards/${encodeURIComponent(slug)}; do not publish it. These are Personal Boards, not a conversation or Task board face.`;
    setChatError(
      !requestProjectChat({
        source: 'personal-board',
        authorityKey: scope.authorityKey,
        projectSlug: null,
        composerDraft: {
          title: 'Build your Personal Board',
          description:
            'Choose an Agent with Station tools, then send your request.',
          label: query.data.layout.name,
          detail: 'Personal dashboard',
          message,
        },
      }),
    );
  };
  if (query.isError && !query.data)
    return (
      <ErrorState
        title="Could not open this Board"
        description={query.error.message}
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
      />
    );
  if (!query.data)
    return <SkeletonBlock count={3} label="Loading Personal Board" />;
  const document = query.data;
  const validation = edit
    ? personalBoardDefinitionSchema.safeParse(edit.definition)
    : null;
  const changed = !!edit && document.revision !== edit.revision;
  const update = (definition: PersonalBoardDefinition) =>
    setEdit((current) => (current ? { ...current, definition } : null));
  const publish = () => {
    if (!edit || !validation?.success || changed || !scope.isCurrent()) return;
    save.mutate(
      { revision: edit.revision, definition: validation.data },
      {
        onSuccess: () => {
          if (scope.isCurrent()) {
            setEdit(null);
            setPreview(false);
          }
        },
      },
    );
  };
  return (
    <div className="personal-board-workspace">
      <PageFrame
        routeIdentity={`personal-board:${slug}`}
        spec={{
          title:
            edit?.definition.name ??
            document.definition?.name ??
            'Build your Board',
          eyebrow: 'Personal Board',
          subtitle:
            edit?.definition.description ??
            document.definition?.description ??
            'Start with a dashboard, or describe what you want in chat. Live sections read current data from your Station.',
          flush: true,
        }}
      >
        <PageFrameActions>
          <BoardToolbar
            edit={
              edit
                ? {
                    preview,
                    valid: validation?.success === true,
                    changed,
                    pending: save.isPending,
                    proposal: !!document.proposal,
                  }
                : null
            }
            saved={!!document.definition}
            actions={{
              cancel: () =>
                guard(() => {
                  setEdit(null);
                  setPreview(false);
                  save.reset();
                }),
              preview: () => setPreview(!preview),
              save: publish,
              refresh: () => void query.refetch(),
              chat,
              edit: () => {
                if (document.definition) begin(document, document.definition);
              },
            }}
          />
        </PageFrameActions>
        {query.isError && (
          <p role="alert">
            Could not refresh this Board. Your draft is preserved.{' '}
            <Button onClick={() => void query.refetch()}>Retry refresh</Button>
          </p>
        )}
        {chatError && (
          <p role="alert">
            Chat is not available in this region. Open a chat and ask an Agent
            with Station tools to edit this Personal Board at /boards/{slug}.
          </p>
        )}
        {save.isError && (
          <p role="alert">
            {save.error.message} Your draft is still here. Refresh the Board to
            inspect what was saved before trying again.
          </p>
        )}
        {changed && (
          <div className="personal-board__notice" role="status">
            This Board changed while you were editing. Your draft is preserved.
            <Button
              onClick={() =>
                guard(() => {
                  setEdit(null);
                  setPreview(false);
                  save.reset();
                  void query.refetch();
                })
              }
            >
              Reload current Board
            </Button>
          </div>
        )}
        {document.proposal && !edit && (
          <section
            className="personal-board__proposal"
            aria-label="Board proposal"
          >
            <div>
              <span className="personal-board__eyebrow">Ready to review</span>
              <h2>{document.proposal.name}</h2>
              <p>
                {document.proposal.sections.length} sections ·{' '}
                {document.proposal.sections
                  .map((section) => section.title)
                  .join(', ')}
              </p>
              <p>
                Your saved Board stays in place until you apply this proposal.
              </p>
            </div>
            <div>
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({ revision: document.revision, dismiss: true })
                }
              >
                Dismiss proposal
              </Button>
              <Button
                variant="primary"
                onClick={() => begin(document, document.proposal!, true)}
              >
                Review proposal
              </Button>
            </div>
          </section>
        )}
        {!document.definition && !document.proposal && !edit && (
          <BoardSetup
            name={document.layout.name}
            projects={projects.data ?? []}
            onChoose={(definition) => begin(document, definition)}
          />
        )}
        {edit && !preview && (
          <BoardEditor
            definition={edit.definition}
            update={update}
            pending={save.isPending}
            projects={projects.data ?? []}
            validationError={
              validation && !validation.success
                ? validation.error.issues[0]?.message
                : undefined
            }
          />
        )}
        {(edit && preview
          ? edit.definition
          : !edit
            ? document.definition
            : null) && (
          <PersonalBoardDashboard
            boardSlug={slug}
            showHeader={false}
            definition={
              (edit && preview ? edit.definition : document.definition)!
            }
          />
        )}
      </PageFrame>
      {!edit && children}
      <DiscardModal />
    </div>
  );
}
