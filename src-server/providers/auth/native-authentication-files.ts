import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  claudeKeychainScope,
  observeClaudeKeychain,
} from './claude-keychain-authentication.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 256;

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

type FileInput = {
  path: string;
  project?: (text: string) => string;
  validate?: (text: string) => void;
};

function assertProjectedFile(
  path: string,
  project: (text: string) => string,
  expected: string,
): void {
  if (absent(path)) {
    if (digest(project('{}')) === expected) return;
    throw new Error('ensemble_auth_file_changed');
  }
  // Native bookkeeping can change while the authentication projection stays fixed.
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
      throw new Error('ensemble_auth_file_changed');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    for (;;) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      length += count;
      if (length === bytes.length)
        throw new Error('ensemble_auth_file_changed');
      if (!count) break;
    }
    if (
      identity(before) !== identity(fstatSync(descriptor, { bigint: true })) ||
      identity(before) !== identity(lstatSync(path, { bigint: true })) ||
      before.size !== BigInt(length) ||
      digest(project(bytes.subarray(0, length).toString('utf8'))) !== expected
    )
      throw new Error('ensemble_auth_file_changed');
  } finally {
    closeSync(descriptor);
  }
}

async function observeFile(input: FileInput): Promise<() => void> {
  if (!isAbsolute(input.path))
    throw new Error('ensemble_auth_file_unsupported');
  let file: FileHandle;
  try {
    file = await open(
      input.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (input.project) {
      const project = input.project;
      const expected = digest(project('{}'));
      return () => assertProjectedFile(input.path, project, expected);
    }
    return () => {
      if (!absent(input.path)) throw new Error('ensemble_auth_file_changed');
    };
  }
  let expected: string;
  let signature: string;
  let canonical: string;
  try {
    canonical = realpathSync(input.path);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
      throw new Error('ensemble_auth_file_unsupported');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    for (;;) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      length += read.bytesRead;
      if (length === bytes.length)
        throw new Error('ensemble_auth_file_unsupported');
      if (!read.bytesRead) break;
    }
    signature = identity(before);
    if (
      signature !== identity(await file.stat({ bigint: true })) ||
      signature !== identity(lstatSync(input.path, { bigint: true })) ||
      before.size !== BigInt(length)
    )
      throw new Error('ensemble_auth_file_changed');
    const content = bytes.subarray(0, length);
    input.validate?.(content.toString('utf8'));
    expected = digest(
      input.project ? input.project(content.toString('utf8')) : content,
    );
  } finally {
    await file.close();
  }
  return () => {
    if (input.project) {
      assertProjectedFile(input.path, input.project, expected);
      return;
    }
    const named = lstatSync(input.path, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      realpathSync(input.path) !== canonical
    )
      throw new Error('ensemble_auth_file_changed');
    if (identity(named) !== signature)
      throw new Error('ensemble_auth_file_changed');
  };
}

function claudeAuthenticationMetadata(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('ensemble_auth_file_unsupported');
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) =>
          /auth|oauth|api.?key|credential|account|organization|helper|proxy|base.?url/i.test(
            key,
          ),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

