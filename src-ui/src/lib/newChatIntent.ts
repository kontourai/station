export const OPEN_NEW_CHAT_EVENT = 'station:open-new-chat';

export interface NewChatIntent {
  startWithDefault?: boolean;
  initialPrompt?: string;
  onClosed?: () => void;
}

export function readNewChatIntent(event: Event): NewChatIntent {
  const detail: unknown =
    event instanceof CustomEvent ? event.detail : undefined;
  if (!detail || typeof detail !== 'object') return {};
  const prompt = 'initialPrompt' in detail ? detail.initialPrompt : undefined;
  const callback = 'onClosed' in detail ? detail.onClosed : undefined;
  return {
    startWithDefault:
      'startWithDefault' in detail && detail.startWithDefault === true,
    initialPrompt: typeof prompt === 'string' ? prompt : undefined,
    onClosed: typeof callback === 'function' ? () => callback() : undefined,
  };
}
