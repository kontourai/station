import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH } from '@kontourai/station-contracts/environment-security';
import {
  entryOwnedByLiveProcess,
  readInstanceRegistry,
} from '@kontourai/station-shared/instance-registry';
import { admitStationRuntimeHome } from '@kontourai/station-shared/runtime-path-resolver';
import { parseCoreArgs } from './core-api.js';
import { PROJECT_HOME } from './helpers.js';
import { openBrowser } from './open-browser.js';

/** Shared by the launcher and explicit packaged-client browser open. */
export async function mintLocalBrowserToken(
  serverPort: number,
  home: string | undefined,
  deviceName: string,
): Promise<string | null> {
  try {
    const root = admitStationRuntimeHome(home ?? PROJECT_HOME);
    const secret = readFileSync(
      join(root, 'runtime', 'local-grant.secret'),
      'utf8',
    ).trim();
    if (secret.length < 20 || secret.length > 100) return null;
    const response = await fetch(
      `http://127.0.0.1:${serverPort}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, deviceName }),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(body.token)
      ? body.token
      : null;
  } catch {
    return null;
  }
}

export async function runOpenCommand(
  args: string[],
  dependencies: {
    readRegistry?: typeof readInstanceRegistry;
    isLive?: typeof entryOwnedByLiveProcess;
    mintToken?: typeof mintLocalBrowserToken;
    open?: typeof openBrowser;
    stdout?: (line: string) => void;
  } = {},
): Promise<void> {
  const parsed = parseCoreArgs(args);
  if (
    parsed.positionals.length ||
    Object.keys(parsed.flags).some(
      (key) => !['home', 'instance'].includes(key),
    ) ||
    Object.values(parsed.flags).some((value) => typeof value !== 'string')
  ) {
    throw new Error(
      'Usage: station open [--home=<directory>] [--instance=<name>]',
    );
  }
  const home = admitStationRuntimeHome(
    typeof parsed.flags.home === 'string' ? parsed.flags.home : PROJECT_HOME,
  );
  const registry = (dependencies.readRegistry ?? readInstanceRegistry)(home);
  const matches = Object.entries(registry.instances).filter(
    ([id, entry]) =>
      (!parsed.flags.instance || id === parsed.flags.instance) &&
      entry.status !== 'stopped' &&
      (dependencies.isLive ?? entryOwnedByLiveProcess)(entry),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'More than one Station is running. Choose --instance=<name>.'
        : 'No running Station was found in this home. Open the installed Station app or specify --home.',
    );
  const [id, target] = matches[0];
  if (!target.uiPort)
    throw new Error(
      'This Station has no recorded browser address. Open it through its owning app.',
    );
  const token = await (dependencies.mintToken ?? mintLocalBrowserToken)(
    target.port,
    home,
    `Station CLI (${hostname()})`,
  );
  if (!token)
    throw new Error(
      'This Station could not authorize the browser. Verify that the selected home belongs to the running instance.',
    );
  const visibleUrl = `http://localhost:${target.uiPort}/`;
  if (
    !(await (dependencies.open ?? openBrowser)(
      `${visibleUrl}#station-ui-bootstrap=${token}`,
    ))
  ) {
    throw new Error(
      'Could not launch the browser. Open Station from its tray menu.',
    );
  }
  (dependencies.stdout ?? console.log)(`Opened Station ${id} at ${visibleUrl}`);
}
