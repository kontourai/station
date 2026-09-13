import {
  PROJECT_MEMBER_ROLES,
  type ProjectMemberRole,
} from '@kontourai/station-contracts/project-membership';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type ProjectAccessCommand,
  useProjectAccess,
} from '@kontourai/station-sdk/project-access';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';
import { ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';

const roles = ['viewer', 'contributor', 'admin'] as const;
const roleNames: Record<ProjectMemberRole, string> = {
  viewer: 'Viewer',
  contributor: 'Contributor',
  admin: 'Project admin',
  owner: 'Owner',
};

export function AccessSection({
  slug,
  projectId,
}: {
  slug: string;
  projectId: string;
}) {
  const authority = useHostRequestAuthorityScope();
  return (
    <AccessPanel
      key={`${slug}:${authority?.apiBase}:${authority?.authorityKey}`}
      slug={slug}
      projectId={projectId}
      authority={authority}
    />
  );
}

function AccessPanel({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority?: ApiRequestScope;
}) {
  const { query, mutation, change } = useProjectAccess(slug, authority);
  const [email, setEmail] = useState('');
  const [restrictEmail, setRestrictEmail] = useState(false);
  const [role, setRole] = useState<(typeof roles)[number]>('viewer');
  const [notice, setNotice] = useState<string>();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    command: ProjectAccessCommand;
  }>();
  const { DiscardModal } = useUnsavedGuard(email.trim().length > 0);
  const view = query.isError ? undefined : query.data;
  const busy = mutation.isPending || query.isFetching;
  const actor = view?.members.find(
    (member) =>
      member.principal.id === view.actingPrincipal.id &&
      member.status === 'active',
  );
  const canGrant = (candidate: ProjectMemberRole) =>
    actor !== undefined &&
    (PROJECT_MEMBER_ROLES[candidate] as readonly string[]).every((action) =>
      actor.actions.includes(action as (typeof actor.actions)[number]),
    );

  async function apply(command: ProjectAccessCommand) {
    setError(undefined);
    setNotice(undefined);
    setLink(undefined);
    try {
      const outcome = await change(command);
      if (outcome.kind === 'invited') {
        setEmail('');
        if (view?.invitationOrigin) {
          const invite = new URL('/account/join', view.invitationOrigin);
          invite.hash = new URLSearchParams({
            invitation: outcome.token,
          }).toString();
          setLink(invite.href);
        }
        setNotice('Invitation created. No email has been sent.');
      } else
        setNotice(
          outcome.kind === 'enabled'
            ? 'Project sharing is enabled.'
            : 'Access updated.',
        );
      setConfirmation(undefined);
      mutation.reset();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <PageSection
      id="section-access"
      title="People and access"
      description="Manage who can participate in this Project. Device access and computer contributions are managed separately."
    >
      {!authority ? (
        <p>Connect to this Station to manage access.</p>
      ) : query.isPending ? (
        <SkeletonList count={2} />
      ) : query.isError ? (
        <>
          {query.error instanceof StationHttpError &&
          query.error.status === 501 ? (
            <p>Project sharing is not enabled on this Station.</p>
          ) : (
            <ErrorState
              title="Project access is unavailable"
              description={errorText(query.error)}
            />
          )}
          {query.error instanceof StationHttpError &&
            query.error.status === 403 && (
              <Button
                pending={mutation.isPending}
                onClick={() =>
                  void apply({ kind: 'enable', localProjectId: projectId })
                }
              >
                Enable Project sharing
              </Button>
            )}
          <Button disabled={busy} onClick={() => void query.refetch()}>
            Refresh access
          </Button>
        </>
      ) : view ? (
        <>
          <div className="project-access__members" aria-busy={busy}>
            {view.members.map((member) => (
              <div className="project-access__member" key={member.principal.id}>
                <div>
                  <strong>{member.principal.display}</strong>
                  <p>
                    {member.status === 'revoked'
                      ? 'Access revoked'
                      : roleNames[member.role]}
                  </p>
                </div>
                {member.role === 'owner' ? (
                  <span>Transfer ownership to change the owner.</span>
                ) : (
                  <ResponsiveSurfaceActions className="project-access__actions">
                    <label>
                      Role for {member.principal.display}
                      <select
                        aria-label={`Role for ${member.principal.display}`}
                        disabled={busy || !canGrant(member.role)}
                        value={member.role}
                        onChange={(event) =>
                          void apply({
                            kind: 'change-member',
                            scope: view.scope,
                            principalId: member.principal.id,
                            revision: member.revision,
                            role: event.target.value as (typeof roles)[number],
                            status: member.status,
                          })
                        }
                      >
                        {roles.map((candidate) => (
                          <option
                            key={candidate}
                            value={candidate}
                            disabled={!canGrant(candidate)}
                          >
                            {roleNames[candidate]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      disabled={busy || !canGrant(member.role)}
                      onClick={() =>
                        setConfirmation({
                          title:
                            member.status === 'active'
                              ? 'Revoke Project access?'
                              : 'Restore Project access?',
                          message: `${member.principal.display}'s Project membership will change. Their account and device grants will remain separate.`,
                          command: {
                            kind: 'change-member',
                            scope: view.scope,
                            principalId: member.principal.id,
                            revision: member.revision,
                            role: member.role as (typeof roles)[number],
                            status:
                              member.status === 'active' ? 'revoked' : 'active',
                          },
                        })
                      }
                    >
                      {member.status === 'active'
                        ? 'Revoke access'
                        : 'Restore access'}
                    </Button>
                    {actor?.role === 'owner' && member.status === 'active' && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            title: 'Transfer Project ownership?',
                            message: `${member.principal.display} will become the owner. You will become a Project admin.`,
                            command: {
                              kind: 'transfer',
                              scope: view.scope,
                              recipientId: member.principal.id,
                            },
                          })
                        }
                      >
                        Make owner
                      </Button>
                    )}
                  </ResponsiveSurfaceActions>
                )}
              </div>
            ))}
          </div>
          <form
            className="project-access__invite"
            onSubmit={(event) => {
              event.preventDefault();
              if (view.invitationOrigin)
                void apply({
                  kind: 'invite',
                  scope: view.scope,
                  email: restrictEmail ? email.trim() : null,
                  role,
                  expiresAt: new Date(
                    Date.now() + 7 * 86400_000 - 60_000,
                  ).toISOString(),
                });
            }}
          >
            <h3>Invite a person</h3>
            <p>
              A link can be accepted once by anyone you share it with. It
              expires after seven days and can be cancelled here.
            </p>
            {!view.invitationOrigin && (
              <p>
                Account sign-in must be configured before creating an invitation
                link.
              </p>
            )}
            <Checkbox
              checked={restrictEmail}
              disabled={busy || !view.invitationOrigin}
              onChange={setRestrictEmail}
            >
              Require a verified email address
            </Checkbox>
            {restrictEmail && (
              <label>
                Email address
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy || !view.invitationOrigin}
                  required
                />
              </label>
            )}
            <label>
              Project role
              <select
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as (typeof roles)[number])
                }
                disabled={busy || !view.invitationOrigin}
              >
                {roles.map((candidate) => (
                  <option
                    key={candidate}
                    value={candidate}
                    disabled={!canGrant(candidate)}
                  >
                    {roleNames[candidate]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              pending={mutation.isPending}
              disabled={
                busy ||
                !view.invitationOrigin ||
                (restrictEmail && !email.trim())
              }
              pendingLabel="Creating invitation…"
            >
              Create invitation
            </Button>
          </form>
          <h3>Invitations</h3>
          {view.invitations.length === 0 ? (
            <p>No invitations yet.</p>
          ) : (
            view.invitations.map((invitation) => (
              <div className="project-access__member" key={invitation.id}>
                <div>
                  <strong>
                    {invitation.recipientEmail ?? 'Single-use invitation link'}
                  </strong>
                  <p>
                    {roleNames[invitation.role]} · {invitation.status} · Expires{' '}
                    {new Date(invitation.expiresAt).toLocaleString()}
                  </p>
                </div>
                {invitation.status === 'pending' && (
                  <Button
                    disabled={busy || !canGrant(invitation.role)}
                    onClick={() =>
                      void apply({
                        kind: 'revoke-invitation',
                        scope: view.scope,
                        invitationId: invitation.id,
                      })
                    }
                  >
                    Cancel invitation
                  </Button>
                )}
              </div>
            ))
          )}
        </>
      ) : null}
      {notice && <p role="status">{notice}</p>}
      {link && (
        <label>
          Invitation link
          <input
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <ConfirmModal
        isOpen={!!confirmation}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        pending={mutation.isPending}
        error={error}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          if (confirmation) void apply(confirmation.command);
        }}
      />
      <DiscardModal />
    </PageSection>
  );
}
