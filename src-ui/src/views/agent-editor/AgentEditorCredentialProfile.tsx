import { useCredentialRecoveryQuery } from '@kontourai/station-sdk';
import type { AgentEditorFormProps } from './types';

/**
 * archive#3551: which ACCOUNT of the bound engine this agent runs on.
 *
 * Credential profiles have always stored one app-home per account
 * (`credentialProfileStorageId(engineId, ref)` keys them two-dimensionally),
 * and archive#3530 let an agent name one. This is the control that sets it.
 *
 * Only engines with an app-home channel have a credential-profile concept at
 * all — the server's `APP_HOME_ENGINES` table (`routes/connections/app-home.ts`)
 * lists exactly `claude` and `codex`. Rather than duplicate that table here
 * (a second list that eventually disagrees with the first), the control keys
 * off the server's own answer: `credential-recovery` 404s / errors for a
 * connection that has no such channel, so `data == null` means "this engine
 * has no accounts to choose between" and the control renders nothing at all.
 * An inert dropdown would be worse than its absence.
 */
export function AgentEditorCredentialProfile({
  form,
  setForm,
  locked,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'>) {
  const connectionId = form.execution.agentConnectionId;
  const {
    data: recovery,
    isLoading,
    isError,
  } = useCredentialRecoveryQuery(connectionId || undefined);

  const pinned = form.execution.credentialProfileRef ?? '';
  const profiles = recovery?.profiles ?? [];
  const connectionActiveRef = recovery?.application?.activeProfileRef;

// Independent review (Codex): loading and a failed request both produce an
// absent projection, and treating either as "this engine has no accounts"
// told a user with a VALID pin that it has no effect and to clear it. Say
// what is actually true instead.
  if (isLoading || isError) {
// returning null for an UNPINNED agent made the
// control vanish while loading or after a failed request, which is
// indistinguishable from an engine that has no accounts at all — the same
// conflation this branch exists to remove, just for the other population.
// The user could neither pick an account nor tell why they could not.
    return (
      <div className="editor-field">
        <span className="editor-label">Account</span>
        <span className="editor-hint">
          {isLoading
            ? pinned
              ? `Checking which accounts this engine has. This agent pins ${pinned}.`
              : 'Checking which accounts this engine has.'
            : pinned
              ? `This agent pins ${pinned}. Station could not read this engine's accounts, so whether that pin resolves is unknown.`
              : "Station could not read this engine's accounts, so they cannot be listed. This is not the same as the engine having none."}
        </span>
      </div>
    );
  }

// No app-home channel for this engine: render nothing rather than a control
// that cannot mean anything.
  if (!recovery) {
// A pin authored from the CLI on an engine that cannot deliver it is an
// authoring-time validation state, never a silent drop
 // (agent-engine-unification.md §5). Surface it instead of hiding the field.
    if (!pinned) return null;
    return (
      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-credential-profile">
          Account
        </label>
        <input
          id="ae-credential-profile"
          className="editor-input"
          value={pinned}
          readOnly
          aria-describedby="ae-credential-profile-hint"
        />
        <span className="editor-hint" id="ae-credential-profile-hint">
          This agent pins the account <strong>{pinned}</strong>, but its engine
          has no separate accounts to apply it to, so the pin has no effect.
          Clear it, or move the agent to an engine that supports accounts.
        </span>
      </div>
    );
  }

// A ref that no longer names an enrolled profile (the profile was deleted,
// or the agent was authored against another engine's account). Keep it
// selectable so saving an unrelated edit cannot silently discard it, and say
// plainly that it will not resolve.
  const pinnedIsKnown =
    !pinned || profiles.some((profile) => profile.ref === pinned);

  const describeFallback = connectionActiveRef
    ? `Uses the connection's account (${connectionActiveRef}).`
    : "Uses the connection's account.";

  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor="ae-credential-profile">
        Account
      </label>
      <select
        id="ae-credential-profile"
        className="editor-input"
        value={pinned}
        disabled={locked}
        aria-describedby="ae-credential-profile-hint"
        onChange={(event) =>
          setForm((current) => ({
            ...current,
            execution: {
              ...current.execution,
// Empty selection clears the pin outright rather than persisting
// an empty string, so "no pin" is one representable state.
              credentialProfileRef: event.target.value || undefined,
            },
          }))
        }
      >
        <option value="">{describeFallback}</option>
        {profiles.map((profile) => (
          <option key={profile.ref} value={profile.ref}>
            {profile.label ? `${profile.label} (${profile.ref})` : profile.ref}
          </option>
        ))}
        {!pinnedIsKnown && (
          <option value={pinned}>{pinned} — not enrolled</option>
        )}
      </select>
      <span className="editor-hint" id="ae-credential-profile-hint">
        {!pinnedIsKnown ? (
          <>
            This agent pins <strong>{pinned}</strong>, which is not an enrolled
            account on this engine, so the session will fail rather than run on
            a different account. Pick an enrolled account or clear the pin.
          </>
        ) : profiles.length === 0 ? (
          <>
            No separate accounts are enrolled on this engine yet, so every agent
            on it uses the same one. Enrol accounts on the engine&apos;s
            Connections page.
          </>
        ) : (
          <>
            Which account this agent runs on. Leave unset to follow the
            connection, so changing the connection&apos;s account moves this
            agent with it.
          </>
        )}
      </span>
    </div>
  );
}
