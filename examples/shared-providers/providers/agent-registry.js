/**
 * Agent Registry Provider — lists agent packages from a CLI tool.
 */
import { execSync } from 'node:child_process';
export default function createAgentRegistryProvider() {
  let cliPath;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    cliPath = execSync(`${which} agent-manager`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return {
      listAvailable: async () => [],
      listInstalled: async () => [],
      install: async () => ({
        success: false,
        message: 'agent-manager CLI not found',
      }),
      uninstall: async () => ({
        success: false,
        message: 'agent-manager CLI not found',
      }),
    };
  }
  function listAgentPackages() {
    try {
      const output = execSync(`${cliPath} agents list`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const items = [];
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
    listAvailable: async () => listAgentPackages(),
    listInstalled: async () => listAgentPackages(),
    install: async () => ({
      success: false,
      message: 'Agent install is managed by agent-manager CLI',
    }),
    uninstall: async () => ({
      success: false,
      message: 'Agent uninstall is managed by agent-manager CLI',
    }),
  };
}
