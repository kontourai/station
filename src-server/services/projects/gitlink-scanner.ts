/** Scan NUL-delimited ls-files records, retaining only their seven-byte mode. */
export function scanGitlinkChunk(
  prefix: string,
  chunk: Buffer,
): { found: boolean; prefix: string } {
  let start = 0;
  while (start < chunk.length) {
    const nul = chunk.indexOf(0, start);
    const end = nul === -1 ? chunk.length : nul;
    prefix += chunk
      .subarray(start, Math.min(end, start + 7 - prefix.length))
      .toString('ascii');
    if (prefix === '160000 ') return { found: true, prefix };
    if (nul === -1) break;
    prefix = '';
    start = nul + 1;
  }
  return { found: false, prefix };
}
