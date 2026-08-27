import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PERSISTED_RANDOM_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readValidIdentifier(path: string): Promise<string | undefined> {
  try {
    const identifier = (await readFile(path, 'utf8')).trim();
    return PERSISTED_RANDOM_IDENTIFIER_PATTERN.test(identifier)
      ? identifier
      : undefined;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Returns a SHA-256 digest of a random UUID persisted under STATION_HOME.
 *
 * Callers choose their filename deliberately. Product analytics and an
 * operator-configured OTel collector use separate identifiers so enabling both
 * does not create an undisclosed cross-system correlation key.
 */
export async function persistedRandomIdentifierHash(
  homeDir: string,
  filename: string,
  failureMessage = 'Persisted random identifier did not persist as a UUID.',
): Promise<string> {
  const configDir = join(homeDir, 'config');
  const path = join(configDir, filename);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);

  let identifier = await readValidIdentifier(path);
  if (!identifier) {
    const candidate = randomUUID();
    try {
      await writeFile(path, `${candidate}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      // The destination is authoritative even after a successful create.
      identifier = await readValidIdentifier(path);
    } catch (error: any) {
      if (error?.code === 'EEXIST')
        identifier = await readValidIdentifier(path);
      else throw error;
    }

    if (!identifier) {
      // A lock for a random, non-security identity would introduce stale-lock
      // recovery and crash failure modes. Atomically replace instead, then
      // always hash the destination that actually persisted.
      const replacement = `${path}.${randomUUID()}.tmp`;
      await writeFile(replacement, `${candidate}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(replacement, path);
      identifier = await readValidIdentifier(path);
    }
  }

  if (!identifier) throw new Error(failureMessage);
  await chmod(path, 0o600);
  return createHash('sha256').update(identifier).digest('hex');
}
