import { invokeTauri } from './tauriInvoke';

/**
 * This desktop installation's persisted id (#2587), from the native host's
 * `desktop_installation_id` command. The host generates it once and keeps
 * it in its config directory, so it — and the delivery surface
 * `local:desktop-<id>` built from it — survive reloads and restarts.
 *
 * Remembered per document once read. A host without the command (a web
 * build, an older shell) or a value that is not a UUID yields `undefined`:
 * no surface, so no feed — never an invented id.
 */
let pending: Promise<string | undefined> | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function desktopInstallationId(
  invoke: (command: string) => Promise<unknown> = invokeTauri,
): Promise<string | undefined> {
  pending ??= invoke('desktop_installation_id').then(
    (value) =>
      typeof value === 'string' && UUID.test(value) ? value : undefined,
    () => undefined,
  );
  return pending;
}

/** Test seam: a fresh document. */
export function resetDesktopInstallationId(): void {
  pending = null;
}
