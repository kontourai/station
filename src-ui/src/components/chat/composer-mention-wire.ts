import { parseComposerMentions } from './composer-mentions';

const TOKEN_PREFIX = '@[m:';
const MAX_MENTIONS = 64;

export function expandComposerMentions(
  value: string,
  workspace?: string | null,
  authority?: string | null,
): { text?: string; error?: string } {
  if (!value.includes(TOKEN_PREFIX)) return { text: value };
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
  const resolvedWorkspace = workspace as string;
  let cursor = 0;
  let text = '';
  for (const mention of mentions) {
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
