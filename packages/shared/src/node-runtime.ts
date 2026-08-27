export const SUPPORTED_NODE_MAJOR = 24;
export const SUPPORTED_NODE_RANGE = '24.x';

export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isSupportedNodeVersion(version: string | null): boolean {
  return version !== null && nodeMajor(version) === SUPPORTED_NODE_MAJOR;
}

export function nodeRuntimeError(version: string): string {
  return `Station requires Node.js ${SUPPORTED_NODE_RANGE} (found ${version}). Run \`nvm install ${SUPPORTED_NODE_MAJOR} && nvm use ${SUPPORTED_NODE_MAJOR}\`, or install the version in .nvmrc with your Node version manager.`;
}

export function assertSupportedNodeVersion(version = process.version): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(nodeRuntimeError(version));
  }
}
