import { ACPCommandNotFoundError } from './acp-process.js';

/**
 * Why an engine check failed, as people read it: the setup dialog, the
 * engine card and Retry check show `lastError.message`. Names the engine,
 * says what happened in plain words, and never says "ACP" (the protocol is
 * not a user concept). The raw error stays in the server log.
 */
export function engineFacingProbeMessage(
  error: unknown,
  engine: { name: string; command: string },
): string {
  if (error instanceof ACPCommandNotFoundError) return error.message;
  const { budgetMs, code, syscall } = (error ?? {}) as {
    budgetMs?: unknown;
    code?: unknown;
    syscall?: unknown;
  };
  if (typeof budgetMs === 'number') {
    return `${engine.name} didn't answer within ${waitPhrase(budgetMs)}.`;
  }
  if (
    code === 'EACCES' &&
    typeof syscall === 'string' &&
    syscall.startsWith('spawn')
  ) {
    return `Station could not run ${engine.command}: it is not executable on the computer Station runs on. Make it executable, then check the engine again.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'ACP connection closed') {
    return `${engine.name} closed the connection before it finished starting.`;
  }
  return /\bACP\b/.test(message)
    ? `${engine.name}: ${message.replace(/\bACP\b\s*/g, '')}`
    : message;
}

function waitPhrase(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
