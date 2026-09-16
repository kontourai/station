// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  SETTINGS_CATALOG,
  settingsRow,
} from '../views/settings/settings-catalog';

/**
 * The reverse guard for `settingsRow('<id>')` (#2144 slice 5).
 *
 * `settingsRow` answers an unknown id with the placeholder title
 * `[missing settings catalog entry: <id>]`, and that string renders — it is
 * a row heading. So a typo in a call site is not a crash, a type error, or a
 * red test; it is a person reading a bracketed diagnostic in their settings.
 *
 * The existing render guard
 * (`settings-catalog-completeness.test.tsx`) walks the OTHER direction: it
 * diffs the rendered `[data-catalog-id]` set against the catalog, so it
 * proves every catalog entry reaches the DOM. It cannot see a literal that
 * names an id the catalog never had — that literal renders happily, with the
 * placeholder title, carrying its own `data-catalog-id`.
 *
 * This file is the static half. It reads source text rather than rendering,
 * so it covers call sites the render guard's harness does not mount, and it
 * names the offending id instead of reporting a set difference.
 *
 * Scope is enumerated through `git ls-files` (what git actually tracks) for
 * the same reason as `placement-vocabulary.test.ts`: a glob pathspec
 * silently excludes root-level files, and an assertion that iterates a list
 * checking non-emptiness cannot notice the list shrinking. The sentinel
 * below pins three files that must be in the enumeration, so an empty or
 * mis-scoped pathspec fails loudly instead of reporting clean.
 */
const ROOT = process.cwd();
const SCANNED_ROOT = 'src-ui/src/views';

/**
 * Three files that call `settingsRow` with literals today. If the
 * enumeration stops reaching them, the scan has lost its scope and every
 * assertion below would pass vacuously.
 */
const SCOPE_SENTINEL_FILES = [
  'src-ui/src/views/settings/SystemSection.tsx',
  'src-ui/src/views/settings/AgentDefaultsSection.tsx',
  'src-ui/src/views/settings/KnowledgeStoreSection.tsx',
] as const;

/**
 * Catalog entries whose row is rendered without a literal id and without a
 * unique config key of its own, with the renderer that supplies the id. The
 * assertion below requires the named file to exist AND to contain the id as
 * a quoted string, so an exemption cannot outlive its renderer.
 */
const DYNAMIC_ROW_RENDERERS: Readonly<
  Record<string, { readonly file: string; readonly reason: string }>
> = {
  'feature-previews': {
    file: 'src-ui/src/views/settings/FeaturePreviewsSection.tsx',
    reason:
      'The rows are per-preview and server-derived; the one catalog entry is the section anchor, written as a literal data-catalog-id rather than through settingsRow.',
  },
  'voice-pill': {
    file: 'src-ui/src/views/settings/VoiceFeaturesSection.tsx',
    reason:
      'Rendered by a shared feature-toggle component that takes the catalog id as a prop from a typed union; the three ids share the composite `featureSettings` key, so no per-row config key identifies them.',
  },
  'mobile-pairing': {
    file: 'src-ui/src/views/settings/VoiceFeaturesSection.tsx',
    reason: 'Same shared feature-toggle component as `voice-pill`.',
  },
  'tts-readback': {
    file: 'src-ui/src/views/settings/VoiceFeaturesSection.tsx',
    reason: 'Same shared feature-toggle component as `voice-pill`.',
  },
};

function trackedTsxFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '--', SCANNED_ROOT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter((path) => path.endsWith('.tsx'));
}

/** Every `settingsRow('…')` literal, with the file it was written in. */
function settingsRowLiterals(
  files: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(`${ROOT}/${file}`, 'utf8');
    for (const match of source.matchAll(/settingsRow\(\s*'([^']+)'\s*\)/g)) {
      const existing = byId.get(match[1]);
      if (existing) existing.push(file);
      else byId.set(match[1], [file]);
    }
  }
  return byId;
}

describe('settingsRow literal coverage', () => {
  const files = trackedTsxFiles();
  const literals = settingsRowLiterals(files);
  // Widened to `string` deliberately: the whole question is whether an
  // arbitrary source literal is in this set, and `Set<SettingsCatalogId>`
  // would refuse to be asked.
  const catalogIds = new Set<string>(SETTINGS_CATALOG.map((entry) => entry.id));

  test('the scan reaches the files it claims to scan', () => {
    expect(files.length).toBeGreaterThan(20);
    for (const sentinel of SCOPE_SENTINEL_FILES) {
      expect(files, `${sentinel} left the enumeration`).toContain(sentinel);
    }
    // The sentinels are only a scope proof if they actually contribute
    // literals; a file that stopped calling `settingsRow` would leave the
    // enumeration proven and the corpus empty.
    expect(literals.size).toBeGreaterThan(20);
  });

  test('every settingsRow literal names a catalog entry', () => {
    const unknown = [...literals]
      .filter(([id]) => !catalogIds.has(id))
      .map(([id, where]) => `${id} (${where.join(', ')})`);
    expect(unknown).toEqual([]);
  });

  test('the placeholder title is what an unknown literal would render', () => {
    // Pins the consequence the assertion above exists to prevent, so the
    // guard's motivation cannot quietly stop being true.
    expect(settingsRow('not-a-catalog-id').title).toBe(
      '[missing settings catalog entry: not-a-catalog-id]',
    );
  });

  test('every catalog entry has a literal, a config key, or a named renderer', () => {
    // A config key that belongs to exactly one catalog entry is the id
    // `registry-row.tsx` resolves through
    // (`settingsCatalogEntryForConfigKey`), so those rows are reached
    // without anybody writing the id down. A key SHARED by several entries
    // (the composite `featureSettings`) identifies none of them and does not
    // count. This branch proves the mechanism exists, not that the row
    // renders — `settings-catalog-completeness.test.tsx` is what proves the
    // rendering, and it is where a broken registry row would surface.
    const keyOwners = new Map<string, string[]>();
    for (const entry of SETTINGS_CATALOG) {
      for (const key of entry.configKeys ?? []) {
        const owners = keyOwners.get(key);
        if (owners) owners.push(entry.id);
        else keyOwners.set(key, [entry.id]);
      }
    }
    const orphans = SETTINGS_CATALOG.filter((entry) => {
      if (literals.has(entry.id)) return false;
      if (
        (entry.configKeys ?? []).some(
          (key) => (keyOwners.get(key) ?? []).length === 1,
        )
      )
        return false;
      return DYNAMIC_ROW_RENDERERS[entry.id] === undefined;
    }).map((entry) => entry.id);
    expect(orphans).toEqual([]);
  });

  test('each named renderer exists and still names its id', () => {
    for (const [id, { file }] of Object.entries(DYNAMIC_ROW_RENDERERS)) {
      expect(catalogIds, `${id} is not a catalog id`).toContain(id);
      expect(
        literals.has(id),
        `${id} now has a settingsRow literal; drop its exemption`,
      ).toBe(false);
      expect(files, `${file} is not tracked`).toContain(file);
      const source = readFileSync(`${ROOT}/${file}`, 'utf8');
      expect(
        source.includes(`'${id}'`) || source.includes(`"${id}"`),
        `${file} no longer names ${id}`,
      ).toBe(true);
    }
  });
});
