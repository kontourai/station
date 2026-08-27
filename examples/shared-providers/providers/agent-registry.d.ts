/**
 * Agent Registry Provider — lists agent packages from a CLI tool.
 */
import type { InstallResult, RegistryItem } from '@kontourai/station-shared';
export default function createAgentRegistryProvider(): {
  listAvailable: () => Promise<RegistryItem[]>;
  listInstalled: () => Promise<RegistryItem[]>;
  install: () => Promise<InstallResult>;
  uninstall: () => Promise<InstallResult>;
};
