/** Internal string seam: tests can trap bracket reads as well as hidden native searches. */
export interface MatchText
  extends Pick<
    string,
    | 'length'
    | 'charCodeAt'
    | 'indexOf'
    | 'startsWith'
    | 'endsWith'
    | 'includes'
    | 'lastIndexOf'
    | 'search'
    | 'match'
  > {
  readonly [index: number]: string;
}

type StepCounter = (steps: number) => void;

function codeAt(
  text: Pick<MatchText, 'charCodeAt'>,
  index: number,
  step?: StepCounter,
): number {
  step?.(1);
  return text.charCodeAt(index);
}

/** O(pattern.length), with no hidden document search. */
export function matchesAt(
  text: MatchText,
  pattern: string,
  start: number,
  step?: StepCounter,
): boolean {
  if (start < 0 || start + pattern.length > text.length) return false;
  for (let index = 0; index < pattern.length; index++)
    if (codeAt(text, start + index, step) !== codeAt(pattern, index, step))
      return false;
  return true;
}

/** Overlapping matches, capped at two. Native <=64-unit patterns cost at most 128*N; longer patterns use KMP. */
export function findTwoMatches(
  text: MatchText,
  pattern: string,
  step?: StepCounter,
): number[] {
  const matches: number[] = [];
  if (pattern.length <= 64) {
    let from = 0;
    while (from <= text.length - pattern.length) {
      // Native comparisons are opaque: charge the naive upper bound per call.
      step?.((text.length - from) * pattern.length);
      const start = text.indexOf(pattern, from);
      if (start === -1) break;
      matches.push(start);
      if (matches.length === 2) break;
      from = start + 1;
    }
    return matches;
  }
  const fallback = new Uint32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    const code = codeAt(pattern, index, step);
    while (matched > 0 && code !== codeAt(pattern, matched, step))
      matched = fallback[matched - 1];
    if (code === codeAt(pattern, matched, step)) matched++;
    fallback[index] = matched;
  }
  for (let index = 0, matched = 0; index < text.length; index++) {
    const code = codeAt(text, index, step);
    while (matched > 0 && code !== codeAt(pattern, matched, step))
      matched = fallback[matched - 1];
    if (code === codeAt(pattern, matched, step)) matched++;
    if (matched === pattern.length) {
      matches.push(index - pattern.length + 1);
      if (matches.length === 2) break;
      matched = fallback[matched - 1];
    }
  }
  return matches;
}
