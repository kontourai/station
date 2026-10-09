import type { SelectableModel } from '../utils/modelCapabilities';
import {
  type ModelPickerPreferences,
  modelPreferenceKey,
  updateModelPickerPreferences,
} from './modelPickerPreferences';

export function modelChoiceKey(
  model: SelectableModel,
  providerId?: string,
): string {
  const binding = model.providerId ?? providerId ?? 'current';
  const stationBinding =
    model.environmentId && model.environmentId !== 'current'
      ? JSON.stringify([model.environmentId, binding])
      : binding;
  return modelPreferenceKey(stationBinding, model.id);
}

export function visibleModelChoices(
  models: readonly SelectableModel[],
  preferences: ModelPickerPreferences,
  query: string,
  filter = 'all',
  providerId?: string,
): SelectableModel[] {
  const needle = query.trim().toLowerCase();
  const recent = new Map(preferences.recents.map((key, index) => [key, index]));
  const order = new Map(preferences.order.map((key, index) => [key, index]));
  return models
    .filter((model) => {
      const key = modelChoiceKey(model, providerId);
      if (preferences.hidden.includes(key)) return false;
      if (!needle && filter !== 'all') {
        if (filter === 'favorites' && !preferences.favorites.includes(key))
          return false;
        if (filter === 'recents' && !recent.has(key)) return false;
        if (
          !['favorites', 'recents'].includes(filter) &&
          model.providerId !== filter &&
          model.executionAgentId !== filter
        )
          return false;
      }
      return (
        !needle ||
        [
          model.name,
          model.id,
          model.originalId,
          model.providerName,
          model.engineName,
          model.stationName,
        ].some((value) => value?.toLowerCase().includes(needle))
      );
    })
    .sort((a, b) => {
      const aKey = modelChoiceKey(a, providerId);
      const bKey = modelChoiceKey(b, providerId);
      for (const index of [order, recent]) {
        if (index.has(aKey) || index.has(bKey)) {
          return (
            (index.get(aKey) ?? Number.MAX_SAFE_INTEGER) -
            (index.get(bKey) ?? Number.MAX_SAFE_INTEGER)
          );
        }
      }
      return 0;
    });
}

export function chooseModelRoute(
  model: SelectableModel,
  onSelect: (model: SelectableModel) => void,
  providerId?: string,
): boolean {
  if (model.available === false) return false;
  const key = modelChoiceKey(model, providerId);
  updateModelPickerPreferences((current) => ({
    ...current,
    recents: [key, ...current.recents.filter((entry) => entry !== key)],
  }));
  onSelect(model);
  return true;
}
