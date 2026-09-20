export interface ComposerMention {
  label: string;
  path: string;
  workspace: string;
  authority: string;
  type: 'file' | 'directory';
  canonicalStart: number;
  canonicalEnd: number;
  displayStart: number;
  displayEnd: number;
}

export interface ComposerSessionReference {
  label: string;
  conversationId: string;
  projectSlug?: string;
  authority: string;
  canonicalStart: number;
  canonicalEnd: number;
  displayStart: number;
  displayEnd: number;
}

export type ComposerToken = ComposerMention | ComposerSessionReference;

type MentionIdentity = Omit<
  ComposerMention,
  'canonicalStart' | 'canonicalEnd' | 'displayStart' | 'displayEnd'
>;
const MENTION =
  /@\[m:([^|\]]{1,1536})\|([^|\]]{1,12288})\|([^|\]]{1,12288})\|([^|\]]{1,12288})\|(file|directory)\]/gu;
const SESSION_REFERENCE =
  /@\[r:([^|\]]{1,1536})\|([^|\]]{1,1536})\|([^|\]]{0,1536})\|([^|\]]{1,12288})\]/gu;
const MAX_MENTIONS = 64;
export const MAX_SESSION_REFERENCES = 8;
const MAX_LABEL_CHARS = 512;
const MAX_PATH_CHARS = 4096;
const MAX_SCOPE_CHARS = 4096;

export function durableMentionAuthority(input: {
  apiBase: string;
  connectionId: string;
  authorityGeneration: number;
  credentialState: string;
}): string {
  return JSON.stringify(input);
}

function strictEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeIdentity(match: RegExpMatchArray): MentionIdentity | null {
  try {
    const identity: MentionIdentity = {
      label: decodeURIComponent(match[1]),
      path: decodeURIComponent(match[2]),
      workspace: decodeURIComponent(match[3]),
      authority: decodeURIComponent(match[4]),
      type: match[5] as MentionIdentity['type'],
    };
    if (
      !identity.label ||
      !identity.path ||
      !identity.workspace ||
      !identity.authority ||
      identity.label.length > MAX_LABEL_CHARS ||
      identity.path.length > MAX_PATH_CHARS ||
      identity.workspace.length > MAX_SCOPE_CHARS ||
      identity.authority.length > MAX_SCOPE_CHARS
    )
      return null;
    return identity;
  } catch {
    return null;
  }
}

export function mentionToken(input: MentionIdentity): string {
  if (
    !input.label ||
    !input.path ||
    !input.workspace ||
    !input.authority ||
    input.label.length > MAX_LABEL_CHARS ||
    input.path.length > MAX_PATH_CHARS ||
    input.workspace.length > MAX_SCOPE_CHARS ||
    input.authority.length > MAX_SCOPE_CHARS
  )
    throw new Error('File mention exceeds its bounded metadata contract');
  return `@[m:${strictEncode(input.label)}|${strictEncode(input.path)}|${strictEncode(input.workspace)}|${strictEncode(input.authority)}|${input.type}]`;
}

export function parseComposerMentions(value: string): ComposerMention[] {
  if (!value.includes('@[m:')) return [];
  const mentions: ComposerMention[] = [];
  let hiddenBefore = 0;
  for (const match of value.matchAll(MENTION)) {
    if (mentions.length >= MAX_MENTIONS) break;
    const identity = decodeIdentity(match);
    if (!identity || match.index === undefined) continue;
    const canonicalStart = match.index;
    const canonicalEnd = canonicalStart + match[0].length;
    const referenceHiddenBefore = rawSessionReferences(value)
      .filter((reference) => reference.canonicalEnd <= canonicalStart)
      .reduce(
        (sum, reference) =>
          sum -
          (reference.canonicalEnd -
            reference.canonicalStart -
            (reference.label.length + 1)),
        0,
      );
    const displayStart = canonicalStart - hiddenBefore - referenceHiddenBefore;
    const displayEnd = displayStart + identity.label.length + 1;
    hiddenBefore += match[0].length - (identity.label.length + 1);
    mentions.push({
      ...identity,
      canonicalStart,
      canonicalEnd,
      displayStart,
      displayEnd,
    });
  }
  return mentions;
}

