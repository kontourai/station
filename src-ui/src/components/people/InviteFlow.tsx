import type { ProjectMemberRole } from '@kontourai/station-contracts/project-membership';
import { Popover } from '@kontourai/ui/react';
import { useState } from 'react';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { InfoGlyph } from '../icons/Glyph';
import { ProjectRolePicker } from './ProjectRolePicker';
import './people.css';
import type { GrantableProjectRole } from './projectRoles';

export interface InviteRequest {
  /** Null makes a single-use link anyone signed in can accept. */
  email: string | null;
  role: GrantableProjectRole;
}

/** The link a recipient opens to accept `token`; the token rides in the hash. */
export function invitationLink(invitationOrigin: string, token: string) {
  const invite = new URL('/account/join', invitationOrigin);
  invite.hash = new URLSearchParams({ invitation: token }).toString();
  return invite.href;
}

/**
 * The Project invitation form: an optional verified-email restriction, the
 * role, and Create invitation. It owns its draft (and the unsaved-changes
 * guard over a typed email); the caller builds and sends the command.
 *
 * Without `invitationOrigin` Station has no account sign-in to send a
 * recipient to, so the form says so and stays disabled.
 */
export function InviteFlow({
  invitationOrigin,
  busy,
  writeDisabledReason,
  canGrant,
  create,
}: {
  invitationOrigin?: string;
  busy: boolean;
  /** Disables every control and is each control's title. */
  writeDisabledReason?: string;
  canGrant: (role: ProjectMemberRole) => boolean;
  /** Resolves true when the invitation was created, which clears the draft. */
  create: (request: InviteRequest) => Promise<boolean>;
}) {
  const [email, setEmail] = useState('');
  const [restrictEmail, setRestrictEmail] = useState(false);
  const [role, setRole] = useState<GrantableProjectRole>('viewer');
  const { DiscardModal } = useUnsavedGuard(email.trim().length > 0);
  const readOnly = writeDisabledReason !== undefined;
  const unavailable = busy || readOnly || !invitationOrigin;

  return (
    <>
      <form
        className="invite-flow"
        onSubmit={(event) => {
          event.preventDefault();
          if (invitationOrigin)
            void create({
              email: restrictEmail ? email.trim() : null,
              role,
            }).then((created) => {
              if (created) setEmail('');
            });
        }}
      >
        <div className="invite-flow__heading">
          <h3>Invite a person</h3>
          <Popover
            ariaLabel="About Project invitations"
            placement="bottom-end"
            trigger={
              <Button
                variant="ghost"
                className="invite-flow__help"
                aria-label="About Project invitations"
              >
                <InfoGlyph />
              </Button>
            }
          >
            <p>
              This invitation can be accepted once. It expires after seven days
              and can be cancelled here. On mobile, the recipient can paste the
              link into Station.
            </p>
          </Popover>
        </div>
        {!invitationOrigin && (
          <p>
            Account sign-in must be configured before creating an invitation
            link.
          </p>
        )}
        <Checkbox
          checked={restrictEmail}
          disabled={unavailable}
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
              disabled={unavailable}
              required
            />
          </label>
        )}
        <ProjectRolePicker
          label="Project role"
          value={role}
          onChange={setRole}
          canGrant={canGrant}
          disabled={unavailable}
          title={readOnly ? writeDisabledReason : undefined}
        />
        <Button
          type="submit"
          pending={busy}
          disabled={unavailable || (restrictEmail && !email.trim())}
          title={readOnly ? writeDisabledReason : undefined}
          pendingLabel="Creating invitation…"
        >
          Create invitation
        </Button>
      </form>
      <DiscardModal />
    </>
  );
}

/**
 * A created invitation's link: Copy invitation, with the link itself behind
 * a disclosure for a reader who would rather select it. `onCopied` reports
 * whether the clipboard took it.
 */
export function InvitationLinkReveal({
  link,
  onCopied,
}: {
  link: string;
  onCopied: (copied: boolean) => void;
}) {
  return (
    <div>
      <Button onClick={() => void copyToClipboard(link).then(onCopied)}>
        Copy invitation
      </Button>
      <details>
        <summary>Invitation link</summary>
        <label>
          Invitation link
          <input
            readOnly
            value={link}
            onFocus={(event) => event.target.select()}
          />
        </label>
      </details>
    </div>
  );
}
