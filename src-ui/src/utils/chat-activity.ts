import type { ChatActivityHint } from '../contexts/active-chats-state';

export function retryActivityLabel(hint: ChatActivityHint): string {
  const attempt =
    hint.attempt === undefined ? '' : ` · attempt ${hint.attempt}`;
  const delay =
    hint.delayMs === undefined ? '' : ` · delay ${hint.delayMs / 1000}s`;
  return `Retrying${attempt}${delay}${hint.detail ? ` · ${hint.detail}` : ''}`;
}
