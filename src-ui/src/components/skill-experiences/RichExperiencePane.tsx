import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import type { SkillExperienceSessionInvocationV1 } from '@kontourai/station-contracts/skill-experience';
import type { PaneSkillExperienceHost } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { useInvalidateQuery } from '@kontourai/station-sdk';
import {
  fetchSkillExperienceInventory,
  fetchSkillExperienceSession,
  getOrchestrationSessionEventWindow,
  respondToRequest,
} from '@kontourai/station-sdk/client';
import { harnessQuestionnaireFromInputRequest } from '@kontourai/station-shared/harness-questions';
import {
  harnessAnswersToInputContent,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import {
  readSkillExperienceStartInput,
  sameSkillExperienceIdentity,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { pluginRegistry } from '../../core/PluginRegistry';
import { unansweredApprovalRequests } from '../../hooks/orchestration/pendingRequestRows';
import type { ChatSession } from '../../types';
import { useResolvedWorkspacePaneCatalog } from '../../workspace-panes/resolvedWorkspacePaneCatalog';
import { SkeletonList } from '../state';

export function RichExperiencePane({
  session,
  invocation,
  active,
}: {
  session: ChatSession;
  invocation: SkillExperienceSessionInvocationV1;
  active: boolean;
}) {
  const { updateChat } = useActiveChatActions();
  const invalidate = useInvalidateQuery();
  const authority = useHostRequestAuthorityScope();
  const { namespace, status } = useAuthorityPersistence();
  const catalog = useResolvedWorkspacePaneCatalog(session.projectSlug ?? '');
  const registryStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(
    () => () => {
      activeRef.current = false;
    },
    [],
  );
  const snapshot = invocation.snapshot;
  const descriptorId = snapshot?.definition.presentation.richView?.descriptorId;
  const entry = catalog.entries.find(
    (candidate) => candidate.descriptor.id === descriptorId,
  );
  const contribution = entry?.instance?.boundContext?.contribution;
  const renderer = entry?.descriptor.renderer;
  const sameOwner = Boolean(
    snapshot &&
      entry?.availability.state === 'available' &&
      entry.selectedRenderer?.source === 'primary' &&
      entry.selectedRenderer.renderer.kind === 'plugin-component' &&
      entry.selectedRenderer.rendererId === entry.descriptor.rendererId &&
      renderer?.kind === 'plugin-component' &&
      entry.selectedRenderer.renderer.name === renderer.name &&
      contribution &&
      contribution.version === snapshot.identity.pluginVersion &&
      contribution.sourceIdentity.id === snapshot.identity.pluginId &&
      contribution.provenance.pluginId === snapshot.identity.pluginId &&
      entry?.descriptor.provenance.pluginId === snapshot.identity.pluginId &&
      (!entry?.instance?.boundContext?.sessionId ||
        entry.instance.boundContext.sessionId === invocation.threadId),
  );

  const host = useMemo<PaneSkillExperienceHost | undefined>(() => {
    if (!snapshot || !authority || !namespace || status !== 'verified')
      return undefined;
    const assertCurrent = () => {
      if (!activeRef.current || !authority.isCurrent())
        throw new Error(
          'This visual skill view is no longer active on its Station.',
        );
      const current = activeChatsStore.getSnapshot()[session.id];
      if (
        (current?.currentSessionId ?? current?.conversationId) !==
        invocation.threadId
      )
        throw new Error(
          'This conversation has moved to a different execution session.',
        );
    };
    const readCurrent = async () => {
      assertCurrent();
      const view = await fetchSkillExperienceSession(
        authority.apiBase,
        invocation.threadId,
        undefined,
        {
          requestScope: authority,
          expectedSkillExperience: {
            identity: snapshot.identity,
            eventId: invocation.eventId,
          },
        },
      );
      assertCurrent();
      if (
        view.current?.eventId !== invocation.eventId ||
        !view.current.snapshot ||
        view.current.availability.status !== 'available' ||
        !sameSkillExperienceIdentity(
          view.current.snapshot.identity,
          snapshot.identity,
        )
      )
        throw new Error(
          'This recorded stage or its source changed. Review it in the conversation.',
        );
      return view;
    };
    const readQuestions = async () => {
      const events =
        await getOrchestrationSessionEventWindow<OrchestrationSessionEventWindow>(
          authority.apiBase,
          invocation.threadId,
          { turnLimit: 1 },
          { requestScope: authority },
        );
      await readCurrent();
      return unansweredApprovalRequests(
        [],
        events.events.map((row) => row.event),
      ).flatMap((request) => {
        // #3390: the rich view's published protocol still speaks the
        // pre-#3390 questionnaire shape, so only an engine's own question
        // that the shape can express is offered, and never a private one.
        const questionnaire =
          request.inputRequest?.source.startsWith('harness:') &&
          request.approvalThreadId === invocation.threadId
            ? harnessQuestionnaireFromInputRequest(request.inputRequest)
            : null;
        return questionnaire &&
          !questionnaire.questions.some((question) => question.secret)
          ? [{ ...request, questionnaire }]
          : [];
      });
    };
    return {
      read: async () => {
        const view = await readCurrent();
        const questions = await readQuestions();
        const pendingQuestions = questions.slice(0, 32).map((request) => ({
          requestId: request.approvalId,
          requestEventId: request.approvalEventId,
          questionnaire: request.questionnaire,
        }));
        return {
          viewJson: JSON.stringify({
            ...view,
            pendingQuestions,
            questionsTruncated: questions.length > pendingQuestions.length,
          }),
        };
      },
      answer: async (input) => {
        await readCurrent();
        const request = (await readQuestions()).find(
          (candidate) =>
            candidate.approvalId === input.requestId &&
            candidate.approvalEventId === input.requestEventId,
        );
        if (!request?.questionnaire)
          throw new Error(
            'This is not a current question that the rich view can answer. Use the canonical conversation controls.',
          );
        // Translated from the rich view's answer shape and checked by the
        // one input-request validator; the server checks it again.
        const content = validateInputRequestContent(
          request.inputRequest!,
          harnessAnswersToInputContent(request.inputRequest!, input.answers),
        );
        await respondToRequest(
          authority.apiBase,
          {
            threadId: invocation.threadId,
            requestId: input.requestId,
            expectedRequestEventId: input.requestEventId,
            expectedSkillExperience: {
              identity: snapshot.identity,
              eventId: invocation.eventId,
            },
            decision: 'accept',
            content,
          },
          { requestScope: authority },
        );
        invalidate(['skills', 'experiences', 'session']);
      },
      continue: async (input) => {
        await readCurrent();
        const inventory = await fetchSkillExperienceInventory(
          authority.apiBase,
          { requestScope: authority },
        );
        assertCurrent();
        if (!skillExperiencesCanExecute(inventory))
          throw new Error(
            'This Station cannot prepare an executable visual skill stage.',
          );
        const selected = inventory.experiences.find(
          (candidate) =>
            candidate.definition.id === input.experienceId &&
            candidate.identity.pluginId === snapshot.identity.pluginId &&
            candidate.identity.pluginVersion ===
              snapshot.identity.pluginVersion &&
            candidate.identity.incarnation === snapshot.identity.incarnation &&
            candidate.identity.materialization ===
              snapshot.identity.materialization &&
            candidate.identity.contentDigest ===
              snapshot.identity.contentDigest,
        );
        if (
          !selected ||
          (selected.definition.id !== snapshot.definition.id &&
            !snapshot.definition.transitions?.some(
              (stage) => stage.experienceId === selected.definition.id,
            ))
        )
          throw new Error('This stage is not declared by the current source.');
        const start = readSkillExperienceStartInput({
          identity: selected.identity,
          inputs: input.inputs,
          expectedPreviousInvocationEventId: invocation.eventId,
        });
        if (!start) throw new Error('The stage inputs are unsupported.');
        const current = activeChatsStore.getSnapshot()[session.id];
        if (
          current?.skillExperienceDraft ||
          current?.skillExperienceDraftInvalid
        )
          throw new Error(
            'Review or remove the existing unsent visual skill before preparing another.',
          );
        updateChat(session.id, {
          skillExperienceDraft: {
            namespace,
            apiBase: authority.apiBase,
            definition: selected.definition,
            start,
          },
          input: current?.input || `Continue ${selected.definition.title}.`,
        });
      },
    };
  }, [
    authority,
    namespace,
    status,
    snapshot,
    invocation.eventId,
    invocation.threadId,
    session.id,
    updateChat,
    invalidate,
  ]);
  const Component = useMemo(() => {
    void registryStatus;
    if (
      !sameOwner ||
      !host ||
      !snapshot ||
      registryStatus.failedPluginNames.includes(snapshot.identity.pluginId) ||
      renderer?.kind !== 'plugin-component'
    )
      return null;
    return pluginRegistry.getTrustedLayout(renderer.name, contribution, {
      skillExperience: host,
      skillExperienceIdentity: snapshot.identity,
    });
  }, [sameOwner, host, snapshot, renderer, contribution, registryStatus]);
  if (!session.projectSlug)
    return (
      <p role="status">
        The declared rich view needs a workspace pane occurrence. The
        conversation controls remain available.
      </p>
    );
  if (catalog.isPending)
    return <SkeletonList count={2} label="Checking the declared rich view" />;
  if (!Component)
    return (
      <p role="alert">
        The declared rich view is unavailable for this source, workspace or
        host. Continue using the guided conversation controls.
      </p>
    );
  return <Component />;
}
