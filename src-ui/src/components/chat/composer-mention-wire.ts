import {
  canonicalSessionReferenceUrl,
  parseComposerMentions,
  parseComposerSessionReferences,
  safeSessionReferenceLabel,
} from './composer-mentions';

const TOKEN_PREFIX = '@[m:';
const REFERENCE_TOKEN_PREFIX = '@[r:';
const MAX_MENTIONS = 64;

export function expandComposerMentions(
  value: string,
  workspace?: string | null,
  authority?: string | null,
): { text?: string; error?: string } {
  if (!value.includes(TOKEN_PREFIX) && !value.includes(REFERENCE_TOKEN_PREFIX))
    return { text: value };
  const encodedCount = value.split(TOKEN_PREFIX).length - 1;
  if (encodedCount > MAX_MENTIONS)
    return {
      error: `A prompt can include at most ${MAX_MENTIONS} file mentions.`,
    };
  const mentions = parseComposerMentions(value);
  if (encodedCount !== mentions.length)
    return {
      error:
        'A saved file mention is damaged. Remove its visible token and select the file again.',
    };
  if (
    mentions.some(
      (mention) =>
        !workspace ||
        !authority ||
        mention.workspace !== workspace ||
        mention.authority !== authority,
    )
  )
    return {
      error:
        'A file mention belongs to a different Station or workspace. Remove it or return to that scope before sending.',
    };
  const encodedReferenceCount = value.split(REFERENCE_TOKEN_PREFIX).length - 1;
  const references = parseComposerSessionReferences(value);
  if (encodedReferenceCount !== references.length)
    return {
      error:
        'A saved conversation reference is damaged. Remove its visible token and select the conversation again.',
    };
  if (
    references.some(
      (reference) => !authority || reference.authority !== authority,
    )
  )
    return {
      error:
        'A conversation reference belongs to a different Station access scope. Remove it or return to that scope before sending.',
    };
  const resolvedWorkspace = workspace as string;
  let cursor = 0;
  let text = '';
  const tokens = [
    ...mentions.map((mention) => ({
      kind: 'mention' as const,
      token: mention,
    })),
    ...references.map((reference) => ({
      kind: 'reference' as const,
      token: reference,
    })),
  ].sort((a, b) => a.token.canonicalStart - b.token.canonicalStart);
  for (const item of tokens) {
    if (item.kind === 'reference') {
      const reference = item.token;
      text += value.slice(cursor, reference.canonicalStart);
      text += `[${safeSessionReferenceLabel(reference.label)}](${canonicalSessionReferenceUrl(reference.conversationId)})`;
      cursor = reference.canonicalEnd;
      continue;
    }
    const mention = item.token;
    const parts = mention.path.split(/[\\/]/u);
    if (
      mention.path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/u.test(mention.path) ||
      parts.some((part) => part === '..' || part.includes('\0'))
    )
      return {
        error:
          'A file mention no longer has a safe project-relative path. Remove it and select the file again.',
      };
    const separator = resolvedWorkspace.includes('\\') ? '\\' : '/';
    const fullPath = `${resolvedWorkspace.replace(/[\\/]+$/u, '')}${separator}${mention.path.replaceAll(/[\\/]/gu, separator)}`;
    text += value.slice(cursor, mention.canonicalStart);
    text += `@${JSON.stringify(fullPath)}`;
    cursor = mention.canonicalEnd;
  }
  return { text: text + value.slice(cursor) };
}
