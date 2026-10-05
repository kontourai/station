import type { FormEvent } from 'react';
import { projectIconInputProblem } from '../components/project-icon/ProjectIconPicker';
import type { useNewProjectModalState } from './useNewProjectModalState';

type NewProjectModalState = ReturnType<typeof useNewProjectModalState>;

/** Builds the immutable create request while submit owns the create-once retry state. */
export function useNewProjectFormSubmit(state: NewProjectModalState) {
  const { draft, submission } = state;
  const { resolvedName } = draft;

  function submit(event: FormEvent) {
    if (!resolvedName) {
      event.preventDefault();
      return;
    }
    void submission.submit(event, {
      name: resolvedName,
      slug: draft.derivedSlug,
      icon: draft.icon.trim() || undefined,
      description: draft.description.trim() || undefined,
      workingDirectory: draft.normalizedDirectory || undefined,
      ...(draft.defaultEnvironment.kind === 'saved'
        ? { defaultEnvironment: draft.defaultEnvironment }
        : {}),
    });
  }

  // Create is disabled only for a fact the SERVER supplied on this draft: no
  // name at all, a slug a refreshed project list still says is taken
  // (4-HOME-007), or a directory the server refused (4-HOME-008). A
  // directory check that failed to HAPPEN (`directoryNotice`) is exactly not
  // such a fact and never disables Create — its copy says "Try again", and a
  // disabled retry control made that a lie (#765 F7-class click-eating).
  //
  // The cached duplicate notice deliberately does NOT appear here.
  // `['projects']` stays fresh for five minutes with refetch-on-mount
  // and refetch-on-focus disabled, so a project deleted elsewhere lingers in
  // it; vetoing on that would block a legitimate name for minutes without ever
  // attempting the POST, which is the only authority. The cached notice warns;
  // submission re-checks against the server and only then refuses.
  //
  // The icon is the one client-side veto, and it is not a guess: it is the
  // contracts rule the create route applies (`projectIconProblem`), shown
  // inline under the field, so Create cannot send a value the server will
  // answer with a bare "Validation failed".
  return {
    canSubmit:
      Boolean(resolvedName) &&
      !submission.directoryError &&
      !submission.slugError &&
      !projectIconInputProblem(draft.icon.trim()),
    submit,
  };
}
