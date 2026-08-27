import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateContributorCommands,
  parseJustInterface,
  renderContributorCommands,
  topLevelRecipes,
} from '../just-interface.mjs';

const JUSTFILE = readFileSync(resolve(process.cwd(), 'justfile'), 'utf8');
const DEVELOPMENT_GUIDE = readFileSync(
  resolve(process.cwd(), 'docs/guides/development.md'),
  'utf8',
);
const CONTRIBUTING = readFileSync(
  resolve(process.cwd(), 'CONTRIBUTING.md'),
  'utf8',
);
const COMMAND_REFERENCE = readFileSync(
  resolve(process.cwd(), 'docs/reference/contributor-commands.md'),
  'utf8',
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
};

const PUBLIC_RECIPES = [
  'setup',
  'doctor',
  'dev',
  'check',
  'test',
  'full',
  'desktop',
  'android',
  'release-check',
] as const;
const RECIPE_DESCRIPTIONS = {
  default: 'List Station contributor commands.',
  setup: 'Install the lockfile-pinned Node dependency tree.',
  doctor: 'Report Station readiness through the repository CLI.',
  dev: 'Start a local Station instance.',
  check: "Run Station's canonical static verification lane.",
  test: 'Select changed tests or run explicit focused test files.',
  full: 'Run the sole completion lane without adding a second receipt protocol.',
  desktop: 'Launch the native desktop development shell.',
  android:
    "Build the Android debug APK through Station's existing native build command.",
  'release-check':
    'Run the existing release-static preflight; it does not publish a release.',
} as const;

function recipeBodies(recipe: string): string[] {
  return (['unix', 'windows'] as const).map(
    (platform) => platformRecipe(recipe, platform).body,
  );
}

function platformRecipe(recipe: string, platform: 'unix' | 'windows') {
  const header = new RegExp(
    String.raw`\[${platform}\]\n(?<attributes>(?:\[[^\n]+\]\n)*)${recipe.replace('-', '\\-')}(?:\s+[^:\n]+)?:\n(?<body>(?:    .*\n?)*)`,
  );
  const match = JUSTFILE.match(header);
  if (!match?.groups)
    throw new Error(`missing ${platform} implementation for ${recipe}`);
  return {
    attributes: match.groups.attributes,
    body: match.groups.body.replace(/^ {4}/gm, ''),
  };
}

