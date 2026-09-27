// Reads the `Stop with: station stop --home=<home> --instance=<id>` line a
// prebuilt archive's `station start` prints (#2805). The home is quoted for
// the shell a user of that platform pastes it into (lifecycle.ts homeFlag):
// double quotes on Windows, single quotes (with `'\''` escapes) on POSIX,
// and bare when it needs no quoting. Parsing it here, instead of splitting
// the line on spaces, keeps quotes out of argv and keeps spaces in a home.

const HINT =
  /Stop with: station stop --home=("[^"]*"|'(?:[^']|'\\'')*'|\S+) --instance=(\S+)/;

/**
 * The home and instance a stop hint names, or null when there is none.
 * Throws when the home is quoted in the other platform's style: that hint
 * would name a different home when pasted, and stop would find nothing.
 */
export function parseStopHint(output, platform = process.platform) {
  const match = HINT.exec(output ?? '');
  if (!match) return null;
  const [, token, instanceId] = match;
  let home = token;
  if (token.startsWith('"')) {
    if (platform !== 'win32') {
      throw new Error(`stop hint double-quotes its home on POSIX: ${token}`);
    }
    home = token.slice(1, -1);
  } else if (token.startsWith("'")) {
    if (platform === 'win32') {
      throw new Error(
        `stop hint single-quotes its home on Windows, where cmd.exe keeps the quotes: ${token}`,
      );
    }
    home = token.slice(1, -1).replaceAll("'\\''", "'");
  }
  return { home, instanceId };
}
