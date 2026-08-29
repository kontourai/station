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

// ── Package Registry Defaults ──────────────────────────

const NO_REGISTRY: InstallResult = {
  success: false,
  message: 'No registry provider configured',
};

const MCP_FILESYSTEM_ID = 'filesystem';
const MCP_FILESYSTEM_SOURCE = 'modelcontextprotocol/servers';
const MCP_FILESYSTEM_PACKAGE = '@modelcontextprotocol/server-filesystem';
const KIRO_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'kiro',
  name: 'Kiro CLI',
  description: 'Connect the Kiro CLI installed on this machine as an engine.',
  command: 'kiro-cli',
  args: ['acp'],
  icon: 'brand:kiro',
  tags: ['acp', 'kiro'],
};

const CURSOR_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'cursor',
  name: 'Cursor',
  description:
    'Connect the Cursor agent CLI installed on this machine as an engine.',
  command: 'cursor-agent',
  args: ['acp'],
  icon: 'C',
  tags: ['acp', 'cursor'],
};

const OPENCODE_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'opencode',
  name: 'OpenCode',
  description:
    'Connect the OpenCode CLI installed on this machine as an engine.',
  command: 'opencode',
  args: ['acp'],
  icon: 'brand:opencode',
  tags: ['acp', 'opencode'],
};

const GOOSE_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'goose',
  name: 'Goose',
  description: 'Connect the Goose CLI installed on this machine as an engine.',
  command: 'goose',
  args: ['acp'],
  icon: 'G',
  tags: ['acp', 'goose'],
};

const QWEN_CODE_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'qwen-code',
  name: 'Qwen Code',
  description:
    'Connect the Qwen Code CLI installed on this machine as an engine.',
  command: 'qwen',
  args: ['--acp'],
  icon: 'Q',
  tags: ['acp', 'qwen'],
};

const COPILOT_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'copilot',
  name: 'GitHub Copilot',
  description:
    'Connect the GitHub Copilot CLI installed on this machine as an engine.',
  command: 'copilot',
  args: ['--acp'],
  icon: 'GH',
  tags: ['acp', 'copilot'],
};

const GROK_BUILD_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'grok-build',
  name: 'Grok Build',
  description:
    'Connect the Grok Build CLI installed on this machine as an engine.',
  command: 'grok',
  args: ['agent', 'stdio'],
  icon: 'GK',
  tags: ['acp', 'grok'],
};

const MISTRAL_VIBE_ACP_CONNECTION: ACPConnectionRegistryEntry = {
  id: 'mistral-vibe',
  name: 'Mistral Vibe',
  description:
    'Connect the Mistral Vibe CLI installed on this machine as an engine.',
  command: 'vibe-acp',
  args: [],
  icon: 'MV',
  tags: ['acp', 'mistral'],
};

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

  listAvailable(): ACPConnectionRegistryEntry[] {
    const entries = [
      { ...KIRO_ACP_CONNECTION },
      { ...CURSOR_ACP_CONNECTION },
      { ...OPENCODE_ACP_CONNECTION },
      { ...GOOSE_ACP_CONNECTION },
      { ...QWEN_CODE_ACP_CONNECTION },
      { ...COPILOT_ACP_CONNECTION },
      { ...GROK_BUILD_ACP_CONNECTION },
      { ...MISTRAL_VIBE_ACP_CONNECTION },
    ];
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
