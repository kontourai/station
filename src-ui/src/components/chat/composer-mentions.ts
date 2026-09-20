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
const COMPOSER_TOKEN = /@\[(m|r):([^\]]{1,49152})\]/gu;
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

function decodeMentionFields(fields: string[]): MentionIdentity | null {
  try {
    if (fields.length !== 5) return null;
    const identity: MentionIdentity = {
      label: decodeURIComponent(fields[0]),
      path: decodeURIComponent(fields[1]),
      workspace: decodeURIComponent(fields[2]),
      authority: decodeURIComponent(fields[3]),
      type: fields[4] as MentionIdentity['type'],
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

function parseComposerTokens(value: string): ComposerToken[] {
  if (!value.includes('@[m:') && !value.includes('@[r:')) return [];
  const tokens: ComposerToken[] = [];
  let mentionCount = 0;
  let referenceCount = 0;
  let hiddenBefore = 0;
  for (const match of value.matchAll(COMPOSER_TOKEN)) {
    if (match.index === undefined) continue;
    const fields = match[2].split('|');
    let identity:
      | MentionIdentity
      | Omit<
          ComposerSessionReference,
          'canonicalStart' | 'canonicalEnd' | 'displayStart' | 'displayEnd'
        >
      | null = null;
    if (match[1] === 'm' && mentionCount < MAX_MENTIONS) {
      identity = decodeMentionFields(fields);
      if (identity) mentionCount += 1;
    } else if (match[1] === 'r' && referenceCount < MAX_SESSION_REFERENCES) {
      try {
        if (fields.length !== 4) continue;
        const label = decodeURIComponent(fields[0]);
        const conversationId = decodeURIComponent(fields[1]);
        const projectSlug = decodeURIComponent(fields[2]) || undefined;
        const authority = decodeURIComponent(fields[3]);
        if (!label || !conversationId || !authority) continue;
        identity = {
          label: label.slice(0, MAX_LABEL_CHARS),
          conversationId,
          ...(projectSlug ? { projectSlug } : {}),
          authority,
        };
        referenceCount += 1;
      } catch {
        identity = null;
      }
    }
    if (!identity) continue;
    const canonicalStart = match.index;
    const canonicalEnd = canonicalStart + match[0].length;
    const displayStart = canonicalStart - hiddenBefore;
    const displayEnd = displayStart + identity.label.length + 1;
    hiddenBefore += match[0].length - (identity.label.length + 1);
    tokens.push({
      ...identity,
      canonicalStart,
      canonicalEnd,
      displayStart,
      displayEnd,
    });
  }
  return tokens;
}

export function parseComposerMentions(value: string): ComposerMention[] {
  return parseComposerTokens(value).filter(
    (token): token is ComposerMention => 'path' in token,
  );
}

export function parseComposerSessionReferences(
  value: string,
): ComposerSessionReference[] {
  return parseComposerTokens(value).filter(
    (token): token is ComposerSessionReference => 'conversationId' in token,
  );
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
  const tokens = [
    ...parseComposerMentions(previous),
    ...parseComposerSessionReferences(previous),
  ].sort((a, b) => a.displayStart - b.displayStart);
  let searchFrom = 0;
  const retained: Array<{ token: ComposerToken; start: number }> = [];
  for (const token of tokens) {
    const visible = `@${token.label.replaceAll(/\s/gu, ' ')}`;
    const start = nextDisplay.indexOf(visible, searchFrom);
    if (start < 0) continue;
    retained.push({ token, start });
    searchFrom = start + visible.length;
  }
  let preserved = nextDisplay;
  for (const { token, start } of retained.reverse()) {
    const end = start + token.label.replaceAll(/\s/gu, ' ').length + 1;
    preserved =
      preserved.slice(0, start) +
      previous.slice(token.canonicalStart, token.canonicalEnd) +
      preserved.slice(end);
  }
  return preserved;
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
