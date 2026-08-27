import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_NODE_MAJOR = 24;
export const SUPPORTED_NODE_RANGE = '24.x';

export function nodeMajor(version) {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

export function nodeRuntimeError(version) {
  return `Station requires Node.js ${SUPPORTED_NODE_RANGE} (found ${version}). Run \`nvm install ${SUPPORTED_NODE_MAJOR} && nvm use ${SUPPORTED_NODE_MAJOR}\`, or install the version in .nvmrc with your Node version manager.`;
}

export function assertSupportedNode(version = process.version) {
  if (nodeMajor(version) !== SUPPORTED_NODE_MAJOR) {
    throw new Error(nodeRuntimeError(version));
  }
}

export function assertManifestContract(
  packageJsonUrl = new URL('../package.json', import.meta.url),
) {
  const manifest = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  if (manifest.engines?.node !== SUPPORTED_NODE_RANGE) {
    throw new Error(
      `package.json engines.node must be ${SUPPORTED_NODE_RANGE}; found ${manifest.engines?.node ?? 'missing'}.`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    assertManifestContract();
    assertSupportedNode();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
