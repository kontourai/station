import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Exact inventory of production localStorage that deliberately remains outside
 * the device-settings envelope. These are runtime/session memories, caches,
 * credentials, or ephemeral layout state — not user-editable settings.
 */
const ALLOWED_RAW_LOCAL_STORAGE_KEYS = [
  'debug', // Development-only logger bootstrap flag, not a product preference.
  'lastProject', // Navigation restore pointer to the last visited project.
  'lastProjectLayout', // Navigation restore pointer to the last visited layout.
  'recentAgents', // Derived MRU used for picker ordering, not a setting.
  'recentLayouts', // Derived MRU used for picker ordering, not a setting.
  'station-device-settings-v1', // The versioned device-settings envelope itself.
  'station.activity.snoozed', // Per-work-item snooze state, not a setting.
  'station.activity.terminalSince', // Terminal activity cursor.
  'station-attached-session-continuations-v1', // Exact Attached Session continuation evidence.
  'station.background-tasks.sections', // Ephemeral panel disclosure state.
  'station.banners.dismissed', // Per-occurrence banner dismissals, not a setting.
  'station.chatDock.snap', // Ephemeral dock geometry/snap state.
  'station.coding.treeSnap', // Ephemeral coding-tree selection state.
  'station.dockFirstRunSeen', // One-time affordance marker.
  'station.usage-telemetry-disclosure.snoozed', // Time-bounded disclosure deferral, not acknowledgement or a user-editable setting.
  // archive#3122's `station.home.variant` used to sit here. It was written by
  // one deletable module and read by nothing else, exactly so that retiring
  // the variant experiment would take no DEVICE_SETTINGS_REGISTRY entry with
  // it — and that is what happened: Home is one surface again and the key is
  // gone from the source, so it is gone from here too rather than left as an
  // allowance for a writer that no longer exists.
  'station.newChat.lastModelByBinding', // Derived per-agent last-choice memory.
  'station-starter-work-operations-v1', // Exact Starter Work retry-operation evidence.
  'station-layout-tabs', // Per-layout navigation memory.
  'station:chat-drafts:v1', // Draft message content, not a setting.
  'theme', // Read-only first-paint compatibility path; migrated and deleted by the envelope.
  'station-accent-color', // Read-only first-paint compatibility path; migrated and deleted by the envelope.
] as const;

// Known accepted limitation ( 2, accepted-with-rationale): this is
// a syntax gate against ACCIDENTAL drift, not adversarial evasion — an aliased
// receiver (`const s = window.localStorage; s.setItem(...)`) escapes it. The
// allowlisted modules therefore export only semantic-id helpers that derive
// their storage keys internally, so the allowlist cannot be laundered through
// a re-exported raw-key writer.
const ALLOWED_COMPUTED_KEY_FILES = new Set([
  'components/chat-dock/conversationContextBoundaryUiState.ts', // Boundary UI state is scoped by conversation id; `key` is module-private and every export takes the semantic id, never a raw key.
  'components/SplitPaneLayout.tsx', // Pane geometry is scoped by the caller-provided pane id.
  'components/split-pane-metrics.ts', // Shared pane restoration reads the same pane-id-scoped geometry key.
  'core/remotePluginBundleConsent.ts', // Consent is scoped by the normalized remote plugin origin.
  'hooks/useSidePanelCollapse.ts', // Collapse state is scoped by project and layout slugs.
]);

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionFiles(full);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function literalConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isStringLiteralLike(declaration.initializer)
      ) {
        constants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  });
  return constants;
}

function productionLiteralConstants(): Map<string, string> {
  const values = new Map<string, Set<string>>();
  for (const file of productionFiles(SOURCE_ROOT)) {
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const [name, value] of literalConstants(sourceFile)) {
      const namedValues = values.get(name) ?? new Set<string>();
      namedValues.add(value);
      values.set(name, namedValues);
    }
  }
  return new Map(
    [...values]
      .filter(([, namedValues]) => namedValues.size === 1)
      .map(([name, namedValues]) => [name, [...namedValues][0]]),
  );
}

function rawLocalStorageUsage(): {
  keys: string[];
  unallowlistedComputedKeys: string[];
} {
  const keys = new Set<string>();
  const unallowlistedComputedKeys: string[] = [];
  const knownProductionConstants = productionLiteralConstants();
  for (const file of productionFiles(SOURCE_ROOT)) {
    if (path.relative(SOURCE_ROOT, file) === 'lib/device-settings-store.ts') {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const constants = literalConstants(sourceFile);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['getItem', 'setItem', 'removeItem'].includes(
          node.expression.name.text,
        ) &&
        /(?:^|\.)localStorage$/.test(
          node.expression.expression.getText(sourceFile),
        )
      ) {
        const key = node.arguments[0];
        if (ts.isStringLiteralLike(key)) keys.add(key.text);
        else if (ts.isIdentifier(key) && constants.has(key.text))
          keys.add(constants.get(key.text)!);
        else if (ts.isIdentifier(key) && knownProductionConstants.has(key.text))
          keys.add(knownProductionConstants.get(key.text)!);
        else {
          const relativeFile = path.relative(SOURCE_ROOT, file);
          if (!ALLOWED_COMPUTED_KEY_FILES.has(relativeFile)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              key?.getStart(sourceFile) ?? node.getStart(sourceFile),
            );
            unallowlistedComputedKeys.push(
              `${relativeFile}:${line + 1} ${node.expression.name.text}(${key?.getText(sourceFile) ?? '<missing>'})`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    keys: [...keys].sort(),
    unallowlistedComputedKeys: unallowlistedComputedKeys.sort(),
  };
}

describe('raw localStorage policy', () => {
  test('enumerates the exact allowed production keys outside device settings', () => {
    const usage = rawLocalStorageUsage();
    expect(usage.keys).toEqual([...ALLOWED_RAW_LOCAL_STORAGE_KEYS].sort());
    expect(
      usage.unallowlistedComputedKeys,
      'Computed localStorage keys must be confined to an explicitly allowlisted module',
    ).toEqual([]);
  });
});
