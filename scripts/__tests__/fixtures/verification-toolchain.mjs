import { createHash } from 'node:crypto';

/**
 * Deterministic receipt-only stand-in for the full identity returned by
 * `resolveVerificationToolchain()`. These fixture paths are never executed.
 */
const identity = {
  node: {
    path: '/fixture/toolchain/node',
    device: 101,
    inode: 102,
    size: 103,
    mtimeMs: 104,
  },
  npm: {
    path: '/fixture/toolchain/npm-cli.js',
    device: 201,
    inode: 202,
    size: 203,
    mtimeMs: 204,
    sha256: 'a'.repeat(64),
  },
};

export const FIXTURE_TOOLCHAIN_IDENTITY = Object.freeze({
  ...identity,
  digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
});
