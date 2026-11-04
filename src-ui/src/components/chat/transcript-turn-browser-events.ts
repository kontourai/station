export const BROWSE_TURNS_EVENT = 'station:browse-transcript-turns';
export function requestTurnBrowser(chatStoreId: string) {
  window.dispatchEvent(
    new CustomEvent(BROWSE_TURNS_EVENT, { detail: { chatStoreId } }),
  );
}
