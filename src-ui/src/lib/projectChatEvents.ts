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
 * Every dispatcher of this event, as `ui.chat.entry` names it.
 *
 * #1536 M6/D4: the dock's listener reported `source: 'project-sidebar'` — a pill
 * deleted in archive#1629 — because it outlived its only dispatcher and had no
 * way to know. A listener cannot name its caller, so the CALLER carries the
 * name and the dock reports what it was told. A second dispatcher gets its own
 * entry here rather than being mislabelled as this one.
 */
type ProjectChatEntrySource = 'project-page-cta' | 'new-plugin';

/**
 * Text offered for the NEW chat's composer. The dock shows it in the New
 * Chat picker as a removable item and, once the person picks an Agent,
 * places it in the composer. It is never sent on the person's behalf.
 */
export type ProjectChatComposerDraft = {
  /** Heading for the offer in the picker. */
  title: string;
  /** One sentence saying what happens to the text. */
  description: string;
  /** Chip label and detail for the removable item. */
  label: string;
  detail: string;
  /** Exactly what lands in the composer. */
  message: string;
};

export type OpenProjectChatsDetail = {
  projectSlug?: string;
  projectName?: string;
  /** Absent only from a caller predating this field; the dock says so. */
  source?: ProjectChatEntrySource;
  /**
   * Present, the dock always opens the New Chat picker for this project,
   * even when a chat in it already exists: the draft is for a new chat.
   */
  composerDraft?: ProjectChatComposerDraft;
};

/**
 * Returns whether a mounted chat pane claimed the request. Only requests
 * carrying a `composerDraft` are claimed (see `claimComposerDraftRequest`);
 * a plain project-chat request always reports `false`.
 */
export function requestProjectChat(detail: OpenProjectChatsDetail): boolean {
  // Cancelable so exactly one pane can claim a composer draft.
  return !window.dispatchEvent(
    new CustomEvent<OpenProjectChatsDetail>(OPEN_PROJECT_CHATS_EVENT, {
      detail,
      cancelable: true,
    }),
  );
}

/** What the dock reports when a dispatcher did not name itself. */
export const UNNAMED_PROJECT_CHAT_ENTRY_SOURCE = 'project-chat-event';
