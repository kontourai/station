/**
 * Whether `value` is a programmatic tool NAME (`shell_exec`, `Bash`,
 * `mcp__github__create_issue`, `github/create-issue`) rather than display
 * text. Engines that report no programmatic name hand Station the call's
 * human title instead — an ACP call's `title`, which for OpenCode's shell tool
 * is the whole command line and for its file tools a path. Only a name is
 * safe to humanize; rewriting a title rewrites the command it quotes
 * (`ps -o pid` became `ps o pid`, `gate:for -- x` lost its `--`).
 */
export function isProgrammaticToolName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9]*(?:(?:[-_]+|\/)[A-Za-z0-9]+)*$/.test(value.trim())
  );
}

/**
 * Human-readable tool-name normalization shared by the streaming progress
 * indicator and the collapsed tool-call batch summary (`tool-call-groups.ts`)
 * — one label vocabulary, not two parallel ones.
 *
 * A programmatic name has its underscores humanized (`shell_exec` →
 * `shell exec`). Hyphens are kept: a hyphenated single token is as often a
 * command or file name (`git-lfs`, `docker-compose`) as a tool name, and
 * `create-issue` reads fine as written. Anything else is display text the engine already wrote for a
 * person — a command line, a path — and is returned as written, with only
 * its whitespace collapsed onto one line.
 */
export function formatToolName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'tool';
  }
  const trimmed = value.trim();
  if (!isProgrammaticToolName(trimmed)) return trimmed.replace(/\s+/g, ' ');
  return trimmed.replace(/_+/g, ' ').replace(/\s+/g, ' ');
}
