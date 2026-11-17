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
import { Badge } from '@kontourai/ui/react';
import { type ReactNode, useState } from 'react';
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
import { formatDateTime } from '../../utils/relativeTime';
import { projectAccessErrorMessage } from './projectAccessErrorText';

/** Shares the authorized administration view; enablement stays with the caller. */
export function AccessPanelView({
  view,
  busy,
  apply,
  writeDisabledReason,
  expectedActor,
  stationActions,
}: {
  view: ProjectAccessAdministrationView;
  busy: boolean;
  apply: (command: ProjectAccessCommand) => Promise<ProjectAccessCommandResult>;
  writeDisabledReason?: string;
  /** Captured with the rendered action or confirmation; never replaced by a refresh. */
  expectedActor?: string;
  stationActions?: ReactNode;
}) {
  const [notice, setNotice] = useState<string>();
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    command: ProjectAccessCommand;
  }>();
  // Capture the actor with the action; refreshing must not restamp stale intent.
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
          setLink({
            url: invitationLink(view.invitationOrigin, outcome.token),
            expiresAt: outcome.invitation.expiresAt,
          });
        setNotice('Invitation created. Copy the link to share it.');
      } else setNotice('Access updated.');
      setConfirmation(undefined);
      return outcome.kind === 'invited';
    } catch (cause) {
      setError(projectAccessErrorMessage(cause));
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
                  message: `Only ${member.principal.display}'s Project membership changes; their account and device access don't.`,
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
      className="project-access"
      title="People and access"
      description="Who can participate in this Project."
    >
      {readOnly && (
        <p role="note" className="project-access__read-only">
          {writeDisabledReason}
        </p>
      )}
      <ol className="project-access__journey" aria-label="Invitation steps">
        <li>
          <strong>1. Create a link</strong>
          <span>Choose their Project role.</span>
        </li>
        <li>
          <strong>2. They join</strong>
          <span>They sign in and accept the invitation.</span>
        </li>
        <li>
          <strong>3. Approve their browser</strong>
          <span>The Station operator reviews their access request.</span>
        </li>
      </ol>
      {stationActions}
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
      {link && (
        <InvitationLinkReveal
          link={link.url}
          expiresAt={link.expiresAt}
          onCopied={(copied) =>
            setNotice(
              copied ? 'Invitation copied.' : 'Couldn’t copy the invitation.',
            )
          }
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="project-access__error">
          {error}
        </p>
      )}
      <h3>Project members</h3>
      <PersonList
        items={view.members}
        itemKey={(member) => member.principal.id}
        renderItem={memberRow}
        busy={busy}
      />
      <p className="project-access__hint">
        Project roles and browser approval are separate. Joining never grants
        private work or computer access.
      </p>
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
                {ROLE_NAMES[invitation.role]} ·{' '}
                <Badge value={invitation.status} /> · Expires{' '}
                {formatDateTime(invitation.expiresAt)}
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
