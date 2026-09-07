export interface CliBundleMetadata {
  version: string;
  sourceSha: string;
  channel: string;
  builtAt?: string;
}
export type CliGit = (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => string;
export function deriveCheckoutSourceSha(input: {
  packageDir: string;
  env: NodeJS.ProcessEnv;
  git: CliGit;
}): string;
export function deriveCliBundleMetadata(input: {
  packageDir: string;
  packageVersion: string;
  builtAt?: string;
  env?: NodeJS.ProcessEnv;
  git?: CliGit;
}): CliBundleMetadata;
