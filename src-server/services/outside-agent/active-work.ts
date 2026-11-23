import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isObjectRecord } from '@kontourai/station-contracts/record-guard';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { ProtocolError } from '@modelcontextprotocol/server';
import {
  ACTIVE_WORK_DEFAULT_MINUTES,
  WORK_DISCOVERY_DEFAULT_LIMIT,
} from '../../routes/chat/work-discovery-limits.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import {
  type StationControlScope,
  sameScope,
} from '../../tools/station-control-policy.js';
import type { ActiveWorkInput } from '../../tools/station-control-work-discovery-tools.js';
import type { EventStore } from '../orchestration/event-store.js';
import {
  createSessionActivityReader,
  decodeActivityCursor,
  type SessionActivityReaderDeps,
} from '../orchestration/session-activity-reader.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../orchestration/session-project-identity.js';
import type { OutsideAgentCaller } from './mcp-dispatch.js';

const MAX_CANDIDATES = 2_000;

export interface OutsideActiveWorkDeps extends SessionActivityReaderDeps {
  eventStore: SessionActivityReaderDeps['eventStore'] &
    Pick<
      EventStore,
      | 'iterateOwnedActiveWorkCandidates'
      | 'hasHostAccessHistory'
      | 'conversationForSession'
      | 'conversationSessions'
    >;
  dispatchScope: Pick<StationControlDispatchScope, 'target'>;
}

/** Read through the existing activity projection using a live grant, without a Session caller. */
export function createOutsideActiveWorkReader(
  deps: OutsideActiveWorkDeps,
  now: () => number,
) {
  const activity = createSessionActivityReader(deps);
  const cursorKey = randomBytes(32);

  return async function listActiveWork(
    caller: OutsideAgentCaller,
    input: ActiveWorkInput,
    assertCurrent: () => void,
  ) {
    const scope: StationControlScope =
      caller.projectScope.kind === 'project'
        ? { kind: 'project', id: caller.projectScope.projectId }
        : { kind: 'global' };
    const projectId = scope.kind === 'project' ? scope.id : undefined;
    const activeWithinMinutes =
      input.activeWithinMinutes ?? ACTIVE_WORK_DEFAULT_MINUTES;
    const cursorSignature = (cursor: string) =>
      createHmac('sha256', cursorKey)
        .update(
          JSON.stringify([
            caller.grantId,
            caller.familyId,
            caller.grantVersion,
            scope,
            activeWithinMinutes,
            cursor,
          ]),
        )
        .digest();
    let cursor: ReturnType<typeof decodeActivityCursor>;
    if (input.cursor !== undefined) {
      const invalid = new ProtocolError(-32602, 'Invalid active-work cursor');
      const [raw, signature, ...rest] = input.cursor.split('.');
      if (
        !raw ||
        !signature ||
        rest.length !== 0 ||
        !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
        !timingSafeEqual(
          cursorSignature(raw),
          Buffer.from(signature, 'base64url'),
        )
      ) {
        throw invalid;
      }
      cursor = decodeActivityCursor(raw);
      if (!cursor) throw invalid;
    }

    const scopedTarget = (threadId: string) => {
      const target = deps.dispatchScope.target(
        { kind: 'thread', threadId, remote: false },
        'view',
      );
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
        (!isObjectRecord(delegation) ||
          delegation.environmentKind !== 'current')
      ) {
        return undefined;
      }
      return target;
    };
    // The shared projection reads the root's title/prompt and sibling activity.
    const admission = (threadId: string): 'host' | 'readable' | undefined => {
      const target = scopedTarget(threadId);
      if (!target) return undefined;
      const lineage = deps.eventStore.conversationForSession(threadId);
      const members = lineage
        ? deps.eventStore.conversationSessions(lineage.conversationId)
        : [];
      const ids = new Set([
        threadId,
        ...members.map((member) => member.sessionId),
      ]);
      let host = target.host;
      for (const id of ids) {
        const member = id === threadId ? target : scopedTarget(id);
        if (!member) return undefined;
        host ||= member.host || deps.eventStore.hasHostAccessHistory(id);
      }
      return host ? 'host' : 'readable';
    };
    const admitThread = (threadId: string) => {
      assertCurrent();
      return admission(threadId) === 'readable';
    };

    assertCurrent();
    const threadIds: string[] = [];
    let scanLimited = false;
    let hostFiltered = 0;
    for (const threadId of deps.eventStore.iterateOwnedActiveWorkCandidates(
      caller.delegatingPrincipalId,
      projectId,
    )) {
      const access = admission(threadId);
      if (!access) continue;
      if (threadIds.length + hostFiltered === MAX_CANDIDATES) {
        scanLimited = true;
        break;
      }
      if (access === 'host') hostFiltered += 1;
      else threadIds.push(threadId);
    }
    const authority = sessionReadAuthorityFromRequest(
      caller.delegatingPrincipalId,
      undefined,
      undefined,
    );
    const result =
      threadIds.length === 0
        ? { sessions: [], nextCursor: null }
        : await activity.page({
            authority,
            viewer: {
              isOwn: () => false,
              listsSession: admitThread,
              showsClaim: (claim) => sameScope(scope, claim.scope),
            },
            cursor,
            limit: input.limit ?? WORK_DISCOVERY_DEFAULT_LIMIT,
            threadIds,
            admitThread,
            activeWithinMinutes,
            now,
          });
    assertCurrent();
    const incompleteSources = [
      ...(hostFiltered || scanLimited
        ? [
            {
              source: 'station.work',
              state: 'partial',
              reason: 'host-execution-filtered',
              filteredCount: hostFiltered,
              ...(scanLimited ? { countIsLowerBound: true } : {}),
            },
          ]
        : []),
      ...(scanLimited
        ? [
            {
              source: 'station.work',
              state: 'partial',
              reason: 'metadata-scan-limit',
            },
          ]
        : []),
    ];
    return {
      success: true,
      data: {
        ...result,
        ...(result.nextCursor
          ? {
              nextCursor: `${result.nextCursor}.${cursorSignature(result.nextCursor).toString('base64url')}`,
            }
          : {}),
        incompleteSources,
      },
    };
  };
}
