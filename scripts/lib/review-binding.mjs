// What one recorded source binding vouches for (#2936).
//
// A binding names a whole file (`docs/guides/testing.md`) or, for a broad
// JSON file, one value inside it by JSON Pointer (RFC 6901):
// `package.json#/scripts/docs:truth:gate`. A value binding digests only that
// value, so an unrelated edit elsewhere in package.json stales no review
// that did not cite it, while a change to the cited value still does.
import { createHash } from 'node:crypto';
import { isLearningSourcePath } from './learning-source-reader.mjs';

const VALUE_BINDING = /^(.+?\.json)#(\/.*)$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** @param {string} path a binding path */
function splitBinding(path) {
  const match = VALUE_BINDING.exec(path);
  return match
    ? { file: match[1], pointer: match[2] }
    : { file: path, pointer: undefined };
}

/** The tracked file a binding reads. */
export const bindingFile = (path) => splitBinding(path).file;

/** A portable repository file, optionally with a JSON Pointer into it. */
export function isBindingPath(path) {
  if (typeof path !== 'string') return false;
  const { file, pointer } = splitBinding(path);
  return (
    isLearningSourcePath(file) &&
    (pointer === undefined || !/~[^01]|~$/.test(pointer))
  );
}

function resolvePointer(value, pointer) {
  let current = value;
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, token)
    )
      return undefined;
    current = current[token];
  }
  return current;
}

/**
 * The digest a binding records over a file's bytes: the whole file, or the
 * JSON text of the pointed-to value. Undefined when that value is absent or
 * the file is no longer JSON, which reads as a changed input.
 * @param {string} path
 * @param {Uint8Array | string} bytes
 */
export function bindingDigest(path, bytes) {
  const { pointer } = splitBinding(path);
  if (pointer === undefined) return sha256(bytes);
  let value;
  try {
    value = resolvePointer(
      JSON.parse(typeof bytes === 'string' ? bytes : utf8.decode(bytes)),
      pointer,
    );
  } catch {
    return undefined;
  }
  return value === undefined ? undefined : sha256(JSON.stringify(value));
}
