import { existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  POLL_ENTRY_BUDGET,
  POLL_INTERVAL_MS,
  type WatchHandle,
  type WatchStatus,
  watchWithFallback,
} from '@kontourai/station-shared/source-watch';

export { POLL_ENTRY_BUDGET, POLL_INTERVAL_MS };
export type { WatchHandle, WatchStatus };

interface WatchSourceChangesContext {
  cwd: string;
  onRebuild: (filename: string) => Promise<void>;
  /** Scan interval override; the seam tests use to avoid real-time waits. */
  pollIntervalMs?: number;
}

interface WatchConfigChangesContext {
  cwd: string;
  manifest: PluginManifest;
  layoutPath: string | null;
  onReload: (label: string) => void;
  /** Scan interval override; the seam tests use to avoid real-time waits. */
  pollIntervalMs?: number;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css'];

export function watchSourceChanges({
  cwd,
  onRebuild,
  pollIntervalMs,
}: WatchSourceChangesContext): WatchHandle {
  const srcDir = join(cwd, 'src');
  const paths = existsSync(srcDir) ? [srcDir] : [];
  return watchWithFallback({
    cwd,
    paths,
    targets: paths.length > 0 ? ['src/'] : [],
    accepts: (relativePath) =>
      SOURCE_EXTENSIONS.includes(extname(relativePath)),
    onChange: (label) => {
      void onRebuild(label);
    },
    pollIntervalMs,
  });
}

export function getConfigWatchTargets(
  cwd: string,
  manifest: PluginManifest,
  layoutPath: string | null,
) {
  const configDirs: string[] = [];
  if (layoutPath) {
    configDirs.push(layoutPath);
  }
  if (manifest.prompts?.source) {
    const promptsDir = join(cwd, manifest.prompts.source);
    if (existsSync(promptsDir)) {
      configDirs.push(promptsDir);
    }
  }
  for (const agent of manifest.agents || []) {
    const agentPath = join(cwd, agent.source);
    if (existsSync(agentPath)) {
      configDirs.push(agentPath);
    }
  }
  return configDirs;
}

export function watchConfigChanges({
  cwd,
  manifest,
  layoutPath,
  onReload,
  pollIntervalMs,
}: WatchConfigChangesContext): WatchHandle {
  const configDirs = getConfigWatchTargets(cwd, manifest, layoutPath);
  return watchWithFallback({
    cwd,
    paths: configDirs,
    targets: configDirs.map((dir) => relative(cwd, dir)),
    onChange: onReload,
    pollIntervalMs,
  });
}

/**
 * The watch lines the dev server prints, or `[]` when there is nothing to say.
 *
 * These state the mechanism actually in use rather than asserting that watching
 * works. A status line claiming a capability nobody verified is the defect this
 * exists to avoid (#970).
 */
export function describeWatchStatus(handles: WatchHandle[]): string[] {
  const covered = handles.filter((handle) => handle.targets.length > 0);
  const targets = covered.flatMap((handle) => handle.targets);
  if (targets.length === 0) return [];

  const statuses = covered.map((handle) => handle.status());
  const nativeArmed = statuses.every((status) => status.nativeArmed);
  const pollingActive = statuses.every((status) => status.pollingActive);
  const list = targets.join(', ');
  const seconds = Math.max(...covered.map((h) => h.pollIntervalMs)) / 1000;
  const nativeReason =
    statuses.find((status) => status.nativeError)?.nativeError ||
    'reason unavailable';
  const pollingReason =
    statuses.find((status) => status.pollingError)?.pollingError ||
    'reason unavailable';

  if (!nativeArmed && !pollingActive) {
    return [
      `   Not watching ${list} — file watching is unavailable (${nativeReason}).`,
      '   Edits will not rebuild; restart the dev server to pick them up.',
    ];
  }
  if (!nativeArmed) {
    return [
      `   Watching: ${list} (polling every ${seconds}s — native file watching is unavailable: ${nativeReason})`,
    ];
  }
  // Armed is not the same as delivering. Once the scan is demonstrably the only
  // thing carrying changes, stop crediting the native path.
  const nativeDelivered = statuses.some((status) => status.nativeDelivered);
  const pollingDelivered = statuses.some((status) => status.pollingDelivered);
  if (pollingDelivered && !nativeDelivered) {
    return [
      `   Watching: ${list} (polling every ${seconds}s — no native file events have arrived)`,
    ];
  }
  if (!pollingActive) {
    return [
      `   Watching: ${list} (native file events; polling fallback off — ${pollingReason})`,
    ];
  }
  return [
    `   Watching: ${list} (native file events, ${seconds}s polling fallback)`,
  ];
}

/**
 * Said once, the first time a change arrives via the fallback instead of via
 * native events. Without it the operator sees only that rebuilds feel slow, and
 * never learns their OS watch layer went quiet.
 */
export function fallbackNotice(handles: WatchHandle[]): string | null {
  const fallbackHandles = handles.filter((handle) => {
    const status = handle.status();
    return status.pollingDelivered && !status.nativeDelivered;
  });
  if (fallbackHandles.length === 0) return null;
  const seconds =
    Math.max(...fallbackHandles.map((handle) => handle.pollIntervalMs)) / 1000;
  return `   ⚠ No native file events have arrived — changes are being picked up by the ${seconds}s polling fallback.`;
}
