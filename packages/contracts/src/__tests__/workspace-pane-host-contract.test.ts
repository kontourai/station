import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type {
  PaneConfirmDecision,
  PaneHostFacts,
  PaneNavigationTarget,
  WorkspacePaneHostContract,
} from '../workspace-pane-host-contract.js';

/**
 * The design's stated regression tripwire (`docs/design/pane-host-contract.md`):
 * "The contract growing a `ComponentType` member is the regression tripwire."
 * A component-typed member cannot survive the frame boundary, so the moment
 * one appears the tier-2 contract has silently forked from tier 3. TypeScript
 * erases types, so the only durable pin is structural: the module may import
 * NOTHING (react least of all) and may not name a renderer type. That makes a
 * component-typed member impossible by construction — there is no `react`
 * import to type it with, and no local alias to smuggle one in as.
 */

const SOURCE = readFileSync(
  join(resolve(import.meta.dirname, '..'), 'workspace-pane-host-contract.ts'),
  'utf8',
);

/** Match real code, not the docblocks that explain the rule being pinned. */
function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

describe('WorkspacePaneHostContract stays transport-agnostic', () => {
  test('the module imports nothing — no react, no store, no transport', () => {
    const code = withoutComments(SOURCE);
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  test('no member is component-typed (the design tripwire)', () => {
    const code = withoutComments(SOURCE);
    for (const forbidden of [
      'ComponentType',
      'FunctionComponent',
      'ReactNode',
      'ReactElement',
      'JSX.',
    ]) {
      expect(
        code,
        `'${forbidden}' must not appear in the contract`,
      ).not.toContain(forbidden);
    }
  });

  test('every navigation target names a destination, never a path', () => {
    // station#4201 step 3: the frame's two real targets joined the union, and
    // the union is only worth having if no member accepts a path. A
    // `{ kind: 'raw-path'; path: string }` member -- or a `path` field on any
    // member -- is the union not existing: across the frame boundary that is
    // an untrusted string steering the shell, and the allowlist that used to
    // stand in front of it would have nothing left to check.
    const code = withoutComments(SOURCE);
    const union = code.slice(
      code.indexOf('export type PaneNavigationTarget'),
      code.indexOf('export type NoticeTone'),
    );
    expect(union).not.toMatch(/\bpath\b/);
    expect(union).not.toMatch(/\braw-path\b/);

    expectTypeOf<PaneNavigationTarget['kind']>().toEqualTypeOf<
      'project-workspace' | 'project-layout' | 'app-surface'
    >();
  });

  test('confirm is a request/response intent: data in, a decision out', () => {
    expectTypeOf<WorkspacePaneHostContract['confirm']>()
      .parameter(0)
      .toEqualTypeOf<{
        title: string;
        message: string;
      }>();
    expectTypeOf<WorkspacePaneHostContract['confirm']>().returns.toEqualTypeOf<
      Promise<PaneConfirmDecision>
    >();
  });

  test('facts are read/subscribe over one plain-data shape', () => {
    expectTypeOf<
      ReturnType<WorkspacePaneHostContract['facts']['read']>
    >().toEqualTypeOf<PaneHostFacts>();
    expectTypeOf<PaneHostFacts>().toEqualTypeOf<{
      device: { isMobile: boolean };
    }>();
  });
});
