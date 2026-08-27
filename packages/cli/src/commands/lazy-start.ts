/**
 * `station [dir]` default command (station#1984, #1986, #1991).
 *
 * With no verb, `station` behaves like a launcher: it finds a running Station
 * through the merged instance registry, confirms it with a
 * `GET /api/system/instance` probe, mints a one-time local-bootstrap token, and
 * opens the browser at `<uiUrl>#station-ui-bootstrap=<token>` so the page pairs itself
 * silently. When nothing is running it offers to start one — inline, as a
 * background service, or against a throwaway temp home — skipping the prompt
 * when a flag already names the path, and staying deterministic (no prompt)
 * when there is no TTY.
 *
 * All I/O is injected so the decision logic is unit-testable without a live
 * Station, a browser, or a network.
 */
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  findRunning as defaultFindRunning,
  type InstanceConfig,
} from '@kontourai/station-shared/instance-registry';
import { resolveStationRuntimeContext } from '@kontourai/station-shared/runtime-path-resolver';
import { openBrowser as defaultOpenBrowser } from './open-browser.js';
import { promptSelect, type SelectOption } from './prompt.js';

export interface LazyStartOptions {
  /** Pass-through for `--allow-shared-home` (station#2904 2b): the lazy
   * "Start one?" flow routes into the same refusing start, so the override
   * must survive this hop or the refusal's own remediation is a lie on the
   * bare-`station` path. */
  allowSharedHome?: boolean;
  dir?: string;
  inline?: boolean;
  service?: boolean;
  tempHome?: boolean;
  serverPort?: number;
  uiPort?: number;
  /** Explicit consent-listener port (station#3677); default serverPort + 3. */
  consentPort?: number;
  /** Station home to resolve the registry and local-grant secret against. */
  home?: string;
}

export type NoInstanceChoice = 'inline' | 'service' | 'temp-home';

export interface LazyStartDeps {
  isInteractive: boolean;
  findRunning?: (home?: string) => InstanceConfig[];
  /** Confirms an instance answers `GET /api/system/instance` on its API port. */
  probe?: (serverPort: number) => Promise<boolean>;
  /** Best-effort mint of a one-time bootstrap token for the running instance. */
  mintToken?: (
    serverPort: number,
    home: string | undefined,
    deviceName: string,
  ) => Promise<string | null>;
  openBrowser?: (url: string) => Promise<boolean>;
  select?: (
    message: string,
    options: SelectOption<NoInstanceChoice>[],
  ) => Promise<NoInstanceChoice | null>;
  /** Runs the chosen start path when nothing is already running. */
  runners: {
    inline: (options: LazyStartOptions) => Promise<void>;
    service: (options: LazyStartOptions) => Promise<void>;
    tempHome: (options: LazyStartOptions) => Promise<void>;
  };
  log?: (message: string) => void;
  printUsage?: () => void;
}

const DEFAULT_UI_PORT = resolveStationRuntimeContext().uiPort;

function deviceName(): string {
  return `Station CLI (${hostname()})`;
}

/** Picks the first running instance that still answers its probe. */
async function resolveTarget(
  instances: InstanceConfig[],
  probe: (serverPort: number) => Promise<boolean>,
): Promise<InstanceConfig | null> {
  for (const instance of instances) {
    if (await probe(instance.port)) return instance;
  }
  return null;
}

async function openRunningInstance(
  target: InstanceConfig,
  options: LazyStartOptions,
  deps: Required<Pick<LazyStartDeps, 'openBrowser' | 'log'>> &
    Pick<LazyStartDeps, 'mintToken'>,
): Promise<void> {
  const uiPort = target.uiPort ?? DEFAULT_UI_PORT;
  const baseUrl = `http://localhost:${uiPort}`;
  // The default command's positional directory is a project selector, not a
  // Station-home override. Project IDs are the directory leaf in this launcher
  // contract; the runtime resolves that selector against its own project list.
  const project = options.dir ? basename(resolve(options.dir)) : undefined;
  // The visible URL keeps the (non-secret) project selector but never the token
  // fragment; only the browser-opened URL carries the one-time bootstrap token.
  const visibleUrl = `${baseUrl}${project ? `?project=${encodeURIComponent(project)}` : ''}`;
  let token: string | null = null;
  if (deps.mintToken) {
    try {
      token = await deps.mintToken(target.port, options.home, deviceName());
    } catch {
      token = null;
    }
  }
  const url = `${visibleUrl}${token ? `#station-ui-bootstrap=${token}` : ''}`;
  const opened = await deps.openBrowser(url);
  // Never log the token — only the bare address plus the project selector.
  if (opened) {
    deps.log(`Opened Station at ${visibleUrl}`);
  } else {
    deps.log(
      `Could not open Station automatically. Open ${visibleUrl} manually.`,
    );
  }
}

/**
 * The default-command entry point. Resolves a running Station and opens it, or
 * routes a not-running invocation to inline / service / temp-home per flags,
 * prompt, or the deterministic non-TTY fallback.
 */
export async function runLazyStart(
  options: LazyStartOptions,
  deps: LazyStartDeps,
): Promise<void> {
  const findRunning = deps.findRunning ?? defaultFindRunning;
  const probe = deps.probe ?? (async () => true);
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const select = deps.select ?? promptSelect;
  const log = deps.log ?? ((message: string) => console.log(message));

  const running = findRunning(options.home);
  const target = await resolveTarget(running, probe);
  if (target) {
    await openRunningInstance(target, options, {
      openBrowser,
      log,
      ...(deps.mintToken ? { mintToken: deps.mintToken } : {}),
    });
    return;
  }

  // Nothing is running: a flag names the path outright.
  if (options.inline) return deps.runners.inline(options);
  if (options.service) return deps.runners.service(options);
  if (options.tempHome) return deps.runners.tempHome(options);

  if (deps.isInteractive) {
    const choice = await select('No Station is running here. Start one?', [
      { value: 'inline', label: 'Start inline (this terminal)' },
      { value: 'service', label: 'Install and start a background service' },
      { value: 'temp-home', label: 'Start against a throwaway temp home' },
    ]);
    if (choice === 'inline') return deps.runners.inline(options);
    if (choice === 'service') return deps.runners.service(options);
    if (choice === 'temp-home')
      return deps.runners.tempHome({ ...options, tempHome: true });
    return; // cancelled
  }

  // Non-TTY with no instance and no flag: deterministic, no prompt.
  if (deps.printUsage) deps.printUsage();
}
