import type { FormEvent } from 'react';
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
// (4-HOME-007), or a directory the server refused (4-HOME-008).
//
// The cached duplicate notice deliberately does NOT appear here (
 //). `['projects']` stays fresh for five minutes with refetch-on-mount
// and refetch-on-focus disabled, so a project deleted elsewhere lingers in
// it; vetoing on that would block a legitimate name for minutes without ever
// attempting the POST, which is the only authority. The cached notice warns;
// submission re-checks against the server and only then refuses.
  return {
    canSubmit:
      Boolean(resolvedName) &&
      !submission.directoryError &&
      !submission.slugError,
    submit,
  };
}
