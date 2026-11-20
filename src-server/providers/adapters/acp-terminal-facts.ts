/**
 * `client.terminal-facts`: what Station's terminal bridge is, for an engine
 * that asks before it composes commands for it.
 *
 * Kiro's agent service asks `_kiro/terminal/shell_type {sessionId}` during
 * `session/new` and reads `{shellType}` (a non-empty string) as the grammar
 * its shell-command policy parses commands with: `sh`, `bash`, `zsh` and the
 * other POSIX shells read as `posix`; anything it does not know as `unknown`
 * (@kiro/agent 0.66.102 `resolveShellTypeInfo`, `toShellType`). Live
 * (kiro-cli 3.3.0 `--agent-engine v3`, 2026-11-13): `{shellType: 'sh'}` is
 * logged `shellType.resolved source: client`.
 *
 * The truthful answer is `sh`. Station's terminal bridge starts no shell: it
 * runs the command directly, reading a composed one-line command with POSIX
 * shell quoting (`splitComposedShellLine` in `acp-bridge-client.ts`). That is
 * POSIX grammar and no particular shell's, so naming the person's login shell
 * (`$SHELL`, say zsh) would claim features the bridge does not run.
 *
 * On Windows the bridge reads the same POSIX quoting, but no Windows shell
 * name says so, and claiming `sh` there would make the engine compose POSIX
 * commands for a host that may not have one. Nothing is answered (the request
 * is refused `-32601`, which the engine takes as `unknown`).
 */
export function acpTerminalShellType(
  platform: NodeJS.Platform = process.platform,
): { shellType: string } | undefined {
  return platform === 'win32' ? undefined : { shellType: 'sh' };
}

/**
 * The `client.terminal-facts` handler both the chat adapter's client and the
 * availability probe's client register: absent where nothing truthful can be
 * answered, so the request is refused and the engine reads `unknown`.
 */
export function acpTerminalFactsHandler(
  platform: NodeJS.Platform = process.platform,
): (() => { shellType: string }) | undefined {
  const shellType = acpTerminalShellType(platform);
  return shellType ? () => ({ ...shellType }) : undefined;
}
