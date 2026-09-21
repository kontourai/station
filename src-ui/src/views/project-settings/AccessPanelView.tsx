import {
  PROJECT_MEMBER_ROLES,
  type ProjectAccessAdministrationView,
  type ProjectMemberRole,
  type ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import type {
  ProjectAccessCommand,
  ProjectAccessCommandResult,
} from '@kontourai/station-sdk/project-access';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';

const roles = ['viewer', 'contributor', 'admin'] as const;
const roleNames: Record<ProjectMemberRole, string> = {
  viewer: 'Viewer',
  contributor: 'Contributor',
  admin: 'Project admin',
  owner: 'Owner',
};

/**
 * Shared People-and-access administration body, rendered by both the
 * operator settings surface and the invited-admin guest journey.
 *
 * The panel is deliberately authority-agnostic: it renders one already
 * authorized administration view and submits caller-built commands through
 * the injected `apply`. Connection authority, the enable-sharing bootstrap,
 * query-state branches, and the actor-precondition stamping all belong to
 * the wrappers — this panel never shows an enable-sharing action, so a
 * guest wrapper cannot leak the operator bootstrap after a 403.
 *
 * When `writeDisabledReason` is set, every editing control is disabled and
 * the reason is stated once above them: a read-only admin device can
 * inspect administration but must hear why it cannot submit.
 */
export function AccessPanelView({
  view,
  busy,
  apply,
  writeDisabledReason,
  expectedActor,
}: {
  view: ProjectAccessAdministrationView;
  busy: boolean;
  apply: (command: ProjectAccessCommand) => Promise<ProjectAccessCommandResult>;
  writeDisabledReason?: string;
  /**
   * The acting principal this view was rendered for, stamped onto every
   * command the panel builds so the server can refuse stale intent against
   * fresh authority (guest HttpOnly-cookie replacement race). The stamp is
   * captured with the rendered action or the opened confirmation — never
   * refreshed at submit time. Omit it on paths that never cross that
   * boundary (the operator console keeps working unchanged).
   */
  expectedActor?: string;
}) {
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
  // Stamp the caller-captured actor onto a freshly built command. The
  // caller passes the principal the CURRENT render was proven for; because
  // this runs while building the action (or opening its confirmation), a
  // later refresh can never move the stamp onto a newer principal.
  const stamp = (
    command: Exclude<ProjectAccessCommand, { kind: 'enable' }>,
  ): ProjectAccessCommand =>
    expectedActor === undefined ? command : { ...command, expectedActor };
  const actor = view.members.find(
    (member) =>
      member.principal.id === view.actingPrincipal.id &&
      member.status === 'active',
  );
  const canGrant = (candidate: ProjectMemberRole) =>
    actor !== undefined &&
    (PROJECT_MEMBER_ROLES[candidate] as readonly string[]).every((action) =>
      actor.actions.includes(action as (typeof actor.actions)[number]),
    );
  const readOnly = writeDisabledReason !== undefined;

  async function submit(command: ProjectAccessCommand) {
    setError(undefined);
    setNotice(undefined);
    setLink(undefined);
    try {
      const outcome = await apply(command);
      if (outcome.kind === 'invited') {
        setEmail('');
        if (view.invitationOrigin) {
          const invite = new URL('/account/join', view.invitationOrigin);
          invite.hash = new URLSearchParams({
            invitation: outcome.token,
          }).toString();
          setLink(invite.href);
        }
        setNotice(
          'Invitation created. No email has been sent — copy the link now, it is shown once.',
        );
      } else setNotice('Access updated.');
      setConfirmation(undefined);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function memberRow(member: ProjectMemberView) {
    if (member.role === 'owner')
      return (
        <div className="project-access__member" key={member.principal.id}>
          <div>
            <strong>{member.principal.display}</strong>
            <p>{roleNames[member.role]}</p>
          </div>
          <span>Transfer ownership to change the owner.</span>
        </div>
      );
    return (
      <div className="project-access__member" key={member.principal.id}>
        <div>
          <strong>{member.principal.display}</strong>
          <p>
            {member.status === 'revoked'
              ? 'Access revoked'
              : roleNames[member.role]}
          </p>
        </div>
        <ResponsiveSurfaceActions className="project-access__actions">
          <label>
            Role for {member.principal.display}
            <select
              aria-label={`Role for ${member.principal.display}`}
              disabled={busy || readOnly || !canGrant(member.role)}
              title={readOnly ? writeDisabledReason : undefined}
              value={member.role}
              onChange={(event) =>
                void submit(
                  stamp({
                    kind: 'change-member',
                    scope: view.scope,
                    principalId: member.principal.id,
                    revision: member.revision,
                    role: event.target.value as (typeof roles)[number],
                    status: member.status,
                  }),
                )
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
            disabled={busy || readOnly || !canGrant(member.role)}
            title={readOnly ? writeDisabledReason : undefined}
            onClick={() =>
              setConfirmation({
                title:
                  member.status === 'active'
                    ? 'Revoke Project access?'
                    : 'Restore Project access?',
                message: `${member.principal.display}'s Project membership will change. Their account and device grants will remain separate.`,
                command: stamp({
                  kind: 'change-member',
                  scope: view.scope,
                  principalId: member.principal.id,
                  revision: member.revision,
                  role: member.role as (typeof roles)[number],
                  status: member.status === 'active' ? 'revoked' : 'active',
                }),
              })
            }
          >
            {member.status === 'active' ? 'Revoke access' : 'Restore access'}
          </Button>
          {actor?.role === 'owner' && member.status === 'active' && (
            <Button
              disabled={busy || readOnly}
              title={readOnly ? writeDisabledReason : undefined}
              onClick={() =>
                setConfirmation({
                  title: 'Transfer Project ownership?',
                  message: `${member.principal.display} will become the owner. You will become a Project admin.`,
                  command: stamp({
                    kind: 'transfer',
                    scope: view.scope,
                    recipientId: member.principal.id,
                  }),
                })
              }
            >
              Make owner
            </Button>
          )}
        </ResponsiveSurfaceActions>
      </div>
    );
  }

  return (
    <PageSection
      id="section-access"
      title="People and access"
      description="Manage who can participate in this Project. Device access and computer contributions are managed separately."
    >
      {readOnly && (
        <p role="note" className="project-access__read-only">
          {writeDisabledReason}
        </p>
      )}
      <div className="project-access__members" aria-busy={busy}>
        {view.members.map(memberRow)}
      </div>
      <form
        className="project-access__invite"
        onSubmit={(event) => {
          event.preventDefault();
          if (view.invitationOrigin)
            void submit(
              stamp({
                kind: 'invite',
                scope: view.scope,
                email: restrictEmail ? email.trim() : null,
                role,
                expiresAt: new Date(
                  Date.now() + 7 * 86400_000 - 60_000,
                ).toISOString(),
              }),
            );
        }}
      >
        <h3>Invite a person</h3>
        <p>
          A link can be accepted once by anyone you share it with. It expires
          after seven days and can be cancelled here.
        </p>
        {!view.invitationOrigin && (
          <p>
            Account sign-in must be configured before creating an invitation
            link.
          </p>
        )}
        <Checkbox
          checked={restrictEmail}
          disabled={busy || readOnly || !view.invitationOrigin}
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
              disabled={busy || readOnly || !view.invitationOrigin}
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
            disabled={busy || readOnly || !view.invitationOrigin}
            title={readOnly ? writeDisabledReason : undefined}
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
          pending={busy}
          disabled={
            busy ||
            readOnly ||
            !view.invitationOrigin ||
            (restrictEmail && !email.trim())
          }
          title={readOnly ? writeDisabledReason : undefined}
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
                disabled={busy || readOnly || !canGrant(invitation.role)}
                title={readOnly ? writeDisabledReason : undefined}
                onClick={() =>
                  void submit(
                    stamp({
                      kind: 'revoke-invitation',
                      scope: view.scope,
                      invitationId: invitation.id,
                    }),
                  )
                }
              >
                Cancel invitation
              </Button>
            )}
          </div>
        ))
      )}
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
        pending={busy}
        error={error}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          if (confirmation) void submit(confirmation.command);
        }}
      />
      <DiscardModal />
    </PageSection>
  );
}
