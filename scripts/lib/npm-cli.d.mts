export function resolveNpmCli(env?: NodeJS.ProcessEnv, node?: string): string;
export function npmInvocation(
  npmArgs: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    node?: string;
    platform?: NodeJS.Platform;
  },
): { command: string; args: string[] };
