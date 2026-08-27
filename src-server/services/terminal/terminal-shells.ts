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
