import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  decideStaticGateScope,
  failureNote,
  isStaticGateInput,
  PREPUSH_STATIC_GATES,
  STATIC_GATE_INPUT_PREFIXES,
  staticGateInputs,
} from '../check-prepush-static-gates.mjs';

describe('static gate input detection', () => {
  it('recognizes the source roots these ratchets read', () => {
    for (const path of [
      'src-ui/src/views/HomeView.css',
      'src-ui/src/components/Button.tsx',
      'src-server/routes/agents/index.ts',
      'packages/contracts/src/layout.ts',
      'src-shared/monitoring-keys.ts',
      'tests/home.spec.ts',
      'examples/minimal-layout/src/index.ts',
    ]) {
      expect(isStaticGateInput(path), path).toBe(true);
    }
  });

  /**
   * A ceiling edit changes the verdict without touching a source file, so the
   * ratchets' own scripts and baselines are inputs too.
   */
  it('recognizes the ratchet scripts and their baselines', () => {
    expect(isStaticGateInput('scripts/a11y-baseline.json')).toBe(true);
    expect(isStaticGateInput('scripts/motion-contract-ratchet.mjs')).toBe(true);
  });

  it('ignores paths no ratchet reads', () => {
    for (const path of [
      'docs/design/motion.md',
      'README.md',
      '.github/workflows/ci.yml',
      'src-desktop/tauri.conf.json',
    ]) {
      expect(isStaticGateInput(path), path).toBe(false);
    }
  });

  /**
   * Trailing slashes are load-bearing. Without them `src-ui/` matches
   * `src-uix/`, and a prefix gate that over-matches is a gate nobody can
   * reason about.
   */
  it('does not match a sibling directory sharing a prefix', () => {
    expect(isStaticGateInput('src-uix/src/App.tsx')).toBe(false);
    expect(isStaticGateInput('packages-old/contracts/src/x.ts')).toBe(false);
    for (const prefix of STATIC_GATE_INPUT_PREFIXES) {
      expect(prefix.endsWith('/'), prefix).toBe(true);
    }
  });

  it('filters a mixed change set to only the inputs', () => {
    expect(
      staticGateInputs(['README.md', 'src-ui/src/a.css', 'docs/x.md']),
    ).toEqual(['src-ui/src/a.css']);
  });
});

describe('scope decision', () => {
  it('skips only when the scope was computed and matched nothing', () => {
    const decision = decideStaticGateScope({
      baseSha: 'abc123',
      changedPaths: ['README.md', 'docs/x.md'],
    });
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('none of the 2 path(s)');
  });

  it('runs when an input changed, and names what matched', () => {
    const decision = decideStaticGateScope({
      baseSha: 'abc123',
      changedPaths: ['README.md', 'src-ui/src/views/HomeView.css'],
    });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('src-ui/src/views/HomeView.css');
  });

  /**
   * "I could not look" must not resolve to the same answer as "nothing
   * changed" — the failure mode this gate exists to prevent is a silent skip.
   */
  it('runs when the base ref is missing rather than assuming nothing changed', () => {
    const decision = decideStaticGateScope({
      baseSha: undefined,
      changedPaths: [],
    });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('cannot be scoped');
  });
});

describe('the gate list', () => {
  /**
   * Resolution is proven with `node --check` (parse + resolve, no execution)
   * rather than running each gate: executing all eleven cost ~8s of the
   * process-heavy phase's 240s budget, and that group already runs at ~226s
   * on a quiet host — this suite's addition was most of the remaining
   * headroom (#3127). One real execution below keeps the spawn path proven.
   */
  it('names scripts that exist and parse', () => {
    for (const name of PREPUSH_STATIC_GATES) {
      const result = spawnSync('node', ['--check', `scripts/${name}.mjs`], {
        encoding: 'utf8',
      });
      expect(result.error, name).toBeUndefined();
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  }, 30_000);

  it('the spawn path executes a real gate and reports its exit status', () => {
    // The cheapest gate (~75ms): proves runRatchet's child-process path with
    // one execution instead of eleven.
    const result = spawnSync('node', ['scripts/lazy-boundary-ratchet.mjs'], {
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 30_000);

  it('is ordered cheapest-first so a cheap failure reports before a slow one', () => {
    expect(PREPUSH_STATIC_GATES[0]).toBe('lazy-boundary-ratchet');
    expect(PREPUSH_STATIC_GATES).toContain('mobile-css-ratchet');
    // a11y is ~5s (its own biome pass); everything else is under 500ms.
    expect(PREPUSH_STATIC_GATES.at(-1)).toBe('a11y-ratchet');
  });

  /**
   * The content gates belong here for the same reason the ratchets do: they
   * live in verify:static, so nothing evaluates them until after merge, and
   * coding-composition-inventory-gate broke main exactly that way (#3206).
   */
  it('covers the content gates, not only the UI-contract ratchets', () => {
    for (const gate of [
      'rename-inventory',
      'noun-consistency-gate',
      'station-vocabulary-gate',
      'coding-composition-inventory-gate',
    ]) {
      expect(PREPUSH_STATIC_GATES, gate).toContain(gate);
    }
  });
});

describe('failure reporting', () => {
  /**
   * The note must not restate counts or ceilings: each ratchet already
   * printed its own, and a second copy here is a second thing to drift.
   */
  it('names the failures and how to reproduce them, without restating counts', () => {
    const note = failureNote(['motion-contract-ratchet']);
    expect(note).toContain('motion-contract-ratchet');
    expect(note).toContain('node scripts/motion-contract-ratchet.mjs');
    expect(note).not.toMatch(/ceiling \d+/);
  });
});
