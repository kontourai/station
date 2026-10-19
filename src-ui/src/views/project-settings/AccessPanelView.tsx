import '../page-layout.css';
import './project-access.css';
import type {
  ProjectAccessAdministrationView,
  ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import type {
  ProjectAccessCommand,
  ProjectAccessCommandResult,
} from '@kontourai/station-sdk/project-access';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import {
  InvitationLinkReveal,
  InviteFlow,
  invitationLink,
} from '../../components/people/InviteFlow';
import { PersonList } from '../../components/people/PersonList';
import { PersonRow } from '../../components/people/PersonRow';
import { ProjectRolePicker } from '../../components/people/ProjectRolePicker';
import {
  type GrantableProjectRole,
  ROLE_NAMES,
  canGrant as roleGrantable,
} from '../../components/people/projectRoles';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';
import { userFacingErrorMessage } from '../../utils/errorText';

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
  const [notice, setNotice] = useState<string>();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    command: ProjectAccessCommand;
  }>();
  // Stamp the caller-captured actor onto a freshly built command. The
  // caller passes the principal the CURRENT render was proven for; because
  // this runs while building the action (or opening its confirmation), a
  // later refresh can never move the stamp onto a newer principal.
  const stamp = (
    command: Exclude<ProjectAccessCommand, { kind: 'enable' }>,
  ): ProjectAccessCommand => ({
    ...command,
    scope: { ...command.scope },
    ...(expectedActor === undefined ? {} : { expectedActor }),
  });
  const actor = view.members.find(
    (member) =>
      member.principal.id === view.actingPrincipal.id &&
      member.status === 'active',
  );
  const canGrant = (candidate: ProjectMemberView['role']) =>
    roleGrantable(actor, candidate);
  const readOnly = writeDisabledReason !== undefined;

  /** Sends `command`; resolves whether it created an invitation. */
  async function submit(command: ProjectAccessCommand): Promise<boolean> {
    setError(undefined);
    setNotice(undefined);
    setLink(undefined);
    try {
      const outcome = await apply(command);
      if (outcome.kind === 'invited') {
        if (view.invitationOrigin)
          setLink(invitationLink(view.invitationOrigin, outcome.token));
        setNotice('Invitation created. Copy the link to share it.');
      } else setNotice('Access updated.');
      setConfirmation(undefined);
      return outcome.kind === 'invited';
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
      return false;
    }
  }

  function memberRow(member: ProjectMemberView) {
    if (member.role === 'owner')
      return (
        <PersonRow
          className="project-access__member-row"
          principalId={member.principal.id}
          name={member.principal.display}
          meta={ROLE_NAMES[member.role]}
          actions={<span>Transfer ownership to change the owner.</span>}
        />
      );
    return (
      <PersonRow
        className="project-access__member-row"
        principalId={member.principal.id}
        name={member.principal.display}
        meta={
          member.status === 'revoked'
            ? 'Access revoked'
            : ROLE_NAMES[member.role]
        }
        actions={
          <ResponsiveSurfaceActions className="project-access__actions">
            <ProjectRolePicker
              label={<>Role for {member.principal.display}</>}
              aria-label={`Role for ${member.principal.display}`}
              disabled={busy || readOnly || !canGrant(member.role)}
              title={readOnly ? writeDisabledReason : undefined}
              value={member.role as GrantableProjectRole}
              canGrant={canGrant}
              onChange={(role) =>
                void submit(
                  stamp({
                    kind: 'change-member',
                    scope: view.scope,
                    principalId: member.principal.id,
                    revision: member.revision,
                    role,
                    status: member.status,
                  }),
                )
              }
            />
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
                    role: member.role as GrantableProjectRole,
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
        }
      />
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
      <PersonList
        items={view.members}
        itemKey={(member) => member.principal.id}
        renderItem={memberRow}
        busy={busy}
      />
      <InviteFlow
        {...(view.invitationOrigin
          ? { invitationOrigin: view.invitationOrigin }
          : {})}
        busy={busy}
        {...(readOnly ? { writeDisabledReason } : {})}
        canGrant={canGrant}
        create={({ email, role }) =>
          submit(
            stamp({
              kind: 'invite',
              scope: view.scope,
              email,
              role,
              expiresAt: new Date(
                Date.now() + 7 * 86400_000 - 60_000,
              ).toISOString(),
            }),
          )
        }
      />
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
                {ROLE_NAMES[invitation.role]} · {invitation.status} · Expires{' '}
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
        <InvitationLinkReveal
          link={link}
          onCopied={(copied) =>
            setNotice(
              copied ? 'Invitation copied.' : 'Couldn’t copy the invitation.',
            )
          }
        />
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
    </PageSection>
  );
}
