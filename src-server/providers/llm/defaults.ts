/**
 * Default provider implementations — no external dependencies
 */

import { homedir, userInfo as osUserInfo } from 'node:os';
import type { ACPConnectionRegistryEntry } from '@kontourai/station-contracts/acp';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  createBuiltinVendedToolDef,
  listBuiltinVendedRegistryItems,
} from '../../runtime/tools/vended-tool-compat.js';
import { findCliBinary } from '../auth/cli-auth.js';
import type {
  AuthStatus,
  InstallResult,
  RegistryItem,
  RenewResult,
  UserDetailVM,
  UserIdentity,
} from '../provider-contracts.js';
import type {
  IACPConnectionRegistryProvider,
  IAgentRegistryProvider,
  IAuthProvider,
  IBrandingProvider,
  IIntegrationRegistryProvider,
  IUserDirectoryProvider,
  IUserIdentityProvider,
} from '../provider-interfaces.js';
import { BUILTIN_ACP_ENGINES } from './builtin-acp-engines.js';

// ── Package Registry Defaults ──────────────────────────

const NO_REGISTRY: InstallResult = {
  success: false,
  message: 'No registry provider configured',
};

const MCP_FILESYSTEM_ID = 'filesystem';
const MCP_FILESYSTEM_SOURCE = 'modelcontextprotocol/servers';
const MCP_FILESYSTEM_PACKAGE = '@modelcontextprotocol/server-filesystem';
export class DefaultAgentRegistryProvider implements IAgentRegistryProvider {
  async listAvailable(): Promise<RegistryItem[]> {
    return [];
  }
  async listInstalled(): Promise<RegistryItem[]> {
    return [];
  }
  async install(): Promise<InstallResult> {
    return NO_REGISTRY;
  }
  async uninstall(): Promise<InstallResult> {
    return NO_REGISTRY;
  }
}

export class BuiltinIntegrationRegistryProvider
  implements IIntegrationRegistryProvider
{
  readonly registryKey = 'station-integrations';
  readonly displayName = 'Station catalog';
  async listAvailable(): Promise<RegistryItem[]> {
    return [
      {
        id: MCP_FILESYSTEM_ID,
        displayName: 'Filesystem (MCP)',
        description:
          'Official MCP filesystem server. Installs a stdio tool server rooted at your home directory so users can start immediately and narrow the path later if needed.',
        version: 'latest',
        source: MCP_FILESYSTEM_SOURCE,
        installed: false,
        tags: ['mcp', 'filesystem'],
      },
      ...listBuiltinVendedRegistryItems(),
    ];
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return [];
  }

  async install(id: string): Promise<InstallResult> {
    if (id === MCP_FILESYSTEM_ID) {
      return {
        success: true,
        message: 'Filesystem MCP server is available for install',
      };
    }

    if (createBuiltinVendedToolDef(id)) {
      return {
        success: true,
        message: `Built-in integration '${id}' is available for install`,
      };
    }

    return {
      success: false,
      message: `Built-in integration '${id}' not found`,
    };
  }

  async uninstall(id: string): Promise<InstallResult> {
    if (id === MCP_FILESYSTEM_ID || createBuiltinVendedToolDef(id)) {
      return {
        success: true,
        message: `Integration '${id}' removed`,
      };
    }

    return {
      success: false,
      message: `Built-in integration '${id}' not found`,
    };
  }

  async getToolDef(id: string): Promise<ToolDef | null> {
    if (id !== MCP_FILESYSTEM_ID) {
      return createBuiltinVendedToolDef(id);
    }

    const allowedPath = homedir();
    return {
      id: MCP_FILESYSTEM_ID,
      kind: 'mcp',
      displayName: 'Filesystem',
      description:
        'Official MCP filesystem server. Installed by default with access rooted at your home directory.',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', MCP_FILESYSTEM_PACKAGE, allowedPath],
      permissions: {
        filesystem: true,
        allowedPaths: [allowedPath],
      },
      timeouts: {
        startupMs: 15_000,
        requestMs: 60_000,
      },
    };
  }

  async sync(): Promise<void> {}
}

export class BuiltinACPConnectionRegistryProvider
  implements IACPConnectionRegistryProvider
{
  readonly id = 'builtin-acp-connections';
  readonly displayName = 'Built-in ACP Connections';

  constructor(
    private readonly commandExists: (command: string) => boolean = (command) =>
      findCliBinary(command) !== null,
    private readonly discoveryDisabled: () => boolean = () =>
      process.env.STATION_E2E_FIRST_RUN === '1',
  ) {}

  listAvailable(
    options: { detect?: boolean } = {},
  ): ACPConnectionRegistryEntry[] {
    const entries = BUILTIN_ACP_ENGINES.map(
      (entry): ACPConnectionRegistryEntry => structuredClone(entry),
    );
    if (options.detect === false) return entries;
    const discoveryDisabled = this.discoveryDisabled();
    return entries.map((entry) => ({
      ...entry,
      detected: !discoveryDisabled && this.commandExists(entry.command),
    }));
  }
}

// ── Auth / Identity / Directory Defaults ───────────────

export class DefaultAuthProvider implements IAuthProvider {
  async getStatus(): Promise<AuthStatus> {
    return {
      provider: 'none',
      status: 'not-configured',
      expiresAt: null,
      message: 'No auth provider configured',
    };
  }
  async renew(): Promise<RenewResult> {
    return { success: false, message: 'No auth provider configured' };
  }
}

export class DefaultUserIdentityProvider implements IUserIdentityProvider {
  async getIdentity(): Promise<UserIdentity> {
    const alias = osUserInfo().username;
    return { alias };
  }
}

export class DefaultUserDirectoryProvider implements IUserDirectoryProvider {
  async lookupPerson(alias: string): Promise<UserDetailVM> {
    return { alias, name: alias };
  }
  async searchPeople(_query: string): Promise<UserDetailVM[]> {
    return [];
  }
}

// ── Branding Default ───────────────────────────────────

export class DefaultBrandingProvider implements IBrandingProvider {
  async getAppName(): Promise<string> {
    return 'Station';
  }
  async getLogo() {
    return null;
  }
  async getTheme() {
    return null;
  }
  async getWelcomeMessage() {
    return null;
  }
}
