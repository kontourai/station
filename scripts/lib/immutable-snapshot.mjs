import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

/** @param {string} destination @param {Buffer} bytes */
export async function publishImmutableSnapshot(destination, bytes) {
  await fs.mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Linking publishes complete bytes atomically without replacing a prior
    // snapshot. A concurrent publisher must have captured exactly these bytes.
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(destination);
      if (!existing.equals(bytes))
        throw new Error(`Immutable source snapshot mismatch: ${destination}`);
    }
  } finally {
    await fs.unlink(temporary);
  }
}