function rawSessionReferences(value: string): Array<{
  label: string;
  conversationId: string;
  projectSlug?: string;
  authority: string;
  canonicalStart: number;
  canonicalEnd: number;
}> {
  if (!value.includes('@[r:')) return [];
  const raw: ReturnType<typeof rawSessionReferences> = [];
  for (const match of value.matchAll(SESSION_REFERENCE)) {
    if (raw.length >= MAX_SESSION_REFERENCES || match.index === undefined)
      break;
    try {
      const label = decodeURIComponent(match[1]);
      const conversationId = decodeURIComponent(match[2]);
      const projectSlug = decodeURIComponent(match[3]) || undefined;
      const authority = decodeURIComponent(match[4]);
      if (!label || !conversationId || !authority) continue;
      raw.push({
        label: label.slice(0, MAX_LABEL_CHARS),
        conversationId,
        ...(projectSlug ? { projectSlug } : {}),
        authority,
        canonicalStart: match.index,
        canonicalEnd: match.index + match[0].length,
      });
    } catch {}
  }
  return raw;
}

export function parseComposerSessionReferences(
  value: string,
): ComposerSessionReference[] {
  if (!value.includes('@[r:')) return [];
  return positionComposerTokens(
    value,
    rawSessionReferences(value),
  ) as ComposerSessionReference[];
}

function positionComposerTokens<
  T extends { canonicalStart: number; canonicalEnd: number; label: string },
>(
  value: string,
  selected: T[],
): Array<T & { displayStart: number; displayEnd: number }> {
  const all = [
    ...parseComposerMentions(value).map((token) => ({
      ...token,
      marker: 'mention' as const,
    })),
    ...selected.map((token) => ({ ...token, marker: 'reference' as const })),
  ].sort((a, b) => a.canonicalStart - b.canonicalStart);
  let hiddenBefore = 0;
  const positioned = new Map<
    number,
    { displayStart: number; displayEnd: number }
  >();
  for (const token of all) {
    const visibleLength = token.label.length + 1;
    const displayStart = token.canonicalStart - hiddenBefore;
    const displayEnd = displayStart + visibleLength;
    hiddenBefore += token.canonicalEnd - token.canonicalStart - visibleLength;
    if (token.marker === 'reference')
      positioned.set(token.canonicalStart, { displayStart, displayEnd });
  }
  return selected.map((token) => ({
    ...token,
    ...positioned.get(token.canonicalStart)!,
  }));
}

export function sessionReferenceToken(input: {
  label: string;
  conversationId: string;
  projectSlug?: string;
  authority: string;
}): string {
  if (!input.label || !input.conversationId || !input.authority)
    throw new Error('Session reference requires bounded identity metadata');
  return `@[r:${strictEncode(input.label.slice(0, MAX_LABEL_CHARS))}|${strictEncode(input.conversationId)}|${strictEncode(input.projectSlug ?? '')}|${strictEncode(input.authority)}]`;
}

export function sessionReferenceBlockReason(input: {
  value: string;
  conversationId: string;
  activeConversationId?: string;
  authority?: string | null;
  isCurrent?: () => boolean;
}): string | null {
  if (!input.authority || input.isCurrent?.() === false)
    return 'Conversation references are unavailable because this Station access changed.';
  if (input.conversationId === input.activeConversationId)
    return 'This conversation is already open.';
  const references = parseComposerSessionReferences(input.value);
  if (
    references.some(
      (reference) => reference.conversationId === input.conversationId,
    )
  )
    return 'This conversation is already referenced.';
  if (references.length >= MAX_SESSION_REFERENCES)
    return `A message can reference at most ${MAX_SESSION_REFERENCES} conversations.`;
  return null;
}

export function appendComposerSessionReference(
  value: string,
  reference: Parameters<typeof sessionReferenceToken>[0],
): string {
  const separator = value.length === 0 || /\s$/u.test(value) ? '' : ' ';
  return `${value}${separator}${sessionReferenceToken(reference)} `;
}

export function composerDisplayValue(value: string): string {
  if (!value.includes('@[m:') && !value.includes('@[r:')) return value;
  let cursor = 0;
  let result = '';
  const tokens = [
    ...parseComposerMentions(value),
    ...parseComposerSessionReferences(value),
  ].sort((a, b) => a.canonicalStart - b.canonicalStart);
  for (const token of tokens) {
    result += value.slice(cursor, token.canonicalStart);
    result += `@${token.label.replaceAll(/\s/gu, ' ')}`;
    cursor = token.canonicalEnd;
  }
  return result + value.slice(cursor);
}

