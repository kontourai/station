import {
  displayJoinedLines,
  displayMultilineText,
} from '@kontourai/station-shared/display-text';

/**
 * #3382: what an OS notification (web push, the desktop feed, APNs, FCM)
 * shows of a notification's title and body. Both can carry engine text (a
 * Codex approval's title is its command), so they are put in display form,
 * as the in-app surfaces put them: no bidi overrides or invisible
 * characters, controls as spaces. The title stays one line (its lines kept
 * apart with " ⏎ "); the body keeps its line breaks. Bounds stay with each
 * channel.
 */
export function osNotificationTitle(title: string): string {
  return displayJoinedLines(title);
}

export function osNotificationBody(
  body: string | undefined,
): string | undefined {
  if (body === undefined) return undefined;
  return displayMultilineText(body) || undefined;
}
