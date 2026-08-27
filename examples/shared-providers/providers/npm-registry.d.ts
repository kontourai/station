/**
 * NPM Integration Registry Provider — discovers and installs MCP servers.
 */
import type {
  InstallResult,
  RegistryItem,
  ToolDef,
} from '@kontourai/station-shared';
export default function createNpmRegistryProvider(): {
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(id: string): Promise<InstallResult>;
  uninstall(id: string): Promise<InstallResult>;
  getToolDef(id: string): Promise<ToolDef | null>;
  sync(): Promise<void>;
};
