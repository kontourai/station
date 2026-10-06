// Review-ledger paths shared by the store and history replay (#3394). A leaf
// module: it imports nothing, so neither caller forms an import cycle.
export const REVIEW_LEDGER_DIR = 'docs/learn/review-ledger';
/** Loose notes, one file per recording run. */
export const REVIEW_NOTES_DIR = `${REVIEW_LEDGER_DIR}/notes/`;
/** Immutable archives of landed notes, one per baseline advance. */
export const NOTE_ARCHIVES_DIR = `${REVIEW_NOTES_DIR}archive/`;

/** @param {string} baseline the coverage baseline the archived notes predate */
export const noteArchiveFile = (baseline) =>
  `${NOTE_ARCHIVES_DIR}${baseline}.json`;
/** Whether a repo-relative path is a note archive rather than a loose note. */
export const isNoteArchiveFile = (file) => file.startsWith(NOTE_ARCHIVES_DIR);
