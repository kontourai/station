import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isObjectRecord } from '@kontourai/station-contracts/record-guard';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { ProtocolError } from '@modelcontextprotocol/server';
import {
  ACTIVE_WORK_DEFAULT_MINUTES,
  WORK_DISCOVERY_DEFAULT_LIMIT,
} from '../../routes/chat/work-discovery-limits.js';
import type { StationControlSessionTargetReader } from '../../runtime/mcp/station-control-dispatch-scope.js';
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
const MAX_METADATA_SCAN = 2 * MAX_CANDIDATES;
const CURSOR_SIGNATURE_LENGTH = 44;
// A signed cursor must hold a JSON-escaped conversation ID of up to 512 code units.
export const MAX_OUTSIDE_ACTIVE_WORK_CURSOR = 8 * 1024;

type Admission = 'host' | 'readable' | undefined;

export interface OutsideActiveWorkDeps extends SessionActivityReaderDeps {
  eventStore: SessionActivityReaderDeps['eventStore'] &
    Pick<
      EventStore,
      | 'iterateOwnedActiveWorkCandidates'
      | 'hasHostAccessHistory'
      | 'conversationForSession'
      | 'conversationSessions'
    >;
  dispatchScope: StationControlSessionTargetReader;
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
      cursor = decodeActivityCursor(
        raw,
        MAX_OUTSIDE_ACTIVE_WORK_CURSOR - CURSOR_SIGNATURE_LENGTH,
      );
      if (!cursor) throw invalid;
    }

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
        (!isObjectRecord(delegation) ||
          delegation.environmentKind !== 'current')
      ) {
        return undefined;
      }
      return target;
    };
    let canListInInventory: (threadId: string) => boolean = () => false;
    const classifyLineage = (ids: ReadonlySet<string>): Admission => {
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
    const admission = (
      threadId: string,
      cache: Map<string, Admission>,
    ): Admission => {
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
          : classifyLineage(ids);
      cache.set(key, access);
      return access;
    };

    let scanLimited = false;
    const hostFiltered = new Set<string>();
    const selectThreadIds = (canList: (threadId: string) => boolean) => {
      assertCurrent();
      canListInInventory = canList;
      const cache = new Map<string, Admission>();
      const threadIds: string[] = [];
      let scanned = 0;
      for (const threadId of deps.eventStore.iterateOwnedActiveWorkCandidates(
        caller.delegatingPrincipalId,
        projectId,
      )) {
        if (!canList(threadId)) continue;
        if (scanned === MAX_METADATA_SCAN) {
          scanLimited = true;
          break;
        }
        scanned += 1;
        const access = admission(threadId, cache);
        if (!access) continue;
        if (threadIds.length + hostFiltered.size === MAX_CANDIDATES) {
          scanLimited = true;
          break;
        }
        if (access === 'host') hostFiltered.add(threadId);
        else threadIds.push(threadId);
      }
      return threadIds;
    };

    assertCurrent();
    const authority = sessionReadAuthorityFromRequest(
      caller.delegatingPrincipalId,
      undefined,
      undefined,
    );
    const pageAdmission = new Map<string, Admission>();
    const result = await activity.page({
      authority,
      viewer: {
        isOwn: () => false,
        listsSession(threadId) {
          assertCurrent();
          const access = admission(threadId, pageAdmission);
          if (access === 'host') hostFiltered.add(threadId);
          return access === 'readable';
        },
        showsClaim: (claim) => sameScope(scope, claim.scope),
      },
      cursor,
      limit: input.limit ?? WORK_DISCOVERY_DEFAULT_LIMIT,
      selectThreadIds,
      activeWithinMinutes,
      now,
    });
    assertCurrent();
    const incompleteSources = [
      ...(hostFiltered.size || scanLimited
        ? [
            {
              source: 'station.work',
              state: 'partial',
              reason: 'host-execution-filtered',
              filteredCount: hostFiltered.size,
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
