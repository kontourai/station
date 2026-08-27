/**
 * Claude Code's well-known model aliases (station#977). These are the
 * canonical short ids the Claude Agent SDK accepts directly — `originalId`
 * matches `id` because there is no separate wire-format id to translate to,
 * unlike the live catalog's dated model strings.
 */
export const CLAUDE_DEFAULT_MODEL = 'sonnet';

export const CLAUDE_KNOWN_MODELS: ReadonlyArray<{ id: string; name: string }> =
  [
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'opus', name: 'Opus' },
    { id: 'haiku', name: 'Haiku' },
  ];
