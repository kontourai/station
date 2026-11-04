import {
  type FrameReason,
  WALKTHROUGH_LIMITS,
  type WalkthroughToken,
} from '@kontourai/station-contracts/walkthrough';

interface Candidate {
  tMs: number;
  reasons: FrameReason[];
  coverage?: boolean;
}
const WEIGHT: Record<FrameReason, number> = {
  deictic: 8,
  'scene-change': 4,
  pause: 2,
  interval: 1,
};
/** Preserve sub-word timing: leading whitespace starts a word; punctuation ends one. */
function words(tokens: readonly WalkthroughToken[]) {
  const result: { word: string; tMs: number }[] = [];
  let word = '',
    tMs = 0;
  const flush = () => {
    if (word) result.push({ word: word.toLowerCase(), tMs });
    word = '';
  };
  for (const token of tokens) {
    for (const character of token.text) {
      if (/[\p{L}\p{N}'’]/u.test(character)) {
        if (!word) tMs = token.tMs;
        word += character;
      } else flush();
    }
  }
  flush();
  return result;
}
/** Four independent signals, 500 ms clusters, ranked before the hard cap. */
export function selectWalkthroughFrames(input: {
  durationMs: number;
  tokens: readonly WalkthroughToken[];
  speech: readonly { tMs: number; endMs: number }[];
  sceneTimes: readonly number[];
}) {
  const candidates: Candidate[] = [];
  const add = (tMs: number, reason: FrameReason) => {
    if (Number.isFinite(tMs) && tMs >= 0 && tMs < input.durationMs)
      candidates.push({ tMs, reasons: [reason] });
  };
  for (const word of words(input.tokens))
    if (['this', 'here', 'that', 'these', 'there', 'look'].includes(word.word))
      add(word.tMs, 'deictic');
  for (const t of input.sceneTimes) add(t, 'scene-change');
  // Token timing exposes pauses within a segment; segment timing covers engines without tokens.
  const speech = input.tokens.length ? input.tokens : input.speech;
  for (let i = 0; i < speech.length; i++) {
    const current = speech[i]!;
    const next = speech[i + 1];
    if ((next?.tMs ?? input.durationMs) - current.endMs >= 1000)
      add(current.endMs + 200, 'pause');
  }
  const spacing = Math.max(
    10_000,
    input.durationMs / (WALKTHROUGH_LIMITS.frames / 2),
  );
  for (let t = 0; t < input.durationMs; t += spacing) {
    add(t, 'interval');
    candidates.at(-1)!.coverage = true;
  }
  for (let t = 0; t < input.durationMs; t += 10_000)
    if (t % spacing !== 0) add(t, 'interval');
  candidates.sort((a, b) => a.tMs - b.tMs);
  const merged: Candidate[] = [];
  let clusterStart = 0;
  for (const candidate of candidates) {
    const last = merged.at(-1);
    if (last && candidate.tMs - clusterStart <= 500) {
      if (
        WEIGHT[candidate.reasons[0]!] >
        Math.max(...last.reasons.map((r) => WEIGHT[r]))
      )
        last.tMs = candidate.tMs;
      last.coverage ||= candidate.coverage;
      last.reasons = [...new Set([...last.reasons, ...candidate.reasons])];
    } else {
      clusterStart = candidate.tMs;
      merged.push({ ...candidate });
    }
  }
  const score = (c: Candidate) => c.reasons.reduce((n, r) => n + WEIGHT[r], 0);
  const kept = merged
    .sort(
      (a, b) =>
        Number(!!b.coverage) - Number(!!a.coverage) ||
        score(b) - score(a) ||
        a.tMs - b.tMs,
    )
    .slice(0, WALKTHROUGH_LIMITS.frames)
    .sort((a, b) => a.tMs - b.tMs);
  return {
    frames: kept.map(({ tMs, reasons }) => ({ tMs, reasons })),
    frameSelection: { candidates: candidates.length, kept: kept.length },
  };
}
