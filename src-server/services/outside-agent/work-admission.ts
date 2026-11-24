import { isObjectRecord } from '@kontourai/station-contracts/record-guard';
import type { StationControlSessionTargetReader } from '../../runtime/mcp/station-control-dispatch-scope.js';
import {
  type StationControlScope,
  sameScope,
} from '../../tools/station-control-policy.js';
import type { EventStore } from '../orchestration/event-store.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../orchestration/session-project-identity.js';
import type { OutsideAgentCaller } from './mcp-dispatch.js';

export type OutsideWorkAdmission = 'host' | 'readable' | undefined;

export interface OutsideWorkAdmissionDeps {
  dispatchScope: StationControlSessionTargetReader;
  eventStore: Pick<
    EventStore,
    'hasHostAccessHistory' | 'conversationForSession' | 'conversationSessions'
  >;
  orchestrationService: Pick<
    OrchestrationService,
    'firstStartedMetadataOfThread'
  >;
}

export function createOutsideWorkAdmission(
  deps: OutsideWorkAdmissionDeps,
  caller: OutsideAgentCaller,
) {
  const scope: StationControlScope =
    caller.projectScope.kind === 'project'
      ? { kind: 'project', id: caller.projectScope.projectId }
      : { kind: 'global' };
  const projectId = scope.kind === 'project' ? scope.id : undefined;
  const scopedTarget = (threadId: string) => {
    const target = deps.dispatchScope.sessionTarget(threadId, 'view');
    if (
      !target ||
      target.remote ||
      target.ownerId !== caller.delegatingPrincipalId ||
      !sameScope(scope, target.scope) ||
      (scope.kind === 'project' && target.ownerHoldsAction !== true)
    )
      return undefined;
    const metadata =
      deps.orchestrationService.firstStartedMetadataOfThread(threadId);
    if (
      !metadata ||
      (metadata[SESSION_LOCAL_PROJECT_ID_METADATA_KEY] ?? undefined) !==
        projectId
    )
      return undefined;
    const delegation = metadata.delegation;
    if (
      delegation !== undefined &&
      (!isObjectRecord(delegation) || delegation.environmentKind !== 'current')
    ) {
      return undefined;
    }
    return target;
  };
  const classifyLineage = (
    ids: ReadonlySet<string>,
    canListInInventory: (threadId: string) => boolean,
  ): OutsideWorkAdmission => {
    let host = false;
    for (const id of ids) {
      if (!canListInInventory(id)) return undefined;
      const member = scopedTarget(id);
      if (!member) return undefined;
      host ||= member.host || deps.eventStore.hasHostAccessHistory(id);
    }
    return host ? 'host' : 'readable';
  };
  // The shared projection reads the root's title/prompt and sibling activity.
  const classify = (
    threadId: string,
    cache: Map<string, OutsideWorkAdmission>,
    canListInInventory: (threadId: string) => boolean,
  ): OutsideWorkAdmission => {
    const lineage = deps.eventStore.conversationForSession(threadId);
    const key = lineage
      ? `conversation:${lineage.conversationId}`
      : `session:${threadId}`;
    if (cache.has(key)) return cache.get(key);
    const members = lineage
      ? deps.eventStore.conversationSessions(lineage.conversationId)
      : [];
    const ids = new Set([
      threadId,
      ...members.map((member) => member.sessionId),
    ]);
    const access =
      lineage && !ids.has(lineage.conversationId)
        ? undefined
        : classifyLineage(ids, canListInInventory);
    cache.set(key, access);
    return access;
  };

  return { scope, projectId, classify };
}
