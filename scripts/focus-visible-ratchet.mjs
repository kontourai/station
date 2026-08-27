import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const INVENTORY = join(ROOT, 'docs/ui/focus-outline-exceptions.json');
const SOURCE_ROOTS = ['src-ui/src', 'packages/connect/src/react'];

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalizeSelector(selector) {
  return selector.replace(/\s+/g, ' ').trim();
}

export function findOutlineSuppressions(css, path) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const suppressions = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of withoutComments.matchAll(rulePattern)) {
    const selector = normalizeSelector(match[1]);
    const declarations = match[2];
    if (
      /(?:^|;)\s*outline\s*:\s*(?:none|0)\s*(?:!important\s*)?(?:;|$)/i.test(
        declarations,
      )
    ) {
      suppressions.push({ path, selector });
    }
  }

  return suppressions;
}

export function discoverOutlineSuppressions(root = ROOT) {
  return SOURCE_ROOTS.flatMap((sourceRoot) =>
    walk(join(root, sourceRoot))
      .filter((path) => path.endsWith('.css'))
      .flatMap((path) => {
        const relativePath = relative(root, path).replaceAll('\\', '/');
        return findOutlineSuppressions(
          readFileSync(path, 'utf8'),
          relativePath,
        );
      }),
  ).sort((a, b) =>
    `${a.path}|${a.selector}`.localeCompare(`${b.path}|${b.selector}`),
  );
}

function key(entry) {
  return `${entry.path}|${entry.selector}`;
}

export function validateFocusOutlineInventory(
  root = ROOT,
  inventoryPath = INVENTORY,
) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const entries = inventory.exceptions ?? [];
  const discovered = discoverOutlineSuppressions(root);
  const discoveredKeys = discovered.map(key);
  const inventoryKeys = entries.map(key);
  const missing = discovered.filter(
    (entry) => !inventoryKeys.includes(key(entry)),
  );
  const stale = entries.filter((entry) => !discoveredKeys.includes(key(entry)));
  const invalid = entries.filter(
    (entry) =>
      typeof entry.path !== 'string' ||
      typeof entry.selector !== 'string' ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 8,
  );
  const duplicates = inventoryKeys.filter(
    (entryKey, index) => inventoryKeys.indexOf(entryKey) !== index,
  );

  if (missing.length || stale.length || invalid.length || duplicates.length) {
    throw new Error(
      JSON.stringify({
        missing,
        stale: stale.map(({ path, selector }) => ({ path, selector })),
        invalid: invalid.map(({ path, selector }) => ({ path, selector })),
        duplicates,
      }),
    );
  }

  return { total: discovered.length };
}

if (process.argv[1]?.endsWith('focus-visible-ratchet.mjs')) {
  const result = validateFocusOutlineInventory();
  console.log(
    `Focus-visible ratchet: ${result.total} reviewed outline suppressions; new exceptions are blocked.`,
  );
}
