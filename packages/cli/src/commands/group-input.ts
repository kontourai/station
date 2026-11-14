import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

/** The descriptor and actual read both enforce the input bound, including file growth. */
export function readGroupInput(
  file: string,
  label: string,
  maxBytes: 262_144 | 524_288 = 262_144,
): unknown {
  const descriptor = openSync(
    resolve(file),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error(
        `${label} input must be a regular JSON file of at most ${maxBytes / 1024} KiB.`,
      );
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > maxBytes)
      throw new Error(`${label} input exceeds ${maxBytes / 1024} KiB.`);
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    closeSync(descriptor);
  }
}