describe('just contributor Interface', () => {
  it('generates the canonical reference from all paired recipe metadata and source', () => {
    const recipes = parseJustInterface(JUSTFILE);
    expect(recipes.map(({ name }) => name)).toEqual(PUBLIC_RECIPES);
    expect(renderContributorCommands(recipes)).toBe(COMMAND_REFERENCE);
    expect(generateContributorCommands().recipes).toHaveLength(9);
    for (const recipe of PUBLIC_RECIPES)
      expect(COMMAND_REFERENCE).toContain(`Run: \`just ${recipe}`);
  });

  it('rejects any unannotated, one-platform, or otherwise rogue top-level recipe', () => {
    expect(() =>
      parseJustInterface(`${JUSTFILE}\nrogue:\n    echo rogue\n`),
    ).toThrow('public recipe topology must be exactly');
    expect(() =>
      parseJustInterface(`${JUSTFILE}\n[unix]\nrogue:\n    echo rogue\n`),
    ).toThrow('public recipe topology must be exactly');
    for (const rogue of ['rogue_2', 'Rogue2']) {
      expect(() =>
        parseJustInterface(`${JUSTFILE}\n${rogue}:\n    echo rogue\n`),
      ).toThrow('public recipe topology must be exactly');
    }
  });

  it('inventories private Just recipes without exposing them as public commands', () => {
    const privateRecipe = `${JUSTFILE}\n_private_helper:\n    echo private\n`;
    expect(parseJustInterface(privateRecipe)).toHaveLength(9);
    expect(topLevelRecipes(privateRecipe)).toContain('_private_helper');
  });

  it('defaults to its documented public recipe list with exact one-line descriptions', () => {
    expect(JUSTFILE).toMatch(/default:\n {4}@just --list/);
    expect(JUSTFILE).toContain(`# ${RECIPE_DESCRIPTIONS.default}\ndefault:`);
    for (const recipe of PUBLIC_RECIPES) {
      expect(recipeBodies(recipe)).toHaveLength(2);
      for (const platform of ['unix', 'windows']) {
        expect(
          JUSTFILE,
          `${recipe} needs the exact just --list description on ${platform}`,
        ).toContain(`# ${RECIPE_DESCRIPTIONS[recipe]}\n[${platform}]`);
      }
    }
  });

  it('keeps every convenience recipe mapped to an existing canonical command', () => {
    const expected = {
      setup: 'npm ci',
      check: 'npm run verify:static',
      full: 'npm run full:regression',
      desktop: 'npm run dev:desktop',
      android: 'npm run build:android',
      'release-check': 'npm run release:static',
    };

    for (const [recipe, command] of Object.entries(expected)) {
      expect(recipeBodies(recipe)).toEqual([
        `${command}\n`,
        `@call ${command}\n@exit /b %ERRORLEVEL%\n`,
      ]);
    }

    for (const script of [
      'verify:static',
      'full:regression',
      'dev:desktop',
      'build:android',
      'release:static',
      'test:changed',
      'test:focused',
    ]) {
      expect(
        PACKAGE_JSON.scripts[script],
        `${script} must remain a canonical npm script`,
      ).toBeTypeOf('string');
    }
  });

  it('preserves the exact completion-lane delegation and does not reimplement it', () => {
    expect(recipeBodies('full')).toEqual([
      'npm run full:regression\n',
      '@call npm run full:regression\n@exit /b %ERRORLEVEL%\n',
    ]);
    expect(JUSTFILE).not.toMatch(
      /full:regression:raw|run-verification\.mjs request full-regression/,
    );
  });

  it('uses the Station CLI on Unix and a batch-script source entrypoint on Windows', () => {
    expect(recipeBodies('doctor')).toEqual([
      './station doctor "$@"\n',
      '@call npx tsx scripts/station-cli.ts doctor %*\n@exit /b %ERRORLEVEL%\n',
    ]);
    expect(recipeBodies('dev')).toEqual([
      './station start "$@"\n',
      '@call npx tsx scripts/station-cli.ts start %*\n@exit /b %ERRORLEVEL%\n',
    ]);
  });

  it('uses one generated cmd process with positional argv and durable exit codes', () => {
    const scriptAttribute =
      '[script("cmd.exe", "/D", "/E:ON", "/V:OFF", "/C")]';
    for (const recipe of PUBLIC_RECIPES) {
      expect(platformRecipe(recipe, 'windows').attributes).toContain(
        scriptAttribute,
      );
    }
    for (const recipe of ['doctor', 'dev', 'test']) {
      expect(platformRecipe(recipe, 'windows').attributes).toContain(
        '[positional-arguments]',
      );
    }
    expect(platformRecipe('test', 'windows').body).toContain(
      '@call npm run test:focused -- %*',
    );
    expect(JUSTFILE).toContain('@exit /b %ERRORLEVEL%');
    expect(JUSTFILE).not.toContain('powershell.exe');
  });

  it('keeps changed selection, focused execution, argument boundaries, and exit codes platform-safe', () => {
    expect(recipeBodies('test')).toEqual([
      'if [ "$#" -eq 0 ]; then npm run test:changed -- --base=origin/main; else npm run test:focused -- "$@"; fi\n',
      '@if not "%~1"=="" goto focused\n@call npm run test:changed -- "--base=origin/main"\n@exit /b %ERRORLEVEL%\n:focused\n@call npm run test:focused -- %*\n@exit /b %ERRORLEVEL%\n',
    ]);
    expect(JUSTFILE).toContain(
      'set windows-shell := ["cmd.exe", "/D", "/E:ON", "/V:OFF", "/C"]',
    );
    expect(JUSTFILE).not.toContain('{{ args }}');
    expect(DEVELOPMENT_GUIDE).toContain(
      './station start --instance=dev-smoke --temp-home --clean --force --port=3242 --ui-port=5274',
    );
    expect(DEVELOPMENT_GUIDE).not.toContain(
      './station start --instance dev-smoke',
    );
    for (const guidance of [CONTRIBUTING, DEVELOPMENT_GUIDE]) {
      expect(guidance).toContain('contributor-commands.md');
      expect(guidance).toContain('just --version');
      expect(guidance).toContain('npm run full:regression');
      expect(guidance).toContain('1.44.0');
      expect(guidance).toContain('brew install just');
      expect(guidance).toContain('cargo install just --locked');
      expect(guidance).toContain('winget install --id Casey.Just --exact');
    }
  });
});
