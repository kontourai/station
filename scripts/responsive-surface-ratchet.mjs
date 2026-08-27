import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const INVENTORY = join(ROOT, 'docs/ui/responsive-surfaces.json');
const SOURCE_ROOTS = ['src-ui/src', 'packages/connect/src/react'];
// `Sheet` joined the vocabulary after #972 shipped three ResponsiveDialogSurface
// dialogs named `*Sheet.tsx` (ComposerModeSheet, ChatDockMobileOverflowSheet,
// ToolCallBatchSheet) that the Modal/Drawer/Popover triad could not see — the
// modal-like list, and with it the no-Station-exceptions and contract-adoption
// checks, silently skipped every one of them.
const SURFACE_FILE = /(Modal|Drawer|Popover|Sheet)[^/]*\.tsx$/;
const ACTION_CLASS =
  /className=(?:"[^"]*(?:actions|footer|toolbar)[^"]*"|\{`[^`]*(?:actions|footer|toolbar)[^`]*`\})/i;
const SHARED_DIALOG_CONTRACT = 'ResponsiveDialogSurface';

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function discoverResponsiveSurfaces() {
  return SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root)))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .filter((path) => SURFACE_FILE.test(path))
    .filter((path) => !path.includes('/__tests__/') && !path.includes('.test.'))
    .sort();
}

export function discoverResponsiveActionSurfaces() {
  return SOURCE_ROOTS.flatMap((root) => walk(join(ROOT, root)))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.tsx'))
    .filter((path) => !path.includes('/__tests__/') && !path.includes('.test.'))
    .filter((path) => ACTION_CLASS.test(readFileSync(join(ROOT, path), 'utf8')))
    .sort();
}

function parseActionInventory(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [surfacePath, strategy, evidence] = line.split('|');
      return { path: surfacePath, strategy, evidence };
    });
}

export function validateResponsiveSurfaceInventory() {
  const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const entries = inventory.surfaces ?? [];
  const ownerRules = inventory.ownerRules ?? [];
  const paths = entries.map((entry) => entry.path);
  const discovered = discoverResponsiveSurfaces();
  const missing = discovered.filter((path) => !paths.includes(path));
  const stale = paths.filter((path) => !discovered.includes(path));
  const invalid = entries.filter(
    (entry) =>
      !['covered', 'exception'].includes(entry.strategy) ||
      typeof entry.evidence !== 'string' ||
      entry.evidence.trim().length < 8 ||
      !ownerRules.some(
        (rule) =>
          typeof rule.owner === 'string' && entry.path.startsWith(rule.prefix),
      ),
  );
  const duplicates = paths.filter(
    (path, index) => paths.indexOf(path) !== index,
  );
  const stationExceptions = entries.filter(
    (entry) =>
      entry.path.startsWith('src-ui/src/') && entry.strategy === 'exception',
  );
  const invalidContracts = entries.filter(
    (entry) =>
      entry.contract !== undefined && entry.contract !== SHARED_DIALOG_CONTRACT,
  );
  const missingContractAdoption = entries.filter((entry) => {
    if (entry.contract !== SHARED_DIALOG_CONTRACT) return false;
    return !readFileSync(join(ROOT, entry.path), 'utf8').includes(
      SHARED_DIALOG_CONTRACT,
    );
  });
  const actionEntries = parseActionInventory(
    join(ROOT, inventory.actionInventory),
  );
  const actionPaths = actionEntries.map((entry) => entry.path);
  const discoveredActions = discoverResponsiveActionSurfaces();
  const missingActions = discoveredActions.filter(
    (path) => !actionPaths.includes(path),
  );
  const staleActions = actionPaths.filter(
    (path) => !discoveredActions.includes(path),
  );
  const invalidActions = actionEntries.filter(
    (entry) =>
      !['covered', 'exception'].includes(entry.strategy) ||
      !entry.evidence ||
      entry.evidence.trim().length < 8,
  );
  if (
    missing.length ||
    stale.length ||
    invalid.length ||
    duplicates.length ||
    stationExceptions.length ||
    invalidContracts.length ||
    missingContractAdoption.length ||
    missingActions.length ||
    staleActions.length ||
    invalidActions.length
  ) {
    throw new Error(
      JSON.stringify({
        missing,
        stale,
        invalid: invalid.map((entry) => entry.path),
        duplicates,
        stationExceptions: stationExceptions.map((entry) => entry.path),
        invalidContracts: invalidContracts.map((entry) => entry.path),
        missingContractAdoption: missingContractAdoption.map(
          (entry) => entry.path,
        ),
        missingActions,
        staleActions,
        invalidActions: invalidActions.map((entry) => entry.path),
      }),
    );
  }
  return {
    total: discovered.length,
    covered: entries.filter((entry) => entry.strategy === 'covered').length,
    actionTotal: discoveredActions.length,
    actionCovered: actionEntries.filter((entry) => entry.strategy === 'covered')
      .length,
    sharedDialogContracts: entries.filter(
      (entry) => entry.contract === SHARED_DIALOG_CONTRACT,
    ).length,
  };
}

if (process.argv[1]?.endsWith('responsive-surface-ratchet.mjs')) {
  const result = validateResponsiveSurfaceInventory();
  console.log(
    `Responsive surface inventory: ${result.total} modal-like surfaces (${result.covered} covered; ${result.sharedDialogContracts} shared dialog contracts), ${result.actionTotal} action surfaces (${result.actionCovered} covered).`,
  );
}
