/**
 * #4470: turns an error entry point's raw facts into the prepare seed.
 *
 * The seed carries the in-app path (no query or fragment), a short error
 * summary (code plus the message's first line, with known credential shapes,
 * URLs and filesystem paths removed), and the conversation and turn ids. It
 * never carries a stack. The host re-checks every field and refuses an
 * over-limit one; this builder only produces seeds that fit.
 */

import {
  MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
  TROUBLESHOOT_SEED_ID_PATTERN,
  type TroubleshootSeed,
} from '@kontourai/station-contracts/troubleshoot';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import type { TroubleshootRequest } from '../../lib/troubleshootEvents';

/** A summary, not a log: well under the host's 2,000-character limit. */
export const TROUBLESHOOT_SUMMARY_LENGTH = 300;

const STACK_FRAME = /^\s*at\s/;

function firstMessageLine(message: string): string {
  return (
    message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !STACK_FRAME.test(line)) ?? ''
  );
}

function errorSummary(request: TroubleshootRequest): string | undefined {
  const code =
    request.code === undefined || request.code === ''
      ? ''
      : // A code is one token; a multi-line one may carry a stack.
        (String(request.code).split(/\r?\n/)[0] ?? '').trim();
  // Sanitized apart, then joined: the shared redactor reads a leading
  // `CODE: ` as a non-secret `key: value` pair and would skip any credential
  // pair later in the message.
  const safeCode = code
    ? sanitizeFreeText(code, TROUBLESHOOT_SUMMARY_LENGTH)
    : '';
  const message = firstMessageLine(request.message ?? '');
  const safeMessage = message
    ? sanitizeFreeText(message, TROUBLESHOOT_SUMMARY_LENGTH)
    : '';
  const text =
    safeCode && safeMessage
      ? `${safeCode}: ${safeMessage}`
      : safeCode || safeMessage;
  return text ? text.slice(0, TROUBLESHOOT_SUMMARY_LENGTH) : undefined;
}

/**
 * An id outside the host's bounds is left out rather than sent: the host
 * would refuse the whole seed, and troubleshooting without the id is still
 * useful.
 */
function seedId(value: string | undefined, limit: number): string | undefined {
  return value &&
    value.length <= limit &&
    TROUBLESHOOT_SEED_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export function buildTroubleshootSeed(
  request: TroubleshootRequest,
  pathname: string,
): TroubleshootSeed {
  const route =
    pathname.startsWith('/') &&
    !pathname.startsWith('//') &&
    pathname.length <= MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH
      ? pathname
      : undefined;
  const summary = errorSummary(request);
  const conversationId = seedId(
    request.conversationId,
    MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  );
  const turnId = seedId(request.turnId, MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH);
  return {
    ...(route ? { route } : {}),
    ...(summary ? { errorSummary: summary } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/**
 * The open event's seed: none for an event with no facts (help menu, palette,
 * Settings), else the facts plus the route at dispatch time. The host runs
 * exactly this, so entry-point tests can assert the seed the flow receives.
 */
export function troubleshootSeedFromEvent(
  event: Event,
): TroubleshootSeed | undefined {
  const request = (event as CustomEvent<TroubleshootRequest | undefined>)
    .detail;
  return request
    ? buildTroubleshootSeed(request, window.location.pathname)
    : undefined;
}
