import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { sanitizedGitEnvironment } from '../../scripts/lib/git-environment.mjs';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const BUILD_CHANNEL = /^[a-z][a-z0-9-]{0,31}$/;

function runGit(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 10_000,
    env,
  }).trim();
}

export function deriveCliBundleMetadata({
  packageDir,
  packageVersion,
  env = process.env,
  git = runGit,
} = {}) {
  const sourceInput = env.STATION_CLI_SOURCE_SHA;
  const sourceSha =
    sourceInput !== undefined
      ? FULL_GIT_SHA.test(sourceInput.trim())
        ? sourceInput.trim().toLowerCase()
        : 'source-unavailable'
      : deriveCheckoutSourceSha({ packageDir, env, git });
  const requestedChannel = env.STATION_CLI_BUILD_CHANNEL?.trim();
  return {
    version: packageVersion,
    sourceSha,
    // This is a CLI artifact input, never the backend's STATION_CHANNEL.
    channel:
      requestedChannel && BUILD_CHANNEL.test(requestedChannel)
        ? requestedChannel
        : 'development',
  };
}

export function deriveCheckoutSourceSha({ packageDir, env, git }) {
  const cwd = join(packageDir, '..', '..');
  const gitEnvironment = sanitizedGitEnvironment(env);
  try {
    const sha = git(['rev-parse', 'HEAD'], cwd, gitEnvironment);
    if (!FULL_GIT_SHA.test(sha)) return 'source-unavailable';
    // Porcelain detects staged, unstaged, and untracked source changes. If
    // Git cannot determine this state, do not stamp a falsely clean revision.
    const status = git(
      ['status', '--porcelain=v1', '--untracked-files=all'],
      cwd,
      gitEnvironment,
    );
    return status.length > 0 ? `${sha.toLowerCase()}-dirty` : sha.toLowerCase();
  } catch {
    return 'source-unavailable';
  }
}
