import { describe, expect, test } from 'vitest';
import {
  BUILTIN_CODING_LAYOUT,
  BUILTIN_PROJECT_LAYOUTS,
  findPrimaryChatLayout,
  InvalidLayoutDeclarationError,
  LAYOUT_PRIMARY_CHAT_PERMISSION,
  layoutClaimsPrimaryChat,
  layoutPresentationDeclaration,
  layoutPresentsAsStack,
  MAX_LAYOUT_DRILL_INS,
  parseLayoutPresentationDeclaration,
} from '../layout.js';
import { PERMISSION_TIERS } from '../plugin.js';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
} from '../workspace-coding-panels.js';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from '../workspace-evidence-panels.js';

const OWN = new Set([
  'pane:plugin%3Afixture:stack:one',
  'pane:plugin%3Afixture:stack:two',
]);
const parse = (value: unknown) =>
  parseLayoutPresentationDeclaration(value, {
    label: "Plugin 'fixture' layout",
    resolvesDrillIn: (paneId) => OWN.has(paneId),
  });

describe('parseLayoutPresentationDeclaration (#2995)', () => {
  test('absent fields stay absent, and a full declaration is accepted', () => {
    expect(parse({ tabs: [] })).toEqual({});
    expect(
      parse({
        primary: 'chat',
        presentation: 'stack',
        drillIns: [...OWN],
      }),
    ).toEqual({
      primary: 'chat',
      presentation: 'stack',
      drillIns: [...OWN],
    });
    expect(parse({ presentation: 'tabs' })).toEqual({ presentation: 'tabs' });
  });

  test('refuses a primary other than chat, by name', () => {
    expect(() => parse({ primary: 'terminal', presentation: 'stack' })).toThrow(
      InvalidLayoutDeclarationError,
    );
    expect(() => parse({ primary: 'terminal', presentation: 'stack' })).toThrow(
      /Plugin 'fixture' layout declaration is invalid: primary must be 'chat' when supplied, not "terminal"/,
    );
    expect(() => parse({ primary: null, presentation: 'stack' })).toThrow(
      /primary must be 'chat'/,
    );
  });

  test('refuses an unknown presentation', () => {
    expect(() => parse({ presentation: 'grid' })).toThrow(
      /presentation must be 'stack' or 'tabs', not "grid"/,
    );
  });

  test('refuses a drill-in id that does not resolve, naming it', () => {
    expect(() =>
      parse({
        presentation: 'stack',
        drillIns: [
          'pane:plugin%3Afixture:stack:one',
          'pane:builtin:coding:diff',
        ],
      }),
    ).toThrow(
      /drill-in 'pane:builtin:coding:diff' does not resolve to a pane this layout can place/,
    );
  });

  test('refuses malformed and duplicate drill-ins', () => {
    expect(() => parse({ presentation: 'stack', drillIns: 'pane:x' })).toThrow(
      /drillIns must be an array/,
    );
    expect(() => parse({ presentation: 'stack', drillIns: [''] })).toThrow(
      /is not a pane id/,
    );
    expect(() => parse({ presentation: 'stack', drillIns: [7] })).toThrow(
      /is not a pane id/,
    );
    expect(() =>
      parse({
        presentation: 'stack',
        drillIns: [
          'pane:plugin%3Afixture:stack:one',
          'pane:plugin%3Afixture:stack:one',
        ],
      }),
    ).toThrow(/is listed twice/);
  });

  test('reads the drill-in bound and refuses one more, never truncating', () => {
    const ids = Array.from(
      { length: MAX_LAYOUT_DRILL_INS + 1 },
      (_, index) => `pane:plugin%3Afixture:stack:${index}`,
    );
    const accept = (paneId: string) => ids.includes(paneId);
    expect(MAX_LAYOUT_DRILL_INS).toBe(16);
    expect(
      parseLayoutPresentationDeclaration(
        { presentation: 'stack', drillIns: ids.slice(0, MAX_LAYOUT_DRILL_INS) },
        { resolvesDrillIn: accept },
      ).drillIns,
    ).toHaveLength(MAX_LAYOUT_DRILL_INS);
    expect(() =>
      parseLayoutPresentationDeclaration(
        { presentation: 'stack', drillIns: ids },
        { resolvesDrillIn: accept },
      ),
    ).toThrow(/at most 16 panes, not 17/);
  });

  test('refuses drill-ins and a Chat centre on a layout that is not a stack', () => {
    expect(() => parse({ drillIns: [...OWN] })).toThrow(
      /drillIns are pushed only by presentation 'stack'/,
    );
    expect(() => parse({ primary: 'chat' })).toThrow(
      /primary 'chat' needs presentation 'stack'/,
    );
    expect(() => parse({ primary: 'chat', presentation: 'tabs' })).toThrow(
      /primary 'chat' needs presentation 'stack'/,
    );
  });

  test('refuses a declaration that is not an object', () => {
    expect(() => parse(null)).toThrow(/it must be an object/);
    expect(() => parse([])).toThrow(/it must be an object/);
  });
});

