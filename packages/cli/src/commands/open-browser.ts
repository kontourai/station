/**
 * A tiny cross-platform "open this URL in the default browser" helper.
 *
 * Station has no `open` npm dependency and does not want one (the published CLI
 * bundle carries only the audited keyring — see
 * `packages/cli/src/__tests__/bundle.test.ts`), so the launcher is a direct
 * `spawn` of the platform's own opener: `open` on macOS, `cmd /c start` on
 * Windows, `xdg-open` elsewhere. The child is detached and `unref`'d so a bare
 * `station` that opens the browser and exits does not wait on it.
 *
 * `windowsHide: true` on every spawn (repo rule) keeps a console window from
 * flashing on Windows. The opener never throws: a machine with no GUI opener
 * available should degrade to "here is the URL, open it yourself", which is the
 * caller's job — so this reports success/failure rather than crashing the CLI.
 */
import { type SpawnOptions, spawn } from 'node:child_process';

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
}

function openerCommand(platform: NodeJS.Platform): {
  command: string;
  args: (url: string) => string[];
} {
  if (platform === 'darwin') {
    return { command: 'open', args: (url) => [url] };
  }
  if (platform === 'win32') {
    // `start` is a `cmd` builtin, not an executable. The empty-string first
    // argument is `start`'s window-title slot: without it, a URL wrapped in
    // quotes would be swallowed as the title and no page would open.
    return { command: 'cmd', args: (url) => ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: (url) => [url] };
}

/**
 * Opens `url` in the default browser. Resolves `true` when the child process
 * was launched, `false` when the platform opener could not be spawned (no GUI,
 * missing `xdg-open`, …). It intentionally does not wait for the browser to
 * finish — only for the launch to succeed or fail.
 */
export function openBrowser(
  url: string,
  deps: OpenBrowserDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const { command, args } = openerCommand(platform);
  const options: SpawnOptions = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawnFn(command, args(url), options);
      child.once('error', () => settle(false));
      // A successful `spawn` emits no synchronous signal, so treat "no error on
      // the next tick" as launched, then let the child run on its own.
      child.once('spawn', () => {
        child.unref();
        settle(true);
      });
      // Older Node child objects may not emit 'spawn'; fall back to unref+true
      // on nextTick if neither event has fired.
      process.nextTick(() => {
        if (!settled) {
          child.unref();
          settle(true);
        }
      });
    } catch {
      settle(false);
    }
  });
}
