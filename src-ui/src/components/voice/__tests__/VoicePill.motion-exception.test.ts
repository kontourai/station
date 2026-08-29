import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#753 fix round, item 5 (arbitrated): `.voice-pill--listening` and
 * `.voice-pill__ring` deliberately transition on the literal `0.08s`, not a
 * `--motion-*` token, and `motion-contract-baseline.json` carries a per-file
 * ceiling for exactly these two declarations.
 *
 * The exception's reasoning: `--audio-scale`/`--audio-glow` are republished
 * on every microphone frame (NovaVoiceSessionAdapter.ts
 * `handleMicrophoneFrame`, an RMS level pushed on the order of milliseconds),
 * putting this in the grammar's Direct-manipulation category — a property
 * driven by a continuous external signal, not a discrete Feedback/state
 * change. 0.08s is a signal-smoothing time constant, not a motion duration;
 * `--motion-fast` (150ms) was tried and reverted because the transition
 * restarts before completing on every new frame at that duration and never
 * resolves.
 *
 * docs/design/motion.md requires a component exception to "include a local
 * test" — this is it. A future ratchet sweep that tokenizes this literal
 * without reading this file will red it here, which is the point: it forces
 * whoever does that to re-derive (or explicitly overturn) the reasoning
 * above rather than silently normalizing it away.
 */

const CSS = readFileSync(
  path.resolve(import.meta.dirname, '..', 'VoicePill.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule body the selector participates in. */
function rulesFor(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(
    `(?:^|[,{}\\n])\\s*[^{}]*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`,
    'g',
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null = rule.exec(CSS);
  while (match !== null) {
    bodies.push(match[1]);
    match = rule.exec(CSS);
  }
  return bodies;
}

describe('VoicePill audio-reactive transitions (motion-contract exception)', () => {
  test('.voice-pill--listening stays on the literal 0.08s smoothing constant', () => {
    const bodies = rulesFor('.voice-pill--listening');
    const transition = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*transition\s*:/.test(declaration));
    expect(transition).toBeDefined();
    // Exact literal, not a token: this is the assertion a token-migration
    // sweep would break.
    expect(transition).toMatch(/transform\s+0\.08s\s+ease-out/);
    expect(transition).toMatch(/box-shadow\s+0\.08s\s+ease-out/);
    expect(transition).not.toMatch(/var\(--motion-/);
  });

  test('.voice-pill__ring stays on the same literal', () => {
    const bodies = rulesFor('.voice-pill__ring');
    const transition = bodies
      .flatMap((body) => body.split(';'))
      .find((declaration) => /^\s*transition\s*:/.test(declaration));
    expect(transition).toBeDefined();
    expect(transition).toMatch(/border-color\s+0\.08s/);
    expect(transition).toMatch(/box-shadow\s+0\.08s/);
    expect(transition).not.toMatch(/var\(--motion-/);
  });
});