function displayToCanonical(
  value: string,
  offset: number,
  endAffinity: boolean,
): number {
  const tokens = [
    ...parseComposerMentions(value),
    ...parseComposerSessionReferences(value),
  ].sort((a, b) => a.displayStart - b.displayStart);
  for (const token of tokens) {
    if (offset < token.displayStart) break;
    if (offset <= token.displayEnd) {
      if (offset === token.displayStart) return token.canonicalStart;
      if (offset === token.displayEnd) return token.canonicalEnd;
      return endAffinity ? token.canonicalEnd : token.canonicalStart;
    }
  }
  const hidden = tokens
    .filter((token) => token.displayEnd <= offset)
    .reduce(
      (sum, token) =>
        sum -
        (token.canonicalEnd - token.canonicalStart - (token.label.length + 1)),
      0,
    );
  return offset - hidden;
}

export function reconcileComposerDisplay(
  previous: string,
  nextDisplay: string,
): string {
  if (!previous.includes('@[m:') && !previous.includes('@[r:'))
    return nextDisplay;
  const previousDisplay = composerDisplayValue(previous);
  let prefix = 0;
  while (
    prefix < previousDisplay.length &&
    prefix < nextDisplay.length &&
    previousDisplay[prefix] === nextDisplay[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < previousDisplay.length - prefix &&
    suffix < nextDisplay.length - prefix &&
    previousDisplay.at(-1 - suffix) === nextDisplay.at(-1 - suffix)
  )
    suffix += 1;
  const changedStart = prefix;
  const changedEnd = previousDisplay.length - suffix;
  if (
    [
      ...parseComposerMentions(previous),
      ...parseComposerSessionReferences(previous),
    ].some(
      (token) =>
        (changedStart > token.displayStart &&
          changedStart < token.displayEnd) ||
        (changedEnd > token.displayStart && changedEnd < token.displayEnd),
    )
  ) {
    const delta = nextDisplay.length - previousDisplay.length;
    let preserved = nextDisplay;
    const unaffected = [
      ...parseComposerMentions(previous),
      ...parseComposerSessionReferences(previous),
    ].filter(
      (token) =>
        token.displayEnd <= changedStart || token.displayStart >= changedEnd,
    );
    for (const mention of [...unaffected].reverse()) {
      const start =
        mention.displayStart >= changedEnd
          ? mention.displayStart + delta
          : mention.displayStart;
      const end = start + mention.label.length + 1;
      preserved =
        preserved.slice(0, start) +
        previous.slice(mention.canonicalStart, mention.canonicalEnd) +
        preserved.slice(end);
    }
    return preserved;
  }
  const start = displayToCanonical(previous, prefix, false);
  const end = displayToCanonical(
    previous,
    previousDisplay.length - suffix,
    true,
  );
  return (
    previous.slice(0, start) +
    nextDisplay.slice(prefix, nextDisplay.length - suffix) +
    previous.slice(end)
  );
}

export function composerMentionWireLength(value: string): number {
  let length = value.length;
  for (const mention of parseComposerMentions(value)) {
    const separator = mention.workspace.includes('\\') ? '\\' : '/';
    const fullPath = `${mention.workspace.replace(/[\\/]+$/u, '')}${separator}${mention.path.replaceAll(/[\\/]/gu, separator)}`;
    length +=
      JSON.stringify(fullPath).length +
      1 -
      (mention.canonicalEnd - mention.canonicalStart);
  }
  for (const reference of parseComposerSessionReferences(value)) {
    const url = canonicalSessionReferenceUrl(reference.conversationId);
    const label = safeSessionReferenceLabel(reference.label);
    length +=
      `[${label}](${url})`.length -
      (reference.canonicalEnd - reference.canonicalStart);
  }
  return length;
}

export function safeSessionReferenceLabel(label: string): string {
  return (
    label
      .replace(/[[\]()<>{}\\\r\n]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim() || 'Conversation'
  );
}

export function canonicalSessionReferenceUrl(conversationId: string): string {
  return `/activity?session=${encodeURIComponent(conversationId)}`;
}

export function mentionQueryAt(
  value: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = composerDisplayValue(value).slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  return match
    ? { start: cursor - match[1].length - 1, query: match[1] }
    : null;
}

export function insertComposerMention(
  value: string,
  displayStart: number,
  displayEnd: number,
  mention: MentionIdentity,
): string {
  if (parseComposerMentions(value).length >= MAX_MENTIONS) return value;
  const start = displayToCanonical(value, displayStart, false);
  const end = displayToCanonical(value, displayEnd, true);
  return `${value.slice(0, start)}${mentionToken(mention)} ${value.slice(end)}`;
}
