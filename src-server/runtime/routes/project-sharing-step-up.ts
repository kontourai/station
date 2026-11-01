import type { ProjectSharingEnablement } from '@kontourai/station-contracts/project-membership';
import type { Context } from 'hono';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import {
  ConsentCommitRefusedError,
  type ConsentTargetSnapshot,
} from '../../services/consent/consent-transactions.js';
import {
  type OperatorSessionService,
  parseOperatorSessionCookie,
} from '../../services/identity/operator-sessions.js';
import type {
  ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../services/projects/project-membership-service.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import type { Logger } from '../../utils/logger.js';

const CHANGED =
  'This changed since you asked. Nothing was applied; open a new request.';
const SESSION_ENDED = 'Your operator session ended; sign in again.';

// The Project lease transports deliberate membership refusals as data. Carry
// consent's terminal reason through it, then unwrap after releasing the lease.
class ProjectSharingConsentRefusal extends ProjectMembershipRefusal {
  constructor(readonly refusal: ConsentCommitRefusedError) {
    super('forbidden');
  }
}

function preserveConsentRefusal(error: unknown): never {
  if (error instanceof ConsentCommitRefusedError)
    throw new ProjectSharingConsentRefusal(error);
  throw error;
}

export interface ProjectSharingStepUpDeps {
  membership: ProjectMembershipService | undefined;
  authority: (request: Request) => ProjectMembershipAuthority;
  consentChannel: ConsentChannelService | undefined;
  operatorSessions: OperatorSessionService | undefined;
  /** Live credential currentness of the request's own Device. */
  isPrincipalCurrent: (request: Request) => boolean;
  /** Whether ordinary admission would let this request post `enable` for `slug`. */
  mayPostEnable: (request: Request, slug: string) => boolean;
  logger: Pick<Logger, 'warn'>;
}

/**
 * #4306: the Station operator turns on Project sharing from a paired Device
 * with an operator passkey session, through one fresh passkey confirmation
 * on the consent origin per enable. This is the S4 per-action transaction:
 * no step-up window, and the session alone never satisfies `operator()`.
 *
 * The request must be ordinarily admitted as a paired Device (never an
 * agent, never a delegation grant) and carry an operator session bound to
 * that same Device. The owner is the principal that Device resolves to, the
 * same rule the operator-credential path uses.
 */
export function createProjectSharingStepUp(deps: ProjectSharingStepUpDeps) {
  /** The live operator session bound to this request's own Device, if any. */
  const boundSession = (request: Request) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (
      principal?.kind !== 'credential' ||
      principal.authority !== 'device-credential' ||
      requestMayBeAnAgent(request) ||
      !deps.isPrincipalCurrent(request)
    )
      return null;
    const secret = parseOperatorSessionCookie(
      request.headers.get('cookie') ?? undefined,
    );
    const credential = principal.credential;
    const session = secret
      ? deps.operatorSessions?.resolve(secret, credential)
      : null;
    if (!secret || !session) return null;
    return {
      session,
      isCurrent: () =>
        deps.isPrincipalCurrent(request) &&
        deps.operatorSessions?.resolve(secret, credential)?.sessionId ===
          session.sessionId,
    };
  };
  const channelReady = () =>
    !!deps.consentChannel?.trustedOrigin &&
    deps.consentChannel.state().status === 'listening';
  const holdsOperator = async (request: Request) => {
    try {
      await deps.authority(request).operator();
      return true;
    } catch (error) {
      if (error instanceof ProjectMembershipRefusal) return false;
      throw error;
    }
  };

  return {
    mayDisclose(request: Request, slug: string): boolean {
      if (
        !deps.membership ||
        !deps.mayPostEnable(request, slug) ||
        !deps.isPrincipalCurrent(request)
      )
        return false;
      const principal = getRuntimeAuthenticatedRequestPrincipal(request);
      if (
        principal?.authority === 'operator-credential' ||
        principal?.locality === 'home-possession'
      )
        return true;
      return channelReady() && !!boundSession(request);
    },
    async enablement(
      request: Request,
      slug: string,
    ): Promise<ProjectSharingEnablement> {
      if (!deps.membership || !deps.mayPostEnable(request, slug))
        return { enable: 'unavailable' };
      if (await holdsOperator(request))
        return deps.mayPostEnable(request, slug)
          ? { enable: 'direct' }
          : { enable: 'unavailable' };
      const principal = getRuntimeAuthenticatedRequestPrincipal(request);
      if (
        principal?.authority !== 'device-credential' ||
        requestMayBeAnAgent(request) ||
        !deps.isPrincipalCurrent(request) ||
        !deps.mayPostEnable(request, slug) ||
        !channelReady()
      )
        return { enable: 'unavailable' };
      if (boundSession(request)) return { enable: 'operator-passkey' };
      const signInUrl = deps.operatorSessions?.signInUrl;
      return signInUrl
        ? { enable: 'operator-sign-in', signInUrl }
        : { enable: 'unavailable' };
    },

    /**
     * A `202 step_up_required` response, or `undefined` to leave the request
     * to the ordinary route (which commits for operator authority and
     * refuses everyone else exactly as before).
     */
    async enable(
      c: Context,
      slug: string,
      localProjectId: string,
    ): Promise<Response | undefined> {
      const request = c.req.raw;
      const membership = deps.membership;
      if (!membership || (await holdsOperator(request))) return undefined;
      const bound = boundSession(request);
      if (!bound) return undefined;
      const channel = deps.consentChannel;
      if (!channel || !channelReady())
        return c.json({ error: { code: 'step_up_unavailable' } }, 503);
      let owner: { id: string; display: string };
      try {
        owner = (await deps.authority(request).current()).principal;
      } catch (error) {
        if (error instanceof ProjectMembershipRefusal) return undefined;
        throw error;
      }
      const targetFor = (ownerId: string): ConsentTargetSnapshot => ({
        kind: 'project-sharing-enable',
        subject: localProjectId,
        fingerprint: JSON.stringify({ slug, localProjectId, ownerId }),
      });
      const target = targetFor(owner.id);
      const assertCurrent = () => {
        if (!bound.isCurrent() || !deps.mayPostEnable(request, slug))
          throw new ConsentCommitRefusedError(
            SESSION_ENDED,
            false,
            'session_ended',
          );
      };
      // Pins the reviewed owner: a different principal at commit refuses.
      const reviewedOwner = async () => {
        let actor: Awaited<ReturnType<ProjectMembershipAuthority['current']>>;
        try {
          actor = await deps.authority(request).current();
        } catch (error) {
          assertCurrent();
          if (error instanceof ProjectMembershipRefusal) {
            if (error.code === 'forbidden' || error.code === 'conflict')
              throw new ConsentCommitRefusedError(
                CHANGED,
                false,
                'target_changed',
              );
            throw new ConsentCommitRefusedError(
              'Account authority is temporarily unavailable. Nothing was applied.',
              true,
            );
          }
          throw error;
        }
        assertCurrent();
        if (actor.principal.id !== owner.id)
          throw new ConsentCommitRefusedError(CHANGED, false, 'target_changed');
        return actor;
      };
      const created = channel.store.create({
        tenantId: channel.tenantId,
        target,
        ceremony: 'webauthn',
        operatorSessionId: bound.session.sessionId,
        rateKey: bound.session.sessionId,
        requester: { kind: 'operator-session', id: bound.session.sessionId },
        description: {
          title: 'Turn on Project sharing',
          summary: `Turn on sharing for the Project “${slug}”.`,
          items: [
            { label: 'Project', detail: slug },
            { label: 'Owner', detail: `${owner.display} (${owner.id})` },
          ],
          warning:
            'The owner can invite people to this Project and change their access.',
          approveLabel: 'Confirm with passkey',
          denyLabel: 'Cancel',
        },
        revalidateTarget: async () => {
          assertCurrent();
          return targetFor((await reviewedOwner()).principal.id);
        },
        commitApproval: async (passkeyId) => {
          assertCurrent();
          if (!passkeyId)
            throw new ConsentCommitRefusedError(
              CHANGED,
              false,
              'target_changed',
            );
          // `operator()` is satisfied only by this transaction's live session,
          // checked again inside the Project lease at the mutation seam.
          const approved: ProjectMembershipAuthority = {
            current: () => reviewedOwner().catch(preserveConsentRefusal),
            operator: async () => {
              try {
                assertCurrent();
              } catch (error) {
                preserveConsentRefusal(error);
              }
            },
          };
          try {
            await membership.enable(slug, localProjectId, approved, () => {
              try {
                assertCurrent();
                if (!deps.operatorSessions?.isStepUpPasskeyCurrent(passkeyId))
                  throw new ConsentCommitRefusedError(
                    CHANGED,
                    false,
                    'target_changed',
                  );
              } catch (error) {
                preserveConsentRefusal(error);
              }
            });
          } catch (error) {
            if (error instanceof ProjectSharingConsentRefusal)
              throw error.refusal;
            if (error instanceof ConsentCommitRefusedError) throw error;
            if (
              (error instanceof ProjectMembershipRefusal &&
                error.code === 'conflict') ||
              error instanceof FileStorageConflictError ||
              (error instanceof FileStorageNotFoundError &&
                error.code === 'file_storage_not_found')
            )
              throw new ConsentCommitRefusedError(
                CHANGED,
                false,
                'target_changed',
              );
            if (error instanceof ProjectMembershipRefusal)
              throw new ConsentCommitRefusedError(
                'Project sharing could not be turned on. Nothing was applied.',
                false,
              );
            throw error;
          }
          try {
            deps.logger.warn('Project sharing enabled', {
              event: 'station.project_sharing.enabled',
              actor: 'operator-passkey',
              localProjectId,
              transactionId: created.ok ? created.transaction.id : undefined,
            });
          } catch {
            // A dropped observation cannot undo the committed enable.
          }
          return { projectSharing: 'enabled', slug };
        },
      });
      if (!created.ok) return c.json({ error: { code: created.reason } }, 429);
      return c.json(
        {
          status: 'step_up_required',
          transaction: {
            id: created.transaction.id,
            reviewUrl: channel.reviewUrlFor(
              c.req.header('host'),
              created.transaction.id,
            ),
            expiresAt: created.transaction.expiresAt,
          },
        },
        202,
      );
    },
  };
}
