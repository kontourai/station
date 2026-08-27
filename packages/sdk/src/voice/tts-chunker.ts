/** Splits response text at sentence and word boundaries without exceeding `maximumLength`. */
export function chunkVoiceText(
  text: string,
  maximumLength: number,
): readonly string[] {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    throw new Error('maximumLength must be a positive integer.');
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const word of words) {
    if (word.length > maximumLength) {
      flush();
      for (let offset = 0; offset < word.length; offset += maximumLength) {
        chunks.push(word.slice(offset, offset + maximumLength));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maximumLength) flush();
    current = current ? `${current} ${word}` : word;
    if (/[.!?]$/.test(word)) flush();
  }
  flush();
  return Object.freeze(chunks);
}
