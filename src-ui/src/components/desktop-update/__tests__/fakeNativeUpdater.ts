import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DESKTOP_UPDATE_STATE_EVENT,
  type DesktopUpdateState,
} from '@kontourai/station-contracts/desktop-update';
import type { Mock } from 'vitest';

/**
 * Native-writer fixtures: `src-desktop/src/desktop_update.rs` tests assert
 * that its real transitions serialize to exactly these values, so the UI is
 * tested against the shape the native side actually emits.
 */
export type DesktopUpdateFixtureName =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'checkFailed'
  | 'available'
  | 'downloading'
  | 'downloadFailed'
  | 'ready'
  | 'installing'
  | 'installFailed';

const fixtures = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      'src-desktop/src/fixtures/desktop-update-states.json',
    ),
    'utf8',
  ),
) as Record<DesktopUpdateFixtureName, DesktopUpdateState>;

export function desktopUpdateFixture(
  name: DesktopUpdateFixtureName,
): DesktopUpdateState {
  return structuredClone(fixtures[name]);
}

export interface NativeMocks {
  invoke: Mock;
  listen: Mock;
}

/**
 * Answers the `@tauri-apps/api` seam the way the native updater does: the
 * state command returns the current state, and `emit` delivers a state
 * event to every listener. Other update commands resolve (or use
 * `commandResults`) and are recorded on `invoke`.
 */
export function installFakeNativeUpdater(
  native: NativeMocks,
  initial: DesktopUpdateState,
  commandResults: Partial<Record<string, () => Promise<unknown>>> = {},
) {
  let current = initial;
  const handlers = new Set<
    (message: { payload: DesktopUpdateState }) => void
  >();
  native.listen.mockImplementation(
    async (
      event: string,
      handler: (message: { payload: DesktopUpdateState }) => void,
    ) => {
      if (event !== DESKTOP_UPDATE_STATE_EVENT) {
        throw new Error(`unexpected native event ${event}`);
      }
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'desktop_update_state') return current;
    const result = commandResults[command];
    if (result) return result();
    if (command.startsWith('desktop_update_')) return current;
    throw new Error(`unexpected native command ${command}`);
  });
  let sequence = initial.sequence;
  const deliver = (state: DesktopUpdateState) => {
    current = state;
    for (const handler of handlers) handler({ payload: state });
  };
  return {
    /** Emits `state` as the native side would: with the next sequence. */
    emit(state: DesktopUpdateState) {
      sequence += 1;
      deliver({ ...state, sequence });
    },
    /** Emits `state` with its own sequence, e.g. a stale or reordered one. */
    emitAsIs: deliver,
    commands(): string[] {
      return native.invoke.mock.calls
        .map(([command]) => command as string)
        .filter((command) => command !== 'desktop_update_state');
    },
    listenerCount: () => handlers.size,
  };
}
