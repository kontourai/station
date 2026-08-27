import { Empty } from '../state';

/** Eager empty catalog surface shared by the lazy picker and its opener. */
export function ModelCatalogUnavailableState({ stale }: { stale: boolean }) {
  return (
    <Empty
      className="session-model-picker__state"
      variant="compact"
      label={
        stale
          ? 'Models unavailable while this Station is unreachable'
          : 'This engine reported no selectable models'
      }
    />
  );
}
