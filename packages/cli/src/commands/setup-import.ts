/** Canonical `station setup import` adapter over the SDK client seam. */
import {
  applyExistingSetupImport,
  createExistingSetupImportPreview,
  detectExistingSetupImportSources,
  type ExistingSetupImportItem,
  fetchExistingSetupImportReceipt,
  reviewExistingSetupImportTargets,
  rollbackExistingSetupImport,
} from '@kontourai/station-sdk/setup-imports';
import {
  configureApiCredential,
  loadJsonPayload,
  parseCoreArgs,
  printJson,
  requirePositional,
  resolveApiBase,
} from './core-api.js';

function asApplyItems(value: unknown): ExistingSetupImportItem[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { items?: unknown }).items)
  ) {
    throw new Error('Setup import apply requires --data={"items":[...]}.');
  }
  return (value as { items: ExistingSetupImportItem[] }).items;
}

export async function runSetupImportCommand(args: string[]): Promise<void> {
  const parsed = parseCoreArgs(args);
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);
  const action = requirePositional(parsed, 0, 'setup import action');

  switch (action) {
    case 'detect':
      printJson(await detectExistingSetupImportSources(apiBase));
      return;
    case 'preview': {
      const sourceId =
        typeof parsed.flags.source === 'string'
          ? parsed.flags.source
          : requirePositional(parsed, 1, 'setup import source');
      printJson(await createExistingSetupImportPreview(apiBase, sourceId));
      return;
    }
    case 'apply': {
      const previewId = requirePositional(parsed, 1, 'preview id');
      const payload = (await loadJsonPayload(parsed)) as {
        witnessId?: unknown;
      };
      if (
        typeof payload.witnessId !== 'string' ||
        payload.witnessId.length === 0
      )
        throw new Error(
          'Setup import apply requires --data={"witnessId":"..."}.',
        );
      printJson(
        await applyExistingSetupImport(apiBase, {
          previewId,
          witnessId: payload.witnessId,
        }),
      );
      return;
    }
    case 'review-targets': {
      const previewId = requirePositional(parsed, 1, 'preview id');
      printJson(
        await reviewExistingSetupImportTargets(apiBase, {
          previewId,
          items: asApplyItems(await loadJsonPayload(parsed)),
        }),
      );
      return;
    }
    case 'receipt':
      printJson(
        await fetchExistingSetupImportReceipt(
          apiBase,
          requirePositional(parsed, 1, 'receipt id'),
        ),
      );
      return;
    case 'rollback':
      printJson(
        await rollbackExistingSetupImport(
          apiBase,
          requirePositional(parsed, 1, 'receipt id'),
        ),
      );
      return;
    default:
      throw new Error(
        "Unknown setup import action. Use 'detect', 'preview', 'review-targets', 'apply', 'receipt', or 'rollback'.",
      );
  }
}
