import type { AppConfig } from '@kontourai/station-contracts/config';

export type LaunchabilityRevisionListener = (revision: number) => void;

export interface AppConfigLaunchabilitySnapshot {
  revision: number;
  config: AppConfig;
}

export interface LaunchabilityRevisionSource {
  getLaunchabilityRevision(): number;
  onLaunchabilityChange(listener: LaunchabilityRevisionListener): () => void;
}

export interface AppConfigLaunchabilitySource
  extends LaunchabilityRevisionSource {
  captureAppConfigLaunchabilitySnapshot(): Promise<AppConfigLaunchabilitySnapshot>;
}

export class LaunchabilityRevision implements LaunchabilityRevisionSource {
  private revision = 0;
  private readonly listeners = new Set<LaunchabilityRevisionListener>();

  getLaunchabilityRevision(): number {
    return this.revision;
  }

  onLaunchabilityChange(listener: LaunchabilityRevisionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(): number {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch {
        console.debug('Launchability revision listener failed.');
      }
    }
    return this.revision;
  }
}
