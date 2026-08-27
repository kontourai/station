/**
 * AboutYouStep — the two first-run questions (station#2652 chapter 2).
 *
 * The honesty rules this component enforces at the UI edge, matching what
 * `buildUserProfileContextBlock` enforces at the data edge:
 *
 * - **Nothing is preselected.** No role and no comfort level is checked when
 *   the step opens, so "the user chose Engineer" and "the user did not answer"
 *   are never the same state.
 * - **Skipping writes nothing.** "Skip" persists no profile at all, rather than
 *   writing an empty or default one, so the server sees absent and injects
 *   nothing.
 * - **The preview is the payload.** The block shown under the questions is the
 *   exact string `buildUserProfileContextBlock` returns — the same derivation
 *   the server injects — so the preview cannot flatter what is actually sent.
 * - **The reach is stated, not implied.** `USER_PROFILE_ENGINE_REACH_NOTE` says
 *   that external engines build their own context and this has no effect there.
 *
 * WHERE THIS RENDERS. The second step of `FirstRunHomeChapter`'s dialog, on
 * Home. It used to be a fixed bottom-right card at `--layer-notice`, preceded
 * by a corner `AboutYouInvite` — both removed by the UX audit's SHELL-12 fix.
 * The invite existed to keep the questions from ambushing an
 * already-configured Station, which is a gate's job, not a card's; the gate is
 * now a durable fact about the home (`first-run-gate.ts`) and the questions
 * only ever open inside a chapter the person is already in.
 */

import {
  buildUserProfileContextBlock,
  USER_PROFILE_COMFORT_LABELS,
  USER_PROFILE_COMFORT_LEVELS,
  USER_PROFILE_ENGINE_REACH_NOTE,
  USER_PROFILE_ROLE_LABELS,
  USER_PROFILE_ROLES,
  type UserProfileComfort,
  type UserProfileRole,
  type UserProfileSettings,
} from '@kontourai/station-contracts/user-profile';
import { useId, useState } from 'react';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import './AboutYouStep.css';

export interface AboutYouStepProps {
  /** Persisted answers, if this step is being revisited. */
  initial?: UserProfileSettings;
  /** Called with the answers to persist. Never called for a skip. */
  onSave: (profile: UserProfileSettings) => void | Promise<void>;
  /** Move on without persisting anything. */
  onSkip: () => void;
  /** The save is in flight. */
  saving?: boolean;
  /**
   * The save FAILED and nothing was persisted. Rendered in place of the
   * preview's promise, because "Exactly what Station will add" is false once
   * the write did not land (review M1).
   */
  error?: string | null;
}

export function AboutYouStep({
  initial,
  onSave,
  onSkip,
  saving,
  error,
}: AboutYouStepProps) {
  const roleGroupId = useId();
  const comfortGroupId = useId();
  const [role, setRole] = useState<UserProfileRole | undefined>(initial?.role);
  const [comfort, setComfort] = useState<UserProfileComfort | undefined>(
    initial?.comfort,
  );

  const preview = buildUserProfileContextBlock({ role, comfort });

  return (
    <div className="first-run-about" data-testid="first-run-about-you">
      {/* No heading of its own: the dialog header this step renders inside
          already names it, and a second copy of the same sentence is the
          screen printed twice (`docs/design/shell-skeletons.md` §2.1's rule,
          applied to a dialog). */}
      <p className="first-run-chapter__lede">
        Station adds what you pick here to the context of your chats. Skip it
        and Station adds nothing — there is no assumed answer.
      </p>

      <fieldset className="first-run-about__group">
        <legend className="first-run-about__legend" id={roleGroupId}>
          What do you do?
        </legend>
        <div className="first-run-about__options">
          {USER_PROFILE_ROLES.map((value) => (
            <label className="first-run-about__option" key={value}>
              <input
                type="radio"
                name="first-run-role"
                value={value}
                checked={role === value}
                onChange={() => setRole(value)}
              />
              <span>{USER_PROFILE_ROLE_LABELS[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="first-run-about__group">
        <legend className="first-run-about__legend" id={comfortGroupId}>
          How much technical detail do you want back?
        </legend>
        <div className="first-run-about__options">
          {USER_PROFILE_COMFORT_LEVELS.map((value) => (
            <label className="first-run-about__option" key={value}>
              <input
                type="radio"
                name="first-run-comfort"
                value={value}
                checked={comfort === value}
                onChange={() => setComfort(value)}
              />
              <span>{USER_PROFILE_COMFORT_LABELS[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {preview ? (
        <div className="first-run-about__preview">
          <div className="first-run-about__preview-label">
            Exactly what Station will add:
          </div>
          <pre
            className="first-run-about__preview-block"
            data-testid="first-run-profile-preview"
          >
            {preview}
          </pre>
        </div>
      ) : (
        <p
          className="first-run-about__preview-empty"
          data-testid="first-run-profile-preview-empty"
        >
          Nothing selected, so Station will add nothing to your chats.
        </p>
      )}

      {error ? (
        <p
          className="first-run-about__error"
          role="alert"
          data-testid="first-run-profile-error"
        >
          {error} Nothing was saved, so Station will add nothing to your chats.
        </p>
      ) : null}

      <p className="first-run-about__reach">{USER_PROFILE_ENGINE_REACH_NOTE}</p>

      <ResponsiveSurfaceActions className="first-run-chapter__actions">
        <button type="button" className="editor-btn" onClick={onSkip}>
          Skip
        </button>
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          disabled={!preview || saving}
          onClick={() => {
            // Guarded by `disabled`, and re-checked here so a programmatic
            // click cannot persist an empty profile.
            if (!preview) return;
            void onSave({
              ...(role ? { role } : {}),
              ...(comfort ? { comfort } : {}),
            });
          }}
        >
          {saving ? 'Saving…' : 'Save and finish'}
        </button>
      </ResponsiveSurfaceActions>
    </div>
  );
}