describe('layoutPresentationDeclaration (#2995)', () => {
  const plugin = {
    id: 'plugin:fixture:stack',
    version: '1.0.0',
    sourceIdentity: { id: 'fixture', kind: 'local' as const },
    provenance: { origin: 'plugin' as const, pluginId: 'fixture' },
  };

  test('a stored built-in Coding record, in the shape its writer produces, reads as Coding’s declaration', () => {
    // `projects.ts`'s apply path persists a non-plugin built-in with `config: {}`
    // and no declaration; an older server answers exactly that.
    const stored = {
      id: 'l1',
      projectSlug: 'acme',
      type: 'coding',
      name: 'Coding',
      slug: 'coding',
      workspaceBinding: 'repository',
      config: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(layoutPresentationDeclaration(stored)).toEqual({
      primary: 'chat',
      presentation: 'stack',
      drillIns: [...BUILTIN_CODING_LAYOUT.drillIns!],
    });
    expect(layoutClaimsPrimaryChat(stored)).toBe(true);
    expect(layoutPresentsAsStack(stored)).toBe(true);
  });

  test('a contributed record that merely says coding declares nothing', () => {
    expect(
      layoutPresentationDeclaration({
        type: 'coding',
        catalogContribution: plugin,
      }),
    ).toEqual({});
    expect(
      layoutPresentationDeclaration({
        type: 'coding',
        config: { plugin: 'x' },
      }),
    ).toEqual({});
    // A listing carries the stored plugin binding as `plugin`.
    expect(
      layoutPresentationDeclaration({ type: 'coding', plugin: 'x' }),
    ).toEqual({});
  });

  test('a withheld read declares nothing, whatever it states', () => {
    expect(
      layoutPresentationDeclaration({
        type: 'coding',
        primary: 'chat',
        presentation: 'stack',
        paneReferences: { unavailableTabIds: [] },
      }),
    ).toEqual({});
  });

  test('a stated answer is read as stated, failing closed on unknown values', () => {
    expect(
      layoutPresentationDeclaration({
        type: 'custom',
        catalogContribution: plugin,
        primary: 'chat',
        presentation: 'stack',
        drillIns: ['pane:a', '', 3, 'pane:b'],
      }),
    ).toEqual({
      primary: 'chat',
      presentation: 'stack',
      drillIns: ['pane:a', 'pane:b'],
    });
    // An answer stating tabs is not upgraded by the legacy Coding rule.
    expect(
      layoutPresentationDeclaration({ type: 'coding', presentation: 'tabs' }),
    ).toEqual({ presentation: 'tabs' });
    // A Chat centre without the stack, or an unknown value, is no claim.
    expect(
      layoutPresentationDeclaration({ primary: 'chat', presentation: 'tabs' }),
    ).toEqual({ presentation: 'tabs' });
    expect(
      layoutPresentationDeclaration({ primary: 'chat', presentation: 'grid' }),
    ).toEqual({});
    expect(
      layoutClaimsPrimaryChat({ primary: 'terminal', presentation: 'stack' }),
    ).toBe(false);
  });
});

describe('findPrimaryChatLayout (#2995)', () => {
  test('finds the layout that claims Chat, built-in or contributed', () => {
    const tasks = { slug: 'tasks', type: 'tasks', presentation: 'tabs' };
    const fixture = {
      slug: 'fixture',
      type: 'custom',
      plugin: 'fixture',
      primary: 'chat',
      presentation: 'stack',
    };
    expect(findPrimaryChatLayout([tasks, fixture])).toBe(fixture);
    const legacyCoding = { slug: 'code', type: 'coding' };
    expect(findPrimaryChatLayout([tasks, legacyCoding])).toBe(legacyCoding);
  });

  test('prefers built-in Coding, then the lowest id, whatever the listing order', () => {
    const plugin = (id: string) => ({
      id,
      slug: id,
      type: 'custom',
      plugin: 'fixture',
      primary: 'chat',
      presentation: 'stack',
    });
    const coding = { id: 'z-coding', slug: 'code', type: 'coding' };
    expect(findPrimaryChatLayout([plugin('a'), coding, plugin('b')])).toBe(
      coding,
    );
    const a = plugin('a');
    const b = plugin('b');
    expect(findPrimaryChatLayout([b, a])).toBe(a);
    expect(findPrimaryChatLayout([a, b])).toBe(a);
  });

  test('ignores a contributed coding word and a stack without the claim', () => {
    expect(
      findPrimaryChatLayout([
        { slug: 'p', type: 'coding', plugin: 'x' },
        { slug: 's', type: 'custom', plugin: 'y', presentation: 'stack' },
      ]),
    ).toBeUndefined();
    expect(findPrimaryChatLayout(undefined)).toBeUndefined();
    expect(findPrimaryChatLayout([])).toBeUndefined();
  });
});

describe('built-in declarations', () => {
  test('Coding declares a Chat centre and its drill-ins in rail order', () => {
    // Restated literals in `layout.ts` (it cannot import these modules:
    // `workspace-pane.ts` imports it), pinned to their constants here.
    expect(BUILTIN_CODING_LAYOUT).toMatchObject({
      primary: 'chat',
      presentation: 'stack',
    });
    expect(BUILTIN_CODING_LAYOUT.drillIns).toEqual([
      WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
      WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
      WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
      WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
      WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
      WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
    ]);
  });

  test('no other starter claims Chat or a stack', () => {
    for (const layout of BUILTIN_PROJECT_LAYOUTS) {
      if (layout === BUILTIN_CODING_LAYOUT) continue;
      expect(layout.primary).toBeUndefined();
      expect(layout.presentation).toBeUndefined();
    }
  });

  test('the primary-chat grant is an active, consented permission', () => {
    expect(LAYOUT_PRIMARY_CHAT_PERMISSION).toBe('layout.primaryChat');
    expect(PERMISSION_TIERS[LAYOUT_PRIMARY_CHAT_PERMISSION]).toBe('active');
  });
});
