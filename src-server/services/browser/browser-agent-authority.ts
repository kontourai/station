/**
 * Who a browser tool acts as (#90 D5 + D7; #122/#123).
 *
 * A browser tool call carries the VERIFIED station-control caller
 * (`station-control-caller.ts`): a session id, the channel assurance of its
 * credential, and the principal and Project Station recorded for that
 * session. Nothing here reads a session id, principal or Project from tool
 * arguments.
 *
 * The chain, every step required:
 *  1. a caller exists and its credential is `bound` (never left Station's
 *     process; a `bearer-exposed` or `delegated-custody` credential may have
 *     been copied by another process);
 *  2. its principal is `elevationEligible` (a recorded session owner, not an
 *     inferred operator mapping);
 *  3. its Project id was recorded at session start (`session-record`), never
 *     a slug looked up now;
 *  4. that principal is the Station operator or an active admin/owner of the
 *     Project (D5), decided by {@link BrowserPrincipalAuthorizer}.
 *
 * The result names the profile the agent acts in (D7: the person it acts for,
 * in that Project) and carries a grant the browser live surface recognises,
 * so an agent claim and its input are authorized by this chain rather than
 * by an HTTP request the surface layer cannot attribute.
 */
import { BROWSER_THREAD_ID_PATTERN } from '@kontourai/station-contracts/workspace-browser-pane';
import {
  type BrowserAgentCallerRefusal,
  browserAgentCallerRefusal,
} from '../../tools/station-control-browser-tools.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import {
  type BrowserSessionActor,
  type BrowserSessionRecord,
  browserProfileFor,
} from './browser-session-registry.js';

export type BrowserProjectActor = Extract<
  BrowserSessionActor,
  { kind: 'operator' } | { kind: 'project-admin' }
>;

/** D5 for a principal Station resolved itself (never request input). */
export type BrowserPrincipalAuthorizer = (
  principalId: string,
  projectId: string,
) => Promise<BrowserProjectActor | undefined>;

const PROJECT_ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'owner']);

export interface BrowserPrincipalAccessDeps {
  /** Whether this principal is the Station operator (personal host). */
  isOperatorPrincipal(principalId: string): boolean;
  /** Absent when Project sharing is not configured: then operator only. */
  membership?: {
    admissionsForResolvedPrincipal(principalId: string):
      | readonly {
          scope: { localProjectId: string };
          member: { status: string; role: string };
        }[]
      | Promise<
          readonly {
            scope: { localProjectId: string };
            member: { status: string; role: string };
          }[]
        >;
  };
}

/**
 * The same standing `createBrowserProjectAuthorizer` grants a request, for a
 * principal: the operator, or an ACTIVE admin/owner of the Project by its
 * canonical id. Any error while resolving membership refuses.
 */
export function createBrowserPrincipalAuthorizer(
  deps: BrowserPrincipalAccessDeps,
): BrowserPrincipalAuthorizer {
  return async (principalId, projectId) => {
    if (!principalId || !projectId) return undefined;
    try {
      if (deps.isOperatorPrincipal(principalId)) return { kind: 'operator' };
    } catch {
      return undefined;
    }
    if (!deps.membership) return undefined;
    try {
      const admissions =
        await deps.membership.admissionsForResolvedPrincipal(principalId);
      const admission = admissions.find(
        ({ scope }) => scope.localProjectId === projectId,
      );
      if (
        admission?.member.status !== 'active' ||
        !PROJECT_ADMIN_ROLES.has(admission.member.role)
      )
        return undefined;
      return { kind: 'project-admin', principalId };
    } catch {
      return undefined;
    }
  };
}

/**
 * Proof, inside this process, that the chain above admitted an agent for one
 * Project profile. Only {@link authorizeBrowserAgentCaller} mints one; the
 * browser surface authorizer accepts nothing else (an object literal with the
 * same fields is refused).
 */
export interface BrowserAgentGrant {
  readonly projectId: string;
  /** The principal the agent acts for (the live-surface `actingFor`). */
  readonly principalId: string;
  /** The profile it may act in (`operator` or `principal:<id>`). */
  readonly profileKey: string;
}
const minted = new WeakSet<object>();

/**
 * Whether `grant` is a grant this module minted that admits `principal` to a
 * session in exactly that Project and profile.
 */
export function browserAgentGrantAllows(
  grant: unknown,
  record: Pick<BrowserSessionRecord, 'projectId' | 'principalKey'>,
  principal: string,
): boolean {
  if (typeof grant !== 'object' || grant === null || !minted.has(grant))
    return false;
  const g = grant as BrowserAgentGrant;
  return (
    g.projectId === record.projectId &&
    g.principalId === principal &&
    g.profileKey === record.principalKey
  );
}

export interface BrowserAgentAuthority {
  /** The verified caller's session (the agent controller's `sessionId`). */
  readonly sessionId: string;
  /** Canonical Project id the session was started in. */
  readonly projectId: string;
  /** Who the agent acts for; also its live-surface principal. */
  readonly principalId: string;
  /** Their standing in the Project (D5). */
  readonly projectActor: BrowserProjectActor;
  /** How the session's history records this agent (D6). */
  readonly actor: Extract<BrowserSessionActor, { kind: 'agent' }>;
  /** The profile every session this agent may drive runs in (D7). */
  readonly profileKey: string;
  /**
   * The conversation the agent is acting in (its verified conversation,
   * else its session): the thread a session it opens or reuses belongs to,
   * so the chat that asked can float it. Never from tool arguments.
   */
  readonly threadId?: string;
  readonly grant: BrowserAgentGrant;
}

export type BrowserAgentAuthorityRefusal =
  | BrowserAgentCallerRefusal
  | {
      readonly code: 'not-authorized';
      readonly message: string;
    };

export async function authorizeBrowserAgentCaller(
  caller: StationControlCaller | null,
  authorize: BrowserPrincipalAuthorizer,
): Promise<
  | { ok: true; authority: BrowserAgentAuthority }
  | { ok: false; refusal: BrowserAgentAuthorityRefusal }
> {
  const refusal = browserAgentCallerRefusal(caller);
  if (refusal || !caller) {
    return {
      ok: false,
      refusal: refusal ?? browserAgentCallerRefusal(null)!,
    };
  }
  // Narrowed by the refusal check above; re-read for the type system.
  const principalId = caller.principal!.id;
  const projectId = caller.localProjectId!;
  const projectActor = await authorize(principalId, projectId);
  const profileKey = projectActor
    ? browserProfileFor(projectId, projectActor)?.principalKey
    : undefined;
  if (!projectActor || !profileKey) {
    return {
      ok: false,
      refusal: {
        code: 'not-authorized',
        message:
          'Only the Station operator and admins of this Project may use its browser. The person this session acts for is neither, so this agent cannot open or drive a browser here.',
      },
    };
  }
  const grant: BrowserAgentGrant = Object.freeze({
    projectId,
    principalId,
    profileKey,
  });
  minted.add(grant);
  const thread = caller.conversationId ?? caller.sessionId;
  return {
    ok: true,
    authority: Object.freeze({
      ...(BROWSER_THREAD_ID_PATTERN.test(thread) ? { threadId: thread } : {}),
      sessionId: caller.sessionId,
      projectId,
      principalId,
      projectActor,
      actor: Object.freeze({
        kind: 'agent' as const,
        principalId,
        sessionId: caller.sessionId,
      }),
      profileKey,
      grant,
    }),
  };
}
