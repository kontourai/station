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

/**
 * Who asked, for `ui.chat.entry`. Lives here rather than as a literal in the
 * dock's listener because the dock cannot name its own caller: #1536 M6 found
 * it still reporting `project-sidebar`, a pill deleted in archive#1629, because
 * the listener outlived its only dispatcher. Exported from the seam that
 * identifies the caller, so the event and the telemetry source cannot drift
 * apart — and the value is asserted where the dispatch is
 * (`ProjectPage.test.tsx`), which is the only place both are observable.
 */
export const PROJECT_CHAT_ENTRY_TELEMETRY_SOURCE = 'project-page-cta';

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
