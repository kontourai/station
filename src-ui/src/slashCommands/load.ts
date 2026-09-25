// The built-in `/commands` register themselves as a side effect of importing
// their modules. Importing them statically from the chat-input hook put them in
// the entry chunk (epic #61); they are only consulted when a typed command is
// dispatched, so they load on demand instead. The menu's command list is
// static (`useSlashCommands`) and never waits on this.
let pending: Promise<void> | undefined;

export function loadSlashCommands(): Promise<void> {
  pending ??= Promise.all([import('./builtins'), import('./tools')]).then(
    () => undefined,
    (error: unknown) => {
      // A failed chunk fetch must not poison every later dispatch. This only
      // re-requests the import; whether the browser fetches it again or
      // replays its cached failure until reload is the browser's call (the
      // same assumption LazyBoundary's Retry makes).
      pending = undefined;
      throw error;
    },
  );
  return pending;
}
