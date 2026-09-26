import { useModelPickerCatalogQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { runtimeCatalogVisibleModels } from '../utils/execution';
import { modelIdentityLabel } from '../utils/modelCapabilities';
import type { ResolveModelLabel } from '../views/home/home-view-model';

/**
 * archive#3391: rows that name a model resolve it through the model catalog,
 * unioned across every connection this Station knows, so one session reads
 * "GPT-6-Sol" everywhere instead of a catalog-free "Gpt 6 Sol" on the
 * surfaces that forgot to pass a resolver. Home and the chat dock's inboxes
 * share this so they cannot drift again.
 *
 * Union, so first-match wins if two connections publish the SAME model id
 * under different names. Left as-is deliberately: de-duplicating would have
 * to pick a winner, and the honest winner is the connection the SESSION runs
 * on — a per-row lookup the rows do not carry. The failure mode is a
 * right-shaped name from the wrong connection rather than the internal id.
 */
export function useCatalogModelLabel(): {
  resolveModelLabel: ResolveModelLabel;
  isLoading: boolean;
} {
  const { data: pickerCatalog, isLoading } = useModelPickerCatalogQuery();
  const resolveModelLabel = useMemo(() => {
    const catalog = [
      ...(pickerCatalog?.agentConnections ?? []),
      ...(pickerCatalog?.modelConnections ?? []),
    ].flatMap((connection) => runtimeCatalogVisibleModels(connection));
    return (modelId: string | null | undefined) =>
      modelIdentityLabel(modelId, catalog);
  }, [pickerCatalog?.agentConnections, pickerCatalog?.modelConnections]);
  return { resolveModelLabel, isLoading };
}
