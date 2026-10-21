/**
 * Built-in engine catalogue: the local-command engines Station knows how to
 * launch, with what onboarding needs to install and describe each one.
 * Install recipes are copied from each vendor's own install docs; Station
 * shows them and never runs them. Windows commands are PowerShell.
 */

import type { ACPConnectionRegistryEntry } from '@kontourai/station-contracts/acp';

type BuiltinEngine = Omit<
  ACPConnectionRegistryEntry,
  'detected' | 'installed' | 'installedSource' | 'source' | 'hostInstall'
>;

const POWERSHELL = 'Run in PowerShell.';

export const BUILTIN_ACP_ENGINES: readonly BuiltinEngine[] = [
  {
    id: 'kiro',
    name: 'Kiro CLI',
    description: "Kiro's coding agent, run from its kiro-cli command.",
    command: 'kiro-cli',
    args: ['acp'],
    icon: 'brand:kiro',
    tags: ['acp', 'kiro'],
    homepageUrl: 'https://kiro.dev/docs/cli/',
    install: {
      darwin: {
        command: 'curl -fsSL https://cli.kiro.dev/install | bash',
        docsUrl: 'https://kiro.dev/docs/getting-started/installation/',
      },
      linux: {
        command: 'curl -fsSL https://cli.kiro.dev/install | bash',
        docsUrl: 'https://kiro.dev/docs/getting-started/installation/',
      },
      win32: {
        command: "irm 'https://cli.kiro.dev/install.ps1' | iex",
        docsUrl: 'https://kiro.dev/docs/getting-started/installation/',
        note: POWERSHELL,
      },
    },
    auth: {
      statusCommand: ['kiro-cli', 'whoami', '--format', 'json'],
      signInHint: 'Run kiro-cli login on the computer Station runs on.',
      credentialEnvVars: ['KIRO_API_KEY'],
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: "Cursor's coding agent, run from its cursor-agent command.",
    // The installer also links a bare `agent`, which other CLIs claim too
    // (xAI's grok installs one), so detection and launch use only this name.
    command: 'cursor-agent',
    args: ['acp'],
    icon: 'C',
    tags: ['acp', 'cursor'],
    homepageUrl: 'https://cursor.com/docs/cli/acp',
    install: {
      darwin: {
        command: 'curl https://cursor.com/install -fsS | bash',
        docsUrl: 'https://cursor.com/docs/cli/installation',
      },
      linux: {
        command: 'curl https://cursor.com/install -fsS | bash',
        docsUrl: 'https://cursor.com/docs/cli/installation',
      },
      win32: {
        command: "irm 'https://cursor.com/install?win32=true' | iex",
        docsUrl: 'https://cursor.com/docs/cli/installation',
        note: POWERSHELL,
      },
    },
    auth: {
      statusCommand: ['cursor-agent', 'status'],
      signInHint:
        'Run cursor-agent login on the computer Station runs on, or provide a Cursor API key.',
      credentialEnvVars: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'The open-source OpenCode coding agent.',
    command: 'opencode',
    args: ['acp'],
    icon: 'brand:opencode',
    tags: ['acp', 'opencode'],
    homepageUrl: 'https://opencode.ai/docs/',
    install: {
      darwin: {
        command: 'curl -fsSL https://opencode.ai/install | bash',
        docsUrl: 'https://opencode.ai/docs/',
      },
      linux: {
        command: 'curl -fsSL https://opencode.ai/install | bash',
        docsUrl: 'https://opencode.ai/docs/',
      },
      win32: {
        command: 'npm i -g opencode-ai',
        docsUrl: 'https://opencode.ai/docs/',
      },
    },
    auth: {
      statusCommand: ['opencode', 'auth', 'list'],
      signInHint:
        'Run opencode auth login on the computer Station runs on to add a model provider.',
    },
  },
  {
    id: 'goose',
    name: 'Goose',
    description: 'The open-source Goose agent.',
    command: 'goose',
    args: ['acp'],
    icon: 'G',
    tags: ['acp', 'goose'],
    homepageUrl: 'https://goose-docs.ai/',
    // Goose's keyring lookup can block indefinitely behind a hidden macOS
    // Keychain prompt when nothing is attached to a terminal.
    launchEnv: { GOOSE_DISABLE_KEYRING: '1' },
    install: {
      darwin: {
        command: 'brew install block-goose-cli',
        docsUrl: 'https://goose-docs.ai/docs/getting-started/installation',
      },
      linux: {
        command:
          'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
        docsUrl: 'https://goose-docs.ai/docs/getting-started/installation',
      },
      win32: {
        docsUrl: 'https://goose-docs.ai/docs/getting-started/installation',
        note: 'Download and run the Windows install script from the guide.',
      },
    },
    auth: {
      statusCommand: ['goose', 'info', '-v'],
      signInHint:
        'Run goose configure on the computer Station runs on to choose a model provider.',
    },
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    description: "Alibaba's Qwen Code coding agent.",
    command: 'qwen',
    args: ['--acp'],
    icon: 'Q',
    tags: ['acp', 'qwen'],
    homepageUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
    install: {
      darwin: {
        command: 'brew install qwen-code',
        docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
      },
      linux: {
        command: 'npm i -g @qwen-code/qwen-code',
        docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
        note: 'Needs Node.js 22 or later.',
      },
      win32: {
        command: 'npm i -g @qwen-code/qwen-code',
        docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
        note: 'Needs Node.js 22 or later.',
      },
    },
    auth: {
      signInHint:
        'Start qwen in a terminal and run /auth, or set a provider API key.',
      credentialEnvVars: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description: "GitHub's Copilot coding agent CLI.",
    command: 'copilot',
    args: ['--acp'],
    icon: 'GH',
    tags: ['acp', 'copilot'],
    homepageUrl: 'https://github.com/features/copilot/cli/',
    install: {
      darwin: {
        command: 'brew install copilot-cli',
        docsUrl:
          'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      },
      linux: {
        command: 'curl -fsSL https://gh.io/copilot-install | bash',
        docsUrl:
          'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      },
      win32: {
        command: 'winget install GitHub.Copilot',
        docsUrl:
          'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      },
    },
    auth: {
      signInHint:
        'Run copilot login on the computer Station runs on, or provide a GitHub token.',
      credentialEnvVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    },
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    description: "xAI's Grok Build coding agent CLI.",
    command: 'grok',
    args: ['agent', 'stdio'],
    icon: 'GK',
    tags: ['acp', 'grok'],
    homepageUrl: 'https://docs.x.ai/build/cli/headless-scripting',
    install: {
      darwin: {
        command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
        docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
      },
      linux: {
        command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
        docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
      },
      win32: {
        command: 'irm https://x.ai/cli/install.ps1 | iex',
        docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
        note: POWERSHELL,
      },
    },
    auth: {
      signInHint:
        'Run grok login on the computer Station runs on, or provide an xAI API key.',
      credentialEnvVars: ['XAI_API_KEY'],
    },
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description: "Mistral's open-source Vibe coding agent.",
    command: 'vibe-acp',
    args: [],
    icon: 'MV',
    tags: ['acp', 'mistral'],
    homepageUrl: 'https://github.com/mistralai/mistral-vibe',
    install: {
      darwin: {
        command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
        docsUrl: 'https://github.com/mistralai/mistral-vibe',
      },
      linux: {
        command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
        docsUrl: 'https://github.com/mistralai/mistral-vibe',
      },
      win32: {
        command: 'uv tool install mistral-vibe',
        docsUrl: 'https://github.com/mistralai/mistral-vibe',
        note: 'Needs uv; the install script does not support Windows.',
      },
    },
    auth: {
      signInHint:
        'Run vibe --setup on the computer Station runs on, or provide a Mistral API key.',
      credentialEnvVars: ['MISTRAL_API_KEY'],
    },
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    description:
      "Google's Antigravity agent, through the server Google ships for editors.",
    command: 'agy_acp_server.par',
    args: [],
    icon: 'AG',
    tags: ['acp', 'antigravity', 'google'],
    homepageUrl: 'https://antigravity.google/docs/ide/extensions/zed',
    install: {
      darwin: {
        docsUrl: 'https://antigravity.google/docs/ide/extensions/zed',
        note: 'Google ships this server as a download, not an installer. Unzip it and put agy_acp_server.par on your PATH.',
      },
      linux: {
        docsUrl: 'https://antigravity.google/docs/ide/extensions/zed',
        note: 'Google ships this server as a download, not an installer. Unzip it and put agy_acp_server.par on your PATH.',
      },
      win32: {
        docsUrl: 'https://antigravity.google/docs/ide/extensions/zed',
        note: 'On Windows the server is agy_acp_server.exe. Add it as a custom engine with that command.',
      },
    },
    auth: {
      signInHint: 'Sign in with your Google account when Antigravity asks.',
    },
  },
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    description: "Factory's Droid coding agent CLI.",
    command: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    icon: 'FD',
    tags: ['acp', 'factory', 'droid'],
    homepageUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    // Both spellings: the first is documented, the second is what Factory's
    // own registry entry sets.
    launchEnv: {
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
      DROID_DISABLE_AUTO_UPDATE: 'true',
    },
    install: {
      darwin: {
        command: 'curl -fsSL https://app.factory.ai/cli | sh',
        docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
      },
      linux: {
        command: 'curl -fsSL https://app.factory.ai/cli | sh',
        docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
        note: 'Needs xdg-utils.',
      },
      win32: {
        command: 'irm https://app.factory.ai/cli/windows | iex',
        docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
        note: POWERSHELL,
      },
    },
    auth: {
      signInHint:
        'Run droid in a terminal on the computer Station runs on and sign in, or provide a Factory API key.',
      credentialEnvVars: ['FACTORY_API_KEY'],
    },
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description: "Nous Research's Hermes Agent.",
    command: 'hermes',
    args: ['acp'],
    icon: 'HA',
    tags: ['acp', 'hermes', 'nous'],
    homepageUrl:
      'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
    install: {
      darwin: {
        command:
          'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
        docsUrl:
          'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
        note: 'Then add the editor-integration extra the linked guide describes.',
      },
      linux: {
        command:
          'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
        docsUrl:
          'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
        note: 'Then add the editor-integration extra the linked guide describes.',
      },
      win32: {
        command: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
        docsUrl:
          'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
        note: `${POWERSHELL} Then add the editor-integration extra the linked guide describes.`,
      },
    },
    auth: {
      statusCommand: ['hermes', 'status'],
      signInHint:
        'Run hermes setup on the computer Station runs on to choose a model provider.',
    },
  },
  {
    id: 'pi',
    name: 'pi',
    description:
      'The pi coding agent, through the community pi-acp bridge. The bridge does not pass Station tool servers to pi and has no model switching yet.',
    command: 'pi-acp',
    args: [],
    icon: 'brand:pi',
    tags: ['acp', 'pi', 'community'],
    homepageUrl: 'https://github.com/svkozak/pi-acp',
    install: {
      darwin: {
        command: 'curl -fsSL https://pi.dev/install.sh | sh && npm i -g pi-acp',
        docsUrl: 'https://github.com/svkozak/pi-acp',
        note: 'Installs pi, then the bridge. The bridge needs Node.js 22 or later.',
      },
      linux: {
        command: 'curl -fsSL https://pi.dev/install.sh | sh && npm i -g pi-acp',
        docsUrl: 'https://github.com/svkozak/pi-acp',
        note: 'Installs pi, then the bridge. The bridge needs Node.js 22 or later.',
      },
      win32: {
        command: 'irm https://pi.dev/install.ps1 | iex; npm i -g pi-acp',
        docsUrl: 'https://github.com/svkozak/pi-acp',
        note: `${POWERSHELL} Installs pi, then the bridge. The bridge needs Node.js 22 or later.`,
      },
    },
    auth: {
      signInHint:
        'Start pi in a terminal on the computer Station runs on and run /login.',
    },
  },
  {
    id: 'cline',
    name: 'Cline',
    description: 'The Cline coding agent CLI.',
    command: 'cline',
    args: ['--acp'],
    icon: 'CL',
    tags: ['acp', 'cline'],
    homepageUrl: 'https://docs.cline.bot/usage/acp',
    install: {
      darwin: { command: 'npm i -g cline', docsUrl: 'https://cline.bot/cli' },
      linux: { command: 'npm i -g cline', docsUrl: 'https://cline.bot/cli' },
      win32: { command: 'npm i -g cline', docsUrl: 'https://cline.bot/cli' },
    },
    auth: {
      signInHint: 'Run cline auth on the computer Station runs on.',
      credentialEnvVars: ['CLINE_API_KEY'],
    },
  },
  {
    id: 'devin',
    name: 'Devin',
    description: "Cognition's Devin coding agent CLI.",
    command: 'devin',
    args: ['acp'],
    icon: 'DV',
    tags: ['acp', 'devin'],
    homepageUrl: 'https://docs.devin.ai/cli',
    install: {
      darwin: {
        command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
        docsUrl: 'https://docs.devin.ai/cli',
      },
      linux: {
        command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
        docsUrl: 'https://docs.devin.ai/cli',
      },
      win32: {
        command: 'irm https://static.devin.ai/cli/setup.ps1 | iex',
        docsUrl: 'https://docs.devin.ai/cli',
        note: POWERSHELL,
      },
    },
    auth: {
      statusCommand: ['devin', 'auth', 'status'],
      signInHint: 'Run devin auth login on the computer Station runs on.',
      credentialEnvVars: ['WINDSURF_API_KEY'],
    },
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    description: "Moonshot AI's Kimi Code coding agent.",
    command: 'kimi',
    args: ['acp'],
    icon: 'KM',
    tags: ['acp', 'kimi', 'moonshot'],
    homepageUrl: 'https://moonshotai.github.io/kimi-code/en/',
    install: {
      darwin: {
        command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
        docsUrl: 'https://moonshotai.github.io/kimi-code/en/',
      },
      linux: {
        command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
        docsUrl: 'https://moonshotai.github.io/kimi-code/en/',
      },
      win32: {
        command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
        docsUrl: 'https://moonshotai.github.io/kimi-code/en/',
        note: `${POWERSHELL} Needs Git for Windows.`,
      },
    },
    auth: {
      signInHint: 'Run kimi login on the computer Station runs on.',
    },
  },
  {
    id: 'kilo',
    name: 'Kilo',
    description: 'The open-source Kilo coding agent CLI.',
    command: 'kilo',
    args: ['acp'],
    icon: 'KL',
    tags: ['acp', 'kilo'],
    homepageUrl: 'https://kilo.ai/docs/cli',
    install: {
      darwin: {
        command: 'curl -fsSL https://kilo.ai/cli/install | bash',
        docsUrl: 'https://kilo.ai/docs/cli',
      },
      linux: {
        command: 'curl -fsSL https://kilo.ai/cli/install | bash',
        docsUrl: 'https://kilo.ai/docs/cli',
      },
      win32: {
        command: 'npm i -g @kilocode/cli',
        docsUrl: 'https://kilo.ai/docs/cli',
      },
    },
    auth: {
      statusCommand: ['kilo', 'auth', 'list'],
      signInHint: 'Run kilo auth login on the computer Station runs on.',
      credentialEnvVars: ['KILO_API_KEY'],
    },
  },
  {
    id: 'junie',
    name: 'Junie',
    description: "JetBrains' Junie coding agent CLI.",
    command: 'junie',
    args: ['--acp=true'],
    icon: 'JN',
    tags: ['acp', 'junie', 'jetbrains'],
    homepageUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    install: {
      darwin: {
        command: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
        docsUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
      },
      linux: {
        command: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
        docsUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
      },
      win32: {
        command: "iex (irm 'https://junie.jetbrains.com/install.ps1')",
        docsUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
        note: POWERSHELL,
      },
    },
    auth: {
      signInHint:
        'Start junie in a terminal on the computer Station runs on and sign in with your JetBrains account or a Junie API key.',
      credentialEnvVars: ['JUNIE_API_KEY'],
    },
  },
];
