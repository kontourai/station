import { createHash } from 'node:crypto';
import { type BigIntStats, constants, lstatSync, realpathSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const EXECUTABLE_READ_BYTES = 1024 * 1024;

function identity(value: BigIntStats): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(
    ':',
  );
}

async function observeFile(path: string) {
  if (!isAbsolute(path)) return undefined;
  const canonical = await realpath(path);
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_EXECUTABLE_BYTES))
      return undefined;
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(EXECUTABLE_READ_BYTES);
    let length = 0;
    let shebang = false;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      if (length === 0) shebang = buffer[0] === 35 && buffer[1] === 33;
      length += read.bytesRead;
      if (length > MAX_EXECUTABLE_BYTES) return undefined;
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat({ bigint: true });
    const named = await stat(canonical, { bigint: true });
    if (
      identity(before) !== identity(after) ||
      identity(after) !== identity(named) ||
      BigInt(length) !== before.size ||
      (await realpath(path)) !== canonical
    )
      return undefined;
    return {
      path,
      canonical,
      identity: identity(after),
      sha256: digest.digest('hex'),
      script:
        shebang ||
        ['.js', '.mjs', '.cjs'].includes(extname(canonical).toLowerCase()),
    };
  } finally {
    await file.close();
  }
}

/** Observational only: neither an atomic executable handle nor protection from a hostile host owner. */
export async function observeExecutableInvocation(
  command: string,
  script?: string,
): Promise<{ fingerprint: string; assertCurrent: () => void } | undefined> {
  try {
    const executable = await observeFile(command);
    // A direct shebang launcher has an unbound interpreter; refuse it.
    if (!executable || executable.script) return undefined;
    const source = script ? await observeFile(script) : undefined;
    if (script && !source) return undefined;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ executable, source }))
      .digest('hex');
    return {
      fingerprint,
      assertCurrent: () => {
        for (const observed of source ? [executable, source] : [executable]) {
          const named = lstatSync(observed.canonical, { bigint: true });
          if (
            !named.isFile() ||
            named.isSymbolicLink() ||
            identity(named) !== observed.identity ||
            realpathSync(observed.path) !== observed.canonical
          )
            throw new Error('Execution authentication executable changed');
        }
      },
    };
  } catch {
    return undefined;
  }
}
