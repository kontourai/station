import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { COMPONENT_MAX_BYTES, FILE_MAX_BYTES } from './workspace-package-io.js';

const MAX_OBJECTS = 20_000;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
type Budget = { objects: number; bytes: number };

/** Admission limits, not a replacement for Git's object/hash validation.
 * Inspect one bounded inflated object at a time, including delta result sizes,
 * before an external Git process can reconstruct imported objects. */
function inspectPack(
  pack: Buffer,
  format: 'sha1' | 'sha256',
  budget: Budget,
): void {
  const hashBytes = format === 'sha1' ? 20 : 32;
  if (
    pack.length > COMPONENT_MAX_BYTES ||
    pack.length < 12 + hashBytes ||
    pack.subarray(0, 4).toString() !== 'PACK' ||
    ![2, 3].includes(pack.readUInt32BE(4))
  )
    throw new Error('Invalid bounded Git pack');
  const end = pack.length - hashBytes;
  if (
    !createHash(format)
      .update(pack.subarray(0, end))
      .digest()
      .equals(pack.subarray(end))
  )
    throw new Error('Git pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  budget.objects += count;
  if (budget.objects > MAX_OBJECTS)
    throw new Error('Git object count limit exceeded');
  let offset = 12;
  const sizes = new Map<number, number>();
  const byte = () => {
    if (offset >= end) throw new Error('Truncated Git pack');
    return pack[offset++];
  };
  for (let object = 0; object < count; object++) {
    const start = offset;
    let current = byte();
    const type = (current >> 4) & 7;
    if (![1, 2, 3, 4, 6, 7].includes(type))
      throw new Error('Unsupported Git object type');
    let size = current & 15;
    let shift = 4;
    while (current & 128) {
      if (shift > 32) throw new Error('Invalid Git object size');
      current = byte();
      size += (current & 127) * 2 ** shift;
      shift += 7;
    }
    if (size > FILE_MAX_BYTES)
      throw new Error('Git object exceeds expanded size limit');
    let baseSize: number | undefined;
    if (type === 6) {
      current = byte();
      let distance = current & 127;
      let width = 1;
      while (current & 128) {
        if (++width > 8 || distance > pack.length)
          throw new Error('Invalid Git delta offset');
        current = byte();
        distance = (distance + 1) * 128 + (current & 127);
      }
      baseSize = sizes.get(start - distance);
      if (distance === 0 || baseSize === undefined)
        throw new Error('Invalid Git delta base');
    } else if (type === 7) {
      if (offset + hashBytes > end) throw new Error('Truncated Git delta base');
      offset += hashBytes;
    }
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(pack.subarray(offset, end), {
        maxOutputLength: FILE_MAX_BYTES,
        info: true,
      }) as unknown as typeof inflated;
    } catch {
      throw new Error('Git object inflation exceeds its bound or is invalid');
    }
    const consumed = inflated.engine.bytesWritten;
    if (
      !Number.isSafeInteger(consumed) ||
      consumed <= 0 ||
      offset + consumed > end ||
      inflated.buffer.length !== size
    )
      throw new Error('Git object length mismatch');
    offset += consumed;
    let expanded = size;
    if (type === 6 || type === 7) {
      let at = 0;
      const deltaSize = () => {
        let value = 0;
        let bits = 0;
        let part: number;
        do {
          if (at >= inflated.buffer.length || bits > 32)
            throw new Error('Invalid Git delta size');
          part = inflated.buffer[at++];
          value += (part & 127) * 2 ** bits;
          bits += 7;
        } while (part & 128);
        if (value > FILE_MAX_BYTES)
          throw new Error('Git delta exceeds expanded size limit');
        return value;
      };
      const declaredBase = deltaSize();
      expanded = deltaSize();
      if (baseSize !== undefined && baseSize !== declaredBase)
        throw new Error('Git delta base size mismatch');
    }
    budget.bytes += Math.max(size, expanded);
    if (budget.bytes > MAX_EXPANDED_BYTES)
      throw new Error('Git expanded byte limit exceeded');
    sizes.set(start, expanded);
  }
  if (offset !== end) throw new Error('Unexpected trailing Git pack bytes');
}

export function validateWorkspaceGitPacks(
  bundle: Buffer,
  indexPack: Buffer,
  format: 'sha1' | 'sha256',
  head: string,
): void {
  if (bundle.length > COMPONENT_MAX_BYTES)
    throw new Error('Git bundle byte limit exceeded');
  const boundary = bundle.indexOf('\n\n');
  if (boundary < 0 || boundary > 65536)
    throw new Error('Invalid Git bundle header');
  const header = new TextDecoder('utf-8', { fatal: true })
    .decode(bundle.subarray(0, boundary))
    .split('\n');
  const expected =
    format === 'sha1'
      ? ['# v2 git bundle', `${head} HEAD`]
      : ['# v3 git bundle', '@object-format=sha256', `${head} HEAD`];
  if (JSON.stringify(header) !== JSON.stringify(expected))
    throw new Error('Unsupported Git bundle refs, prerequisites, or format');
  const budget = { objects: 0, bytes: 0 };
  inspectPack(bundle.subarray(boundary + 2), format, budget);
  if (indexPack.length) inspectPack(indexPack, format, budget);
}
