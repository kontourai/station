import { createHash } from 'node:crypto';
import { isLearningSourcePath } from './learning-source-reader.mjs';

export const LEARNING_MEDIA_MANIFEST = 'docs/learn/media.json';

/** The bytes a capture record vouches for: the capture and its recorded sources. */
export function captureInputs(capture) {
  return [capture.path, ...capture.sources.map((source) => source.path)];
}

export async function compileLearningMedia(
  manifest,
  tracked,
  read,
  { requireFresh = false } = {},
) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.captures))
    throw new Error('Learning media requires version 1 captures.');
  const captures = new Map();
  for (const capture of manifest.captures) {
    const { path, kind } = capture;
    if (
      !isLearningSourcePath(path) ||
      !path.startsWith('docs/learn/media/') ||
      !tracked.has(path) ||
      captures.has(path) ||
      !(
        (kind === 'image' && path.endsWith('.png')) ||
        (kind === 'video' && path.endsWith('.webm'))
      )
    )
      throw new Error(`Invalid learning capture: ${path}`);
    for (const key of ['alt', 'caption', 'scenario', 'evidence'])
      if (typeof capture[key] !== 'string' || !capture[key].trim())
        throw new Error(`Missing capture ${key}: ${path}`);
    if (
      capture.reviewNotes !== undefined &&
      (!Array.isArray(capture.reviewNotes) ||
        capture.reviewNotes.some(
          (note) => typeof note !== 'string' || !note.trim(),
        ))
    )
      throw new Error(`Invalid capture reviewNotes: ${path}`);
    for (const key of ['capturedRevision', 'reviewedRevision'])
      if (!/^[a-f0-9]{40}$/.test(capture[key]))
        throw new Error(`Invalid capture ${key}: ${path}`);
    if (
      !Array.isArray(capture.sources) ||
      !capture.sources.length ||
      !Array.isArray(capture.documents) ||
      !capture.documents.length ||
      capture.documents.some((doc) => !tracked.has(doc) || !doc.endsWith('.md'))
    )
      throw new Error(`Missing capture source or document owners: ${path}`);
    const changed = [];
    const seen = new Set();
    for (const source of capture.sources) {
      if (
        !isLearningSourcePath(source.path) ||
        !tracked.has(source.path) ||
        seen.has(source.path) ||
        !/^[a-f0-9]{64}$/.test(source.digest)
      )
        throw new Error(`Invalid capture source: ${path}`);
      seen.add(source.path);
      if (
        createHash('sha256')
          .update(await read(source.path))
          .digest('hex') !== source.digest
      )
        changed.push(source.path);
    }
    if (
      changed.length &&
      (typeof requireFresh === 'function'
        ? requireFresh({ path, inputs: captureInputs(capture) })
        : requireFresh)
    )
      throw new Error(
        `Learning capture needs review: ${path}; changed: ${changed.join(', ')}`,
      );
    const bytes = await read(path);
    const limit = kind === 'image' ? 8 * 1024 * 1024 : 30 * 1024 * 1024;
    const signature =
      kind === 'image'
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        : Buffer.from([26, 69, 223, 163]);
    if (
      bytes.length > limit ||
      !bytes.subarray(0, signature.length).equals(signature)
    )
      throw new Error(`Invalid or oversized learning media bytes: ${path}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (capture.digest !== digest)
      throw new Error(
        `Learning capture bytes differ from the recorded digest: ${path}`,
      );
    captures.set(path, {
      ...capture,
      digest,
      changed,
      url: `media/${digest}/${path.slice('docs/learn/media/'.length).split('/').map(encodeURIComponent).join('/')}`,
    });
  }
  return captures;
}
