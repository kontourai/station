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

type MentionIdentity = Omit<
  ComposerMention,
  'canonicalStart' | 'canonicalEnd' | 'displayStart' | 'displayEnd'
>;
const MENTION =
  /@\[m:([^|\]]{1,1536})\|([^|\]]{1,12288})\|([^|\]]{1,12288})\|([^|\]]{1,12288})\|(file|directory)\]/gu;
const MAX_MENTIONS = 64;
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
    const displayStart = canonicalStart - hiddenBefore;
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

export function composerDisplayValue(value: string): string {
  if (!value.includes('@[m:')) return value;
  let cursor = 0;
  let result = '';
  for (const mention of parseComposerMentions(value)) {
    result += value.slice(cursor, mention.canonicalStart);
    result += `@${mention.label.replaceAll(/\s/gu, ' ')}`;
    cursor = mention.canonicalEnd;
  }
  return result + value.slice(cursor);
}

function displayToCanonical(
  value: string,
  offset: number,
  endAffinity: boolean,
): number {
  const mentions = parseComposerMentions(value);
  for (const mention of mentions) {
    if (offset < mention.displayStart) break;
    if (offset <= mention.displayEnd) {
      if (offset === mention.displayStart) return mention.canonicalStart;
      if (offset === mention.displayEnd) return mention.canonicalEnd;
      return endAffinity ? mention.canonicalEnd : mention.canonicalStart;
    }
  }
  const hidden = mentions
    .filter((mention) => mention.displayEnd <= offset)
    .reduce(
      (sum, mention) =>
        sum -
        (mention.canonicalEnd -
          mention.canonicalStart -
          (mention.label.length + 1)),
      0,
    );
  return offset - hidden;
}

export function reconcileComposerDisplay(
  previous: string,
  nextDisplay: string,
): string {
  if (!previous.includes('@[m:')) return nextDisplay;
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
    parseComposerMentions(previous).some(
      (mention) =>
        (changedStart > mention.displayStart &&
          changedStart < mention.displayEnd) ||
        (changedEnd > mention.displayStart && changedEnd < mention.displayEnd),
    )
  ) {
    const delta = nextDisplay.length - previousDisplay.length;
    let preserved = nextDisplay;
    const unaffected = parseComposerMentions(previous).filter(
      (mention) =>
        mention.displayEnd <= changedStart ||
        mention.displayStart >= changedEnd,
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
  return length;
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
