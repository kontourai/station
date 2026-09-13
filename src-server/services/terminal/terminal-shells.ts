export interface ShellCandidate {
  shell: string;
  args?: string[];
}

interface TerminalShellResolutionInput {
  configuredShell?: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export function resolveTerminalShellCandidates({
  configuredShell,
  platform,
  env,
}: TerminalShellResolutionInput): ShellCandidate[] {
  const candidates: ShellCandidate[] = [];
  if (configuredShell) candidates.push({ shell: configuredShell });
  if (env.SHELL) candidates.push({ shell: env.SHELL });
  if (platform === 'win32') {
    if (env.COMSPEC) candidates.push({ shell: env.COMSPEC });
    candidates.push(
      { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      { shell: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe' },
      { shell: 'C:\\cygwin64\\bin\\bash.exe' },
      { shell: 'C:\\cygwin\\bin\\bash.exe' },
      { shell: 'powershell.exe' },
      { shell: 'cmd.exe' },
    );
    return candidates;
  }
  candidates.push(
    { shell: '/bin/zsh', args: ['-o', 'nopromptsp'] },
    { shell: '/bin/bash' },
    { shell: '/bin/sh' },
  );
  return candidates;
}

/**
 * The shell Station tries FIRST on this host when `terminalShell` is unset —
 * the same list a spawn walks, with the configured value deliberately not
 * supplied.
 *
 * #1582 D9: the Settings "Terminal shell" input was blank with no hint, and a
 * hard-coded `/bin/zsh` placeholder would be wrong on any host whose `SHELL`
 * differs and on every Windows one. This is derived from the resolver itself,
 * so the two cannot disagree.
 *
 * Deliberately "tries first", not "uses": a spawn falls through to the next
 * candidate when one fails to start, and nothing here launches a process to
 * find out. `source` says whether the environment supplied it, so a caller can
 * attribute the value rather than assert an origin it did not compute.
 */
export function defaultTerminalShell(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): { shell: string; source: 'env' | 'platform-fallback' } | undefined {
  const first = resolveTerminalShellCandidates({
    platform: input.platform,
    env: input.env,
  })[0];
  if (!first) return undefined;
  const fromEnv =
    first.shell === input.env.SHELL ||
    (input.platform === 'win32' && first.shell === input.env.COMSPEC);
  return { shell: first.shell, source: fromEnv ? 'env' : 'platform-fallback' };
}
