/**
 * Agent Registry Provider — lists agent packages from a CLI tool.
 */

import { execSync } from 'node:child_process';
import type { InstallResult, RegistryItem } from '@kontourai/station-shared';

export default function createAgentRegistryProvider() {
  let cliPath: string;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    cliPath = execSync(`${which} agent-manager`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return {
      listAvailable: async (): Promise<RegistryItem[]> => [],
      listInstalled: async (): Promise<RegistryItem[]> => [],
      install: async (): Promise<InstallResult> => ({
        success: false,
        message: 'agent-manager CLI not found',
      }),
      uninstall: async (): Promise<InstallResult> => ({
        success: false,
        message: 'agent-manager CLI not found',
      }),
    };
  }

  function listAgentPackages(): RegistryItem[] {
    try {
      const output = execSync(`${cliPath} agents list`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const items: RegistryItem[] = [];
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\S+)\s+\[(\w+)\]/);
        if (match) {
          items.push({
            id: match[1],
            displayName: match[1],
            installed: true,
            status: match[2].toLowerCase(),
          });
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  return {
    listAvailable: async (): Promise<RegistryItem[]> => listAgentPackages(),
    listInstalled: async (): Promise<RegistryItem[]> => listAgentPackages(),
    install: async (): Promise<InstallResult> => ({
      success: false,
      message: 'Agent install is managed by agent-manager CLI',
    }),
    uninstall: async (): Promise<InstallResult> => ({
      success: false,
      message: 'Agent uninstall is managed by agent-manager CLI',
    }),
  };
}
