/**
 * The ambient context prefix a sent prompt may carry (the timezone context
 * provider's `[Timezone: America/Denver]`), stripped before the prompt is
 * read as a chat's title. The server's `extractDisplayTitle` strips the same
 * prefix for `displayTitle`; this is the client's one place for a title
 * computed from the first message (D4: the dock header showed it raw).
 */
const AMBIENT_PREAMBLE = /^\s*\[Timezone:\s*[^\]]*\]\s*/i;

const DISPLAY_TITLE_MAX_LENGTH = 100;

/**
 * Station's own system-event lines (`[SYSTEM_EVENT] [CHAT_ERROR:<code>] …`,
 * written as a user-role message by `turnHandlers.ts` and the server's
 * chat-error marker) are never what a person said, so they never name a chat.
 */
const SYSTEM_EVENT_MARKER = /^\s*\[SYSTEM_EVENT\]/;

/** A chat title from a sent prompt; empty when the prompt names nothing. */
export function displayTitleFromPrompt(prompt: string): string {
  if (SYSTEM_EVENT_MARKER.test(prompt)) return '';
  return prompt
    .replace(AMBIENT_PREAMBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISPLAY_TITLE_MAX_LENGTH);
}
