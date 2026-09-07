const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export function parseRegistryGitHead(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('npm registry gitHead response was not valid JSON.');
  }
  if (typeof value !== 'string' || !FULL_GIT_SHA.test(value)) {
    throw new Error(
      'npm registry gitHead must be a lowercase 40-character Git SHA.',
    );
  }
  return value;
}

export function assertRegistryGitHeadMatchesSource(registryGitHead, sourceSha) {
  if (!FULL_GIT_SHA.test(sourceSha)) {
    throw new Error(
      'Expected source SHA must be a lowercase 40-character Git SHA.',
    );
  }
  if (registryGitHead !== sourceSha) {
    throw new Error(
      `npm registry gitHead ${registryGitHead} does not match source SHA ${sourceSha}.`,
    );
  }
  return registryGitHead;
}
