import { createContext } from 'react';

/**
 * The close of the surface a quote is read in, where that surface would stay
 * over Chat: a knowledge document's viewer provides its owner's own close. An
 * admitted "Open source conversation" calls it, so the conversation it shows
 * is not left under the document. A refused or cancelled open never does.
 * Absent where the quote is read in place (Chat, a Task's page).
 *
 * Its own module so a surface can provide it without pulling the Markdown
 * renderer's chunk in with `QuoteSourceLink`.
 */
export const QuoteSurfaceCloseContext = createContext<(() => void) | null>(
  null,
);
