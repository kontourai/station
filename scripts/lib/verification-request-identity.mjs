import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';

export const VERIFICATION_RECEIPT_ROOT = '.kontourai/verification-receipts';
const COMPLETION_LOCK_NAME = 'full-regression.lock';
const COMPLETION_QUEUE_LOCK_NAME = 'full-regression.queue.lock';

export function requestDirectoryKey(directory, platform = process.platform) {
  return platform === 'win32' ? win32.basename(directory) : basename(directory);
}

export function verificationIdentityDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function defaultCoordinatorRoot({ env = process.env } = {}) {
  if (env.STATION_VITEST_RUN_ROOT)
    return join(env.STATION_VITEST_RUN_ROOT, 'verification-coordinator', 'v1');
  const cache = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(
    cache || tmpdir(),
    'kontourai-station',
    'verification-coordinator',
    'v1',
  );
}

export function jobDirectory(root, requestKey) {
  return join(root, 'requests', requestKey);
}

export function outputDirectory(root, request) {
  return join(
    root,
    'outputs',
    verificationIdentityDigest(`${request.repositoryId}:${request.worktree}`),
  );
}

export function completionLockDirectory(root) {
  return join(root, COMPLETION_LOCK_NAME);
}

export function completionQueueLockDirectory(root) {
  return join(root, COMPLETION_QUEUE_LOCK_NAME);
}

export function executionEquivalenceKey(request) {
  return verificationIdentityDigest(
    JSON.stringify({
      repositoryId: request.repositoryId,
      headSha: request.headSha,
      workspaceDigest: request.workspaceDigest,
      environmentDigest: request.environmentDigest,
      laneId: request.laneId,
      command: request.command,
      manifestDigest: request.manifestDigest,
      dependencyDigest: request.dependencyDigest,
      nodeVersion: request.nodeVersion,
      toolchain: request.toolchain,
      toolchainIdentity: request.toolchainIdentity,
      platform: request.platform,
      arch: request.arch,
    }),
  );
}

export function receiptPath(worktree, requestKey, force) {
  const suffix = force ? `diagnostic-${randomUUID()}` : 'canonical';
  return join(
    worktree,
    VERIFICATION_RECEIPT_ROOT,
    `${requestKey}.${suffix}.json`,
  );
}

export function receiptRelativePath(worktree, absolute) {
  return absolute.slice(resolve(worktree).length + 1).replaceAll('\\', '/');
}
