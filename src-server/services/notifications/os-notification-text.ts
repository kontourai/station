import {
  boundedDisplayText,
  displayJoinedLines,
  displayMultilineText,
  truncateDisplay,
} from '@kontourai/station-shared/display-text';

/**
 * #3382: what an OS notification (web push, the desktop feed, APNs, FCM)
 * shows of a notification's title and body. Both can carry engine text (a
 * Codex approval's title is its command), so they are put in display form,
 * as the in-app surfaces put them: no bidi overrides or invisible
 * characters, controls as spaces. The title stays one line (its lines kept
 * apart with " ⏎ "); the body keeps its line breaks.
 *
 * With `max` (code points), a cut ends in "…": the title keeps its
 * "(+N lines)" count, and a marker it already ends with survives the cut
 * (`boundedDisplayText`). A channel that must shrink further to fit its byte
 * budget calls again with a smaller `max`, never slices the result.
 */
export function osNotificationTitle(title: string, max?: number): string {
  return max === undefined
    ? displayJoinedLines(title)
    : boundedDisplayText(title, max);
}

export function osNotificationBody(
  body: string | undefined,
  max?: number,
): string | undefined {
  if (body === undefined) return undefined;
  const shown = displayMultilineText(body);
  return (max === undefined ? shown : truncateDisplay(shown, max)) || undefined;
}