/** Bounded local-file and Claude Keychain witnesses; remote policy remains unsupported. */
export async function observeNativeAuthenticationFiles(input: {
  engine: 'codex' | 'claude';
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<() => void> {
  const home = input.env.HOME ?? homedir();
  const config =
    input.engine === 'codex'
      ? (input.env.CODEX_HOME ?? join(home, '.codex'))
      : (input.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'));
  const entries = new Map<string, FileInput>();
  const add = (path: string, options: Omit<FileInput, 'path'> = {}) => {
    if (!entries.has(path)) entries.set(path, { path, ...options });
    if (entries.size > MAX_FILES)
      throw new Error('ensemble_auth_file_unsupported');
  };
  if (platform() === 'win32')
    throw new Error('ensemble_auth_store_unsupported');
  let keychainCurrent: (() => void) | undefined;
  if (input.engine === 'claude') {
    if (
      platform() === 'darwin' &&
      ![
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ].some((key) => Boolean(input.env[key]?.trim()))
    ) {
      const override = input.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      const storage =
        override === undefined ? config : override || join(home, '.claude');
      const scope = claudeKeychainScope(
        input.env,
        storage,
        override === undefined
          ? !input.env.CLAUDE_CONFIG_DIR && home === homedir()
          : override.length === 0,
      );
      if (!scope) throw new Error('ensemble_auth_store_unsupported');
      keychainCurrent = await observeClaudeKeychain(scope);
    }
    for (const key of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_PROCESS_WRAPPER',
      'CLAUDE_CODE_API_KEY_HELPER',
      'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
      'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
    ]) {
      if (input.env[key]) throw new Error('ensemble_auth_store_unsupported');
    }
  }
  const refuseManaged = () => {
    throw new Error('ensemble_auth_store_unsupported');
  };
  if (platform() === 'darwin') {
    const domain =
      input.engine === 'codex'
        ? 'com.openai.codex'
        : 'com.anthropic.claudecode';
    add(join('/Library/Managed Preferences', `${domain}.plist`), {
      validate: refuseManaged,
    });
    if (input.env.USER && /^[a-zA-Z0-9._-]+$/.test(input.env.USER))
      add(
        join('/Library/Managed Preferences', input.env.USER, `${domain}.plist`),
        { validate: refuseManaged },
      );
  }
  const validateSettings = (text: string) => {
    const settings: unknown = JSON.parse(text);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('ensemble_auth_file_unsupported');
    for (const key of [
      'apiKeyHelper',
      'proxyAuthHelper',
      'awsCredentialExport',
      'awsAuthRefresh',
      'gcpAuthRefresh',
      'processWrapper',
      'policyHelper',
      'include',
      'imports',
    ]) {
      if (key in settings) throw new Error('ensemble_auth_store_unsupported');
    }
    if ('env' in settings && settings.env && typeof settings.env === 'object') {
      for (const key of Object.keys(settings.env))
        if (
          /BEDROCK|VERTEX|FOUNDRY|HELPER|WRAPPER|CREDENTIAL|AWS_|GOOGLE_/i.test(
            key,
          )
        )
          throw new Error('ensemble_auth_store_unsupported');
    }
  };
  const codexConfigurations: Array<{
    selectedProfile: boolean;
    strictSupported: boolean;
    defaultSupported: boolean;
  }> = [];
  const supportsCodexConfiguration = (
    settings: Record<string, unknown>,
    allowDormant: boolean,
  ): boolean => {
    const walk = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return true;
      for (const [key, child] of Object.entries(value)) {
        if (
          value === settings &&
          allowDormant &&
          (key === 'profiles' || key === 'model_providers')
        ) {
          if (
            !child ||
            typeof child !== 'object' ||
            Array.isArray(child) ||
            (key === 'model_providers' && Object.hasOwn(child, 'openai'))
          )
            return false;
          continue;
        }
        if (
          (key === 'cli_auth_credentials_store' && child !== 'file') ||
          /credential.*(helper|provider)|auth.*helper|^include$|^imports$/i.test(
            key,
          ) ||
          (key === 'model_provider' && child !== 'openai') ||
          key === 'model_providers' ||
          !walk(child)
        )
          return false;
      }
      return true;
    };
    return walk(settings);
  };
  const validateCodex = (text: string) => {
    const settings = parseToml(text);
    codexConfigurations.push({
      selectedProfile: settings.profile !== undefined,
      strictSupported: supportsCodexConfiguration(settings, false),
      defaultSupported: supportsCodexConfiguration(settings, true),
    });
    if (settings.profile !== undefined) {
      if (
        typeof settings.profile !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(settings.profile)
      )
        throw new Error('ensemble_auth_store_unsupported');
      add(join(config, `${settings.profile}.config.toml`), {
        validate: validateCodex,
      });
    }
  };
  if (input.engine === 'codex') {
    add(join(config, 'auth.json'));
    add(join(config, 'cloud-config-bundle-cache.json'), {
      validate: refuseManaged,
    });
    add(join(config, 'config.toml'), { validate: validateCodex });
    add(join(config, 'managed_config.toml'), { validate: validateCodex });
    for (const name of [
      'config.toml',
      'requirements.toml',
      'managed_config.toml',
    ])
      add(join('/etc/codex', name), { validate: validateCodex });
    add(join(input.cwd, 'config.toml'), { validate: validateCodex });
  } else {
    add(
      join(
        input.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || config,
        '.credentials.json',
      ),
    );
    add(join(config, 'settings.json'), { validate: validateSettings });
    add(join(config, 'remote-settings.json'), { validate: refuseManaged });
    add(join(home, '.claude', 'remote-settings.json'), {
      validate: refuseManaged,
    });
    add(join(config, '.claude.json'), {
      project: claudeAuthenticationMetadata,
    });
    add(join(home, '.claude.json'), { project: claudeAuthenticationMetadata });
    add('/Library/Application Support/ClaudeCode/managed-settings.json', {
      validate: validateSettings,
    });
    add('/etc/claude-code/managed-settings.json', {
      validate: validateSettings,
    });
  }
  for (let path = input.cwd; ; path = dirname(path)) {
    if (input.engine === 'codex')
      add(join(path, '.codex', 'config.toml'), { validate: validateCodex });
    else {
      add(join(path, '.claude', 'settings.json'), {
        validate: validateSettings,
      });
      add(join(path, '.claude', 'settings.local.json'), {
        validate: validateSettings,
      });
    }
    if (dirname(path) === path) break;
  }
  const witnesses: Array<() => void> = keychainCurrent ? [keychainCurrent] : [];
  for (const entry of entries.values())
    witnesses.push(await observeFile(entry));
  // A selection in any witnessed layer can activate declarations in another.
  // With no selected profile, native launch arguments cannot select one either.
  const selectedProfile = codexConfigurations.some(
    (settings) => settings.selectedProfile,
  );
  if (
    codexConfigurations.some((settings) =>
      selectedProfile ? !settings.strictSupported : !settings.defaultSupported,
    )
  )
    throw new Error('ensemble_auth_store_unsupported');
  return () => {
    for (const assertCurrent of witnesses) assertCurrent();
  };
}
