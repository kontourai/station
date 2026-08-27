import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const JUSTFILE = 'justfile';
export const REFERENCE = 'docs/reference/contributor-commands.md';
export const PUBLIC_RECIPES = Object.freeze([
  'default',
  'setup',
  'doctor',
  'dev',
  'check',
  'test',
  'full',
  'desktop',
  'android',
  'release-check',
]);
const JUST_IDENTIFIER = '[_a-zA-Z][_a-zA-Z0-9-]*';

function isPrivateRecipe(name) {
  return name.startsWith('_');
}

/** All top-level Just recipes, including unannotated and one-platform entries. */
export function topLevelRecipes(source) {
  return [
    ...source.matchAll(
      new RegExp(`^(?<name>${JUST_IDENTIFIER})(?:\\s+[^:\\n]+)?:$`, 'gm'),
    ),
  ].map(({ groups }) => groups.name);
}

function platformRecipes(source, platform) {
  const pattern = new RegExp(
    String.raw`(?:^|\n)# (?<description>[^\n]+)\n\[${platform}\]\n(?<attributes>(?:\[[^\n]+\]\n)*)?(?<name>${JUST_IDENTIFIER})(?<arguments>[^:\n]*):\n(?<body>(?: {4}.*\n?)*)`,
    'g',
  );
  const recipes = [];
  for (const match of source.matchAll(pattern)) {
    const {
      attributes = '',
      arguments: recipeArguments = '',
      body = '',
      description,
      name,
    } = match.groups;
    recipes.push({
      attributes: attributes.trimEnd(),
      body: body.replace(/^ {4}/gm, ''),
      description,
      name,
      positionalArguments: recipeArguments.includes('*args'),
    });
  }
  return recipes.filter((recipe) => !isPrivateRecipe(recipe.name));
}

/**
 * The contributor Interface is the paired Unix/Windows recipe metadata in the
 * checked justfile.  This parser intentionally has no duplicate command table:
 * its description and command bodies are the source the reference renders.
 */
export function parseJustInterface(source) {
  const topLevel = topLevelRecipes(source).filter(
    (name) => !isPrivateRecipe(name),
  );
  const errors = [];
  const logicalTopLevel = [...new Set(topLevel)];
  const counts = new Map(
    logicalTopLevel.map((name) => [
      name,
      topLevel.filter((candidate) => candidate === name).length,
    ]),
  );
  if (logicalTopLevel.join('\0') !== PUBLIC_RECIPES.join('\0'))
    errors.push(
      `public recipe topology must be exactly ${PUBLIC_RECIPES.join(', ')}; found ${logicalTopLevel.join(', ') || '<none>'}`,
    );
  for (const name of PUBLIC_RECIPES) {
    const expected = name === 'default' ? 1 : 2;
    if (counts.get(name) !== expected)
      errors.push(
        `top-level recipe ${name} must have ${expected} implementation${expected === 1 ? '' : 's'}; found ${counts.get(name) ?? 0}`,
      );
  }
  const byPlatform = new Map(
    ['unix', 'windows'].map((platform) => [
      platform,
      platformRecipes(source, platform),
    ]),
  );
  const unix = byPlatform.get('unix');
  const windows = byPlatform.get('windows');
  for (const [platform, recipes] of byPlatform) {
    const names = new Set();
    for (const recipe of recipes) {
      if (names.has(recipe.name))
        errors.push(`duplicate ${platform} recipe: ${recipe.name}`);
      names.add(recipe.name);
    }
  }
  const windowsByName = new Map(windows.map((recipe) => [recipe.name, recipe]));
  const unixNames = new Set(unix.map((recipe) => recipe.name));
  for (const recipe of unix) {
    const windowsRecipe = windowsByName.get(recipe.name);
    if (!windowsRecipe)
      errors.push(`missing Windows implementation for recipe: ${recipe.name}`);
    else if (windowsRecipe.description !== recipe.description)
      errors.push(`recipe description differs by platform: ${recipe.name}`);
  }
  for (const recipe of windows) {
    if (!unixNames.has(recipe.name))
      errors.push(`missing Unix implementation for recipe: ${recipe.name}`);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return unix.map((recipe) => ({
    ...recipe,
    windows: windowsByName.get(recipe.name),
  }));
}

function fenced(language, body) {
  if (body.includes('```'))
    throw new Error('recipe body cannot contain a Markdown fence');
  return [`\`\`\`${language}`, body.trimEnd(), '```'].join('\n');
}

export function renderContributorCommands(recipes) {
  const sections = recipes.flatMap((recipe) => [
    `## \`${recipe.name}\``,
    '',
    recipe.description,
    '',
    `Run: \`just ${recipe.name}${recipe.positionalArguments ? ' [arguments...]' : ''}\``,
    '',
    '### macOS and Linux',
    '',
    fenced('sh', recipe.body),
    '',
    '### Windows Command Prompt',
    '',
    fenced('bat', recipe.windows.body),
    '',
  ]);
  return [
    '<!-- station:contributor-commands:start -->',
    '# Contributor commands',
    '',
    'This reference is generated from the paired Unix and Windows recipe metadata in `justfile`. It is the exact convenience-command interface; the invoked npm scripts and verification coordinator remain the canonical implementation and completion-receipt authorities.',
    '',
    ...sections,
    '<!-- station:contributor-commands:end -->',
    '',
  ].join('\n');
}

export function generateContributorCommands({
  rootDir = ROOT,
  write = false,
  readFile = readFileSync,
  writeFile = writeFileSync,
} = {}) {
  const recipes = parseJustInterface(
    readFile(resolve(rootDir, JUSTFILE), 'utf8'),
  );
  const projection = renderContributorCommands(recipes);
  const referencePath = resolve(rootDir, REFERENCE);
  if (write) {
    writeFile(referencePath, projection);
    return { projection, recipes };
  }
  if (!existsSync(referencePath))
    throw new Error(`contributor-command reference is missing: ${REFERENCE}`);
  if (readFile(referencePath, 'utf8') !== projection)
    throw new Error(
      `contributor-command reference drifted from ${JUSTFILE}; run node scripts/just-interface.mjs --write`,
    );
  return { projection, recipes };
}

if (process.argv[1]?.endsWith('just-interface.mjs')) {
  try {
    const { recipes } = generateContributorCommands({
      write: process.argv.includes('--write'),
    });
    console.log(
      `Contributor command reference covers ${recipes.length} recipes.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
