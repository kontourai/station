/**
 * Canonical member ordering for Apple `.icns` files.
 *
 * `tauri icon` emits a byte-identical PNG/ICO fan-out on every run but a
 * different `.icns` every time (#1797). The difference is not the image data:
 * parsing two runs of the same master shows the SAME twelve members with the
 * SAME lengths and the SAME body digests, written in a different sequence --
 * the writer walks a Rust `HashMap`, whose iteration order is randomized per
 * process. Four committed `.icns` files therefore churn with an unreviewable
 * binary diff on every regeneration.
 *
 * An `.icns` is a flat sequence of typed elements after an 8-byte header
 * (`icns` + total length); the format assigns no meaning to their order, and
 * Icon Services looks members up by type. Sorting them is a lossless
 * permutation -- every body is copied through byte for byte, nothing is
 * re-encoded, and no member is added or dropped. That is what makes this safe
 * where re-rendering through `iconutil` would not be: `iconutil` re-encodes
 * the PNGs and cannot reproduce the legacy `il32`/`l8mk`/`is32`/`s8mk`
 * members Tauri emits, and it exists only on macOS, while this runs anywhere
 * the generator and its tests do.
 *
 * Fail closed: anything this cannot account for byte for byte -- a short
 * header, a length that disagrees with the file, a member that overruns, or a
 * `TOC ` index whose recorded order rewriting would invalidate -- throws
 * rather than emitting a file whose contents this module only assumed.
 */

const MAGIC = 'icns';
const HEADER_BYTES = 8;
const MEMBER_HEADER_BYTES = 8;
/** A `TOC ` element records the members in file order; reordering voids it. */
const TABLE_OF_CONTENTS = 'TOC ';

/**
 * Split an `.icns` buffer into its top-level members.
 *
 * @param {Buffer} buffer
 * @returns {{ type: string, body: Buffer }[]} members in file order
 */
export function parseIcnsMembers(buffer) {
  if (buffer.length < HEADER_BYTES)
    throw new Error(
      `icns: file is ${buffer.length} bytes, shorter than its ${HEADER_BYTES}-byte header`,
    );
  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== MAGIC)
    throw new Error(`icns: expected magic "${MAGIC}", found "${magic}"`);
  const declared = buffer.readUInt32BE(4);
  if (declared !== buffer.length)
    throw new Error(
      `icns: header declares ${declared} bytes, file is ${buffer.length}`,
    );

  const members = [];
  let offset = HEADER_BYTES;
  while (offset < declared) {
    if (offset + MEMBER_HEADER_BYTES > declared)
      throw new Error(
        `icns: member header at ${offset} runs past the end of the file`,
      );
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < MEMBER_HEADER_BYTES)
      throw new Error(
        `icns: member "${type}" at ${offset} declares ${length} bytes, less than its own header`,
      );
    if (offset + length > declared)
      throw new Error(
        `icns: member "${type}" at ${offset} declares ${length} bytes, past the end of the file`,
      );
    if (type === TABLE_OF_CONTENTS)
      throw new Error(
        `icns: file carries a "${TABLE_OF_CONTENTS}" index, whose recorded member order canonicalization would invalidate`,
      );
    members.push({
      type,
      body: buffer.subarray(offset + MEMBER_HEADER_BYTES, offset + length),
    });
    offset += length;
  }
  return members;
}

/**
 * Rewrite an `.icns` buffer with its members in canonical order: by type,
 * then by body bytes so a repeated type is still totally ordered. Every body
 * is copied unchanged, so two files holding the same members canonicalize to
 * identical bytes regardless of the order they were written in.
 *
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function canonicalizeIcns(buffer) {
  const members = parseIcnsMembers(buffer);
  members.sort(
    (a, b) =>
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      Buffer.compare(a.body, b.body),
  );
  const out = Buffer.allocUnsafe(buffer.length);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32BE(buffer.length, 4);
  let offset = HEADER_BYTES;
  for (const { type, body } of members) {
    out.write(type, offset, 4, 'ascii');
    out.writeUInt32BE(body.length + MEMBER_HEADER_BYTES, offset + 4);
    body.copy(out, offset + MEMBER_HEADER_BYTES);
    offset += MEMBER_HEADER_BYTES + body.length;
  }
  if (offset !== buffer.length)
    throw new Error(
      `icns: canonical form is ${offset} bytes, input was ${buffer.length}`,
    );
  return out;
}
