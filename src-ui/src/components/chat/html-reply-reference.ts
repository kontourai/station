import type { HtmlReplyReference } from '@kontourai/station-contracts/html-reply';

/** Only the small tool result is projected; page bytes are read with current auth. */
export function htmlReplyReference(
  value: unknown,
  depth = 0,
): HtmlReplyReference | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return undefined;
    try {
      return htmlReplyReference(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  if ('htmlReply' in value) {
    const ref = value.htmlReply;
    if (
      ref &&
      typeof ref === 'object' &&
      'version' in ref &&
      ref.version === 1 &&
      'pageId' in ref &&
      typeof ref.pageId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(ref.pageId) &&
      'sessionId' in ref &&
      typeof ref.sessionId === 'string' &&
      ref.sessionId.length > 0 &&
      ref.sessionId.length <= 512
    )
      return { version: 1, pageId: ref.pageId, sessionId: ref.sessionId };
  }
  const nested = [
    'value' in value ? value.value : undefined,
    'structuredContent' in value ? value.structuredContent : undefined,
    'output' in value ? value.output : undefined,
    'result' in value ? value.result : undefined,
    'text' in value ? value.text : undefined,
  ];
  for (const candidate of nested) {
    const reference = htmlReplyReference(candidate, depth + 1);
    if (reference) return reference;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = htmlReplyReference(item, depth + 1);
      if (ref) return ref;
    }
  }
  if ('content' in value && Array.isArray(value.content))
    for (const item of value.content) {
      const ref = htmlReplyReference(item, depth + 1);
      if (ref) return ref;
    }
  return undefined;
}
