/**
 * "Start a chat in THIS project" open event.
 *
 * Same shape as `reportProblemEvents`: an entry point dispatches, and the
 * mounted dock listens and routes — focusing an existing chat already bound
 * to that project, or opening the New Chat picker with the project
 * preselected. The routing rule lives in the dock because only the dock knows
 * its sessions; a caller that reached for `setDockState(true)` instead just
 * revealed whatever conversation happened to be active, which on a fresh
 * install was a chat in no project at all.
 *
 * The dock has listened for this event since the sidebar pill that used to
 * dispatch it was removed (archive#1629); this module is the named seam that
 * makes it dispatchable again rather than a second string literal.
 */
export const OPEN_PROJECT_CHATS_EVENT = 'station:open-project-chats';

export type OpenProjectChatsDetail = {
  projectSlug?: string;
  projectName?: string;
};

export function requestProjectChat(detail: OpenProjectChatsDetail): void {
  window.dispatchEvent(
    new CustomEvent<OpenProjectChatsDetail>(OPEN_PROJECT_CHATS_EVENT, {
      detail,
    }),
  );
}
