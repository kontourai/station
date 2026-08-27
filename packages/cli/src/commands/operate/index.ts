/**
 * `station operate` entry point (#168 Wave 2, Task 2A). Parses `--session`
 * (initial focus) and refuses to run outside an interactive terminal, then
 * hands off to `shell.ts`'s imperative shell, which owns the actual
 * SSE/keypress/repaint lifecycle. The "focus the first board row once the
 * snapshot arrives" fallback (when `--session` is omitted) is implemented
 * in `shell.ts` — it needs the live `orchestration:snapshot` frame to pick
 * a row from, which isn't available yet at CLI-arg-parsing time here.
 */
import type { ParsedCoreArgs } from '../core-api.js';
import { runOperateShell } from './shell.js';

export async function runOperateCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error(
      'station operate requires an interactive terminal (TTY); use station sessions/approvals/chat for scripting.',
    );
  }

  const focusedThreadId =
    typeof parsed.flags.session === 'string' ? parsed.flags.session : undefined;

  await runOperateShell({ apiBase, focusedThreadId });
}
