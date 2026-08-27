import type { StreamChunk } from '../types.js';

export async function* toStream(
  chunks: StreamChunk[],
): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c;
}

export async function collect(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}
