import { errorMessage } from '../../utils/error-message.js';

/**
 * How an ACP session injects mid-turn user input.
 *
 * Native channels (`_session/steer`, `_x.ai/interject`) are additive: the
 * in-flight `session/prompt` keeps running. The T3-style fallback cancels
 * that prompt and re-prompts on the same Station turn id — interruptive, but
 * still a steer (same turn), not a queued follow-up.
 */
export type AcpSteerChannel = 'session-steer' | 'interject' | 'cancel-reprompt';

export const ACP_SESSION_STEER_METHOD = '_session/steer';
export const ACP_INTERJECT_METHODS = [
  '_x.ai/interject',
  'x.ai/interject',
] as const;

export function resolveAcpSteerChannel(input: {
  command?: string;
  args?: readonly string[];
  agentName?: string;
}): AcpSteerChannel {
  const haystack = [input.command, ...(input.args ?? []), input.agentName]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase();
  if (
    haystack.includes('grok') ||
    haystack.includes('xai') ||
    haystack.includes('x.ai')
  ) {
    return 'interject';
  }
  if (haystack.includes('kiro')) {
    return 'session-steer';
  }
  return 'cancel-reprompt';
}

export function isAcpMethodNotFound(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === -32601
  ) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('method not found') ||
    message.includes('-32601') ||
    message.includes('unknown method') ||
    message.includes('unknown ext_method') ||
    message.includes('method not supported')
  );
}

export function acpSessionSteerParams(
  sessionId: string,
  input: string,
): Record<string, unknown> {
  return {
    sessionId,
    message: `<user_message>\n${input}\n</user_message>`,
  };
}

export function acpInterjectParams(
  sessionId: string,
  input: string,
): Record<string, unknown> {
  return { sessionId, text: input };
}
