/**
 * NPM Integration Registry Provider — discovers and installs MCP servers.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
  ToolDef,
} from '@kontourai/station-shared';

export default function createNpmRegistryProvider() {
  const home = process.env.HOME || '~';
  const projectHomeDir = process.env.STATION_HOME || join(home, '.station');
  const toolsDir = join(projectHomeDir, 'tools');

  const provider = {
    async listAvailable(): Promise<RegistryItem[]> {
      // In production: query your internal registry API or CLI
      return [];
    },

    async listInstalled(): Promise<RegistryItem[]> {
      if (!existsSync(toolsDir)) return [];
      const items: RegistryItem[] = [];
      for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = join(toolsDir, entry.name, 'tool.json');
        if (!existsSync(p)) continue;
        try {
          const def = JSON.parse(readFileSync(p, 'utf-8'));
          items.push({
            id: entry.name,
            displayName: def.displayName || entry.name,
            description: def.description || '',
            installed: true,
            status: 'configured',
          });
        } catch {}
      }
      return items;
    },

    async install(id: string): Promise<InstallResult> {
      try {
        execSync(`npm install -g ${id}`, {
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const toolDir = join(toolsDir, id);
        mkdirSync(toolDir, { recursive: true });
        const toolDef: ToolDef = {
          id,
          kind: 'mcp',
          displayName: id,
          description: `NPM-managed MCP server: ${id}`,
          transport: 'stdio',
          command: id,
        };
        writeFileSync(
          join(toolDir, 'tool.json'),
          JSON.stringify(toolDef, null, 2),
        );
        return { success: true, message: `Installed and configured ${id}` };
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    },

    async uninstall(id: string): Promise<InstallResult> {
      try {
        const toolDir = join(toolsDir, id);
        if (existsSync(toolDir)) rmSync(toolDir, { recursive: true });
        return { success: true, message: `Removed ${id}` };
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    },

    async getToolDef(id: string): Promise<ToolDef | null> {
      const p = join(toolsDir, id, 'tool.json');
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return null;
      }
    },

    async sync(): Promise<void> {},
  };
  return provider;
}
