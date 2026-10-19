#!/usr/bin/env node
// Static architecture ratchet for #809. React features may only touch the
// Tauri SDK inside the dedicated native platform adapter. This keeps host
// detection, commands, and events out of feature code and makes the web
// fallback deterministic.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const TAURI_CAPABILITY_MANIFEST =
  'src-desktop/capabilities/default.json';
export const TAURI_DESKTOP_ROOT = 'src-desktop';
export const TAURI_CAPABILITY_DIRECTORY = `${TAURI_DESKTOP_ROOT}/capabilities`;
// #3851: the desktop updater is native-owned. The webview reads its state and
// asks it to act through app commands; it holds no updater or process plugin
// authority, so nothing Tauri loads may grant either. The manifest that used
// to (#575) must not come back.
export const RETIRED_DESKTOP_UPDATER_CAPABILITY_MANIFEST =
  'src-desktop/capabilities/desktop-updater.json';
export const NATIVE_ONLY_PERMISSION_PREFIXES = ['updater:', 'process:'];
export const TAURI_BASE_CONFIG = 'src-desktop/tauri.conf.json';
export const TAURI_DESKTOP_CONFIGS = [
  'src-desktop/tauri.macos.conf.json',
  'src-desktop/tauri.nightly.conf.json',
  'src-desktop/tauri.windows.conf.json',
  'src-desktop/tauri.linux.conf.json',
];
export const TAURI_APPIMAGE_CONFIG =
  'src-desktop/tauri.linux-appimage.conf.json';
export const TAURI_MOBILE_CONFIGS = [
  'src-desktop/tauri.android.conf.json',
  'src-desktop/tauri.ios.conf.json',
];
export const EXPECTED_DESKTOP_RESOURCES = {
  '../dist-server': 'dist-server',
  '../dist-desktop-runtime/node_modules': 'node_modules',
  '../schemas': 'schemas',
  '../dist-desktop-runtime/examples': 'examples',
};
export const EXPECTED_APPIMAGE_RUNTIME_FILES = {
  'usr/share/Station/dist-server': '../dist-server',
  'usr/share/Station/node_modules': '../dist-desktop-runtime/node_modules',
  'usr/share/Station/examples': '../dist-desktop-runtime/examples',
};
export const EXPECTED_APPIMAGE_REMOVED_RESOURCES = {
  '../dist-server': null,
  '../dist-desktop-runtime/node_modules': null,
  '../dist-desktop-runtime/examples': null,
};
export const EXPECTED_TAURI_PERMISSIONS = [
  // Read the configured local package name for Stable/Beta/Nightly/Dev shell
  // identity; it never reads remote Station branding.
  'core:app:allow-name',
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  // The macOS overlay title bar draws window chrome in the webview: its
  // data-tauri-drag-region strips need window dragging plus the native
  // double-click-to-zoom behavior, and nothing else.
  'core:window:allow-start-dragging',
  'core:window:allow-internal-toggle-maximize',
  // Posting OS notifications. Station's delivery is web push, which needs
  // PushManager — absent in Android WebView — so without this the native app
  // cannot be notified of anything at all, including a device waiting to pair
  // (#910). The grant lets webview JavaScript raise a system notification;
  // that authority is bounded by the same CSP that already limits this webview
  // to Station's own bundled UI with no remote script origins.
  'notification:default',
  // Mobile haptic feedback (station#1954). Official Tauri plugin; webview may
  // only call the three discrete feedback commands Station uses — not vibrate
  // with arbitrary duration.
  'haptics:allow-impact-feedback',
  'haptics:allow-notification-feedback',
  'haptics:allow-selection-feedback',
  // Narrow channel-specific pairing association (station#1957). The default plugin ACL
  // permits reading launch URLs and subscribing to registered deep-link events;
  // application validation still accepts only one pairing payload and never
  // opens or navigates to an inbound URL.
  'deep-link:default',
];
export const EXPECTED_TAURI_CSP = {
  'default-src': "'none'",
  'script-src': "'self' 'wasm-unsafe-eval'",
  'style-src': "'self' 'unsafe-inline'",
  'connect-src': "'self' ipc: http://ipc.localhost http: https: ws: wss:",
  'font-src': "'self' data:",
  'img-src': "'self' asset: http://asset.localhost data: blob: http: https:",
  'media-src': "'self' asset: http://asset.localhost data: blob: http: https:",
  'frame-src': "'self' data: blob: http: https:",
  'worker-src': "'self' blob:",
  'manifest-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'frame-ancestors': "'none'",
  'form-action': "'self'",
};

export const TAURI_ADAPTER_FILES = new Set([
  'src-ui/src/platform/native/index.ts',
  'src-ui/src/platform/native/tauri.ts',
  // One reviewed lazy invoke boundary shared by native storage adapters.
  // Feature code still cannot import Tauri directly.
  'src-ui/src/platform/native/tauriInvoke.ts',
  // Narrow lazy app-identity read for channel-aware shell labels.
  'src-ui/src/platform/native/productName.ts',
  // The one host-owned authenticated transport. It is intentionally the only
  // renderer module allowed to create a Tauri IPC channel for HTTP bytes.
  'src-ui/src/platform/native/authenticatedTransport.ts',
  'src-ui/src/platform/native/pairingTransport.ts',
  // Posts OS notifications; web push cannot reach the native shell at all.
  'src-ui/src/platform/native/notifier.ts',
  // Mobile haptics via the official Tauri plugin (station#1954).
  'src-ui/src/platform/native/haptics.ts',
]);
export const TAURI_NONCE_MARKER_PATTERN =
  /<script\s+data-station-csp-nonce(?:="")?\s+nonce="__TAURI_SCRIPT_NONCE__"\s*><\/script>/;

export const TAURI_IMPORT_PATTERN = /['"]@tauri-apps\/api(?:\/[^'"]+)?['"]/g;
export const NATIVE_GLOBAL_PATTERN = /(?:window\.)?__(?:TAURI|SHARE_TEXT)__/g;
// #3851: no renderer module, adapter files included, may reach the updater or
// process plugins; the native shell owns update and restart.
export const NATIVE_ONLY_PLUGIN_IMPORT_PATTERN =
  /['"]@tauri-apps\/plugin-(?:updater|process)(?:\/[^'"]+)?['"]/g;

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function findingsForPattern(file, content, pattern, kind) {
  pattern.lastIndex = 0;
  const findings = [];
  let match = pattern.exec(content);
  while (match !== null) {
    findings.push({
      file,
      line: lineNumberAt(content, match.index),
      kind,
      snippet: match[0],
    });
    match = pattern.exec(content);
  }
  return findings;
}

export function findNativeBoundaryViolations(files, readFile) {
  const findings = [];
  for (const file of files) {
    const content = readFile(file);
    findings.push(
      ...findingsForPattern(
        file,
        content,
        NATIVE_ONLY_PLUGIN_IMPORT_PATTERN,
        'native-only plugin import',
      ),
    );
    if (TAURI_ADAPTER_FILES.has(file)) continue;
    findings.push(
      ...findingsForPattern(
        file,
        content,
        TAURI_IMPORT_PATTERN,
        'tauri import',
      ),
      ...findingsForPattern(
        file,
        content,
        NATIVE_GLOBAL_PATTERN,
        'native global',
      ),
    );
  }
  return findings;
}

export function findCapabilityManifestViolations(
  content,
  expectedPermissions = EXPECTED_TAURI_PERMISSIONS,
) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return ['Tauri capability manifest is not valid JSON'];
  }

  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.length !== expectedPermissions.length ||
    !expectedPermissions.every(
      (permission, index) => manifest.permissions[index] === permission,
    )
  ) {
    return [
      `Tauri JavaScript permissions must be exactly ${expectedPermissions.join(', ')}`,
    ];
  }
  return [];
}

function isNativeOnlyIdentifier(value) {
  return NATIVE_ONLY_PERMISSION_PREFIXES.some((prefix) =>
    value.startsWith(prefix),
  );
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value))
    for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

// The escapes each syntax defines; anything else in TOML is an error, so
// the lexer refuses it rather than guessing what the loader would decode.
const TOML_ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001b',
  '"': '"',
  '\\': '\\',
};
const JSON5_ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  v: '\v',
  0: '\0',
  '"': '"',
  "'": "'",
  '\\': '\\',
};
// JSON5 (ECMAScript) line terminators: comment ends and line continuations.
const JSON5_LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Every string value in a JSON5 or TOML document, decoded the way the
 * loader would: comments (`//` and block comments in JSON5, `#` in TOML)
 * are skipped, so a quote inside one cannot shift what counts as a string,
 * and escapes and line continuations are decoded, so an escaped identifier
 * is seen as the identifier it spells. TOML follows 1.1 (Tauri loads it
 * with toml_parser 1.1): `\xHH`, `\e`, and in multi-line basic strings a
 * backslash, optional spaces or tabs, then a newline. There is no TOML or
 * declared JSON5 parser among the dependencies; this lexer reads strings
 * only, and refuses (returns null) on an unterminated string or comment or
 * an escape the syntax does not define.
 */
export function stringLiteralsIn(content, syntax) {
  const strings = [];
  let index = 0;
  const hex = (length) => {
    const digits = content.slice(index, index + length);
    if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== length) return null;
    index += length;
    return String.fromCodePoint(Number.parseInt(digits, 16));
  };
  // TOML: after a line-ending backslash, skip every space, tab and newline.
  const skipTomlContinuation = () => {
    while (/[ \t]/.test(content[index] ?? '')) index += 1;
    if (content[index] === '\n') index += 1;
    else if (content.startsWith('\r\n', index)) index += 2;
    else return false;
    while (/[ \t\r\n]/.test(content[index] ?? '')) index += 1;
    return true;
  };
  const escape = (triple) => {
    const next = content[index];
    if (next === undefined) return null;
    if (syntax === 'toml') {
      if (triple && /[ \t\r\n]/.test(next))
        return skipTomlContinuation() ? '' : null;
      index += 1;
      if (next === 'u') return hex(4);
      if (next === 'U') return hex(8);
      if (next === 'x') return hex(2);
      return TOML_ESCAPES[next] ?? null;
    }
    if (JSON5_LINE_TERMINATOR.test(next)) {
      index += next === '\r' && content[index + 1] === '\n' ? 2 : 1;
      return '';
    }
    index += 1;
    if (next === 'u') return hex(4);
    if (next === 'x') return hex(2);
    if (/[1-9]/.test(next)) return null;
    // JSON5 decodes any other character after a backslash to itself.
    return JSON5_ESCAPES[next] ?? next;
  };
  const readString = (quote, triple, escapes) => {
    let value = '';
    if (triple && content[index] === '\n') index += 1;
    else if (triple && content.startsWith('\r\n', index)) index += 2;
    while (index < content.length) {
      if (content.startsWith(triple ? quote.repeat(3) : quote, index)) {
        index += triple ? 3 : 1;
        return value;
      }
      const char = content[index];
      if (!triple && (char === '\n' || char === '\r')) return null;
      if (escapes && char === '\\') {
        index += 1;
        const decoded = escape(triple);
        if (decoded === null) return null;
        value += decoded;
        continue;
      }
      value += char;
      index += 1;
    }
    return null;
  };
  const skipLineComment = (terminator) => {
    while (index < content.length && !terminator.test(content[index]))
      index += 1;
  };
  while (index < content.length) {
    if (syntax === 'json5' && content.startsWith('//', index)) {
      skipLineComment(JSON5_LINE_TERMINATOR);
    } else if (syntax === 'json5' && content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      if (end === -1) return null;
      index = end + 2;
    } else if (syntax === 'toml' && content[index] === '#') {
      skipLineComment(/\n/);
    } else if (content[index] === '"' || content[index] === "'") {
      const quote = content[index];
      const triple =
        syntax === 'toml' && content.startsWith(quote.repeat(3), index);
      index += triple ? 3 : 1;
      // TOML literal strings ('...') take no escapes; JSON5 single-quoted
      // strings do.
      const value = readString(
        quote,
        triple,
        !(syntax === 'toml' && quote === "'"),
      );
      if (value === null) return null;
      strings.push(value);
    } else index += 1;
  }
  return strings;
}

const TAURI_CONFIG_PATH = /(?:^|\/)(?:tauri.*\.conf\.json5?|Tauri.*\.toml)$/i;

/**
 * The updater/process identifiers a file Tauri loads could grant or bundle.
 * A JSON capability or permission file is parsed and walked whole (a
 * capability, a list, a `{ "capabilities": [...] }` file, or a permission
 * set). A JSON Tauri config is read only at `app.security.capabilities`,
 * where capabilities are inlined. JSON5 and TOML are read string by string.
 * Anything unreadable is reported rather than skipped.
 */
export function nativeOnlyIdentifiersIn(file, content) {
  let strings;
  if (file.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { identifiers: [], unreadable: true };
    }
    strings = collectStrings(
      TAURI_CONFIG_PATH.test(file)
        ? (parsed?.app?.security?.capabilities ?? [])
        : parsed,
      [],
    );
  } else {
    strings = stringLiteralsIn(
      content,
      file.endsWith('.toml') ? 'toml' : 'json5',
    );
    if (strings === null) return { identifiers: [], unreadable: true };
  }
  return {
    identifiers: [...new Set(strings.map((value) => value.trim()))].filter(
      isNativeOnlyIdentifier,
    ),
    unreadable: false,
  };
}

/**
 * Any file Tauri loads that grants the webview updater or process
 * permissions, or defines an app permission set bundling them (#3851).
 * `files` is `[path, content]` pairs from {@link listTauriAclSources}; the
 * retired desktop-updater manifest is a violation by its presence alone.
 */
export function findNativeOnlyPermissionGrants(files) {
  const violations = [];
  for (const [file, content] of files) {
    if (/(?:^|\/)capabilities\/desktop-updater\.json$/.test(file)) {
      violations.push(
        `${file} must not exist: desktop updates are native-owned (#3851)`,
      );
    }
    const { identifiers, unreadable } = nativeOnlyIdentifiersIn(file, content);
    if (unreadable) violations.push(`${file} could not be read`);
    for (const identifier of identifiers) {
      violations.push(
        `${file} grants ${identifier}; the webview holds no updater or process authority (#3851)`,
      );
    }
  }
  return violations;
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

const TAURI_CONFIG_FILE = /^(?:tauri.*\.conf\.json5?|Tauri.*\.toml)$/i;

/**
 * Everything Tauri reads ACL entries from under a desktop root: every file
 * under `capabilities/` (Tauri globs `capabilities/**\/*` and loads json,
 * json5 and toml), every app permission file under `permissions/`, and every
 * Tauri config, whose `app.security.capabilities` may inline capabilities.
 * Files of any extension under those directories are included, so a format
 * a later Tauri accepts is not silently skipped.
 */
export function listTauriAclSources(root = TAURI_DESKTOP_ROOT) {
  const configs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TAURI_CONFIG_FILE.test(entry.name))
    .map((entry) => `${root}/${entry.name}`);
  return [
    ...walkFiles(`${root}/capabilities`),
    ...walkFiles(`${root}/permissions`),
    ...configs,
  ]
    .sort()
    .map((file) => [file, readFileSync(file, 'utf8')]);
}

function hasExactTauriCsp(csp) {
  if (!csp || typeof csp !== 'object' || Array.isArray(csp)) return false;
  const actualKeys = Object.keys(csp).sort();
  const expectedKeys = Object.keys(EXPECTED_TAURI_CSP).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] && csp[key] === EXPECTED_TAURI_CSP[key],
    )
  );
}

export function findTauriCspViolations(content) {
  let config;
  try {
    config = JSON.parse(content);
  } catch {
    return ['Tauri config is not valid JSON'];
  }

  const security = config?.app?.security;
  if (!hasExactTauriCsp(security?.csp)) {
    return ['app.security.csp must be the exact Station desktop CSP'];
  }

  const violations = [];
  if (Object.hasOwn(security, 'devCsp')) {
    violations.push(
      'app.security.devCsp must be absent so development inherits csp',
    );
  }
  if (
    security.dangerousDisableAssetCspModification !== undefined &&
    security.dangerousDisableAssetCspModification !== false
  ) {
    violations.push(
      'app.security.dangerousDisableAssetCspModification must not disable Tauri CSP mutation',
    );
  }
  return violations;
}

export function findTauriNonceMarkerViolations(content) {
  return TAURI_NONCE_MARKER_PATTERN.test(content)
    ? []
    : [
        'src-ui/index.html must retain the exact Station Tauri script nonce marker',
      ];
}

export function findTauriResourceBoundaryViolations(
  baseContent,
  desktopContents,
  mobileContents,
  appImageContent,
) {
  const violations = [];
  const parse = (content, label) => {
    try {
      return JSON.parse(content);
    } catch {
      violations.push(`${label} is not valid JSON`);
      return {};
    }
  };
  const base = parse(baseContent, TAURI_BASE_CONFIG);
  if (base?.bundle?.resources !== undefined)
    violations.push('base config must not bundle desktop server resources');
  if (base?.build?.beforeBuildCommand !== 'npm run build:native-client')
    violations.push('base config must build only the native client');

  for (const [file, content] of desktopContents) {
    const config = parse(content, file);
    if (
      JSON.stringify(config?.bundle?.resources) !==
      JSON.stringify(EXPECTED_DESKTOP_RESOURCES)
    )
      violations.push(`${file} must bundle the exact desktop resources`);
    if (config?.build?.beforeBuildCommand !== 'npm run build:desktop:resources')
      violations.push(`${file} must build the embedded desktop runtime`);
  }
  for (const [file, content] of mobileContents) {
    const config = parse(content, file);
    if (config?.bundle?.resources !== undefined)
      violations.push(`${file} must not bundle desktop server resources`);
    if (config?.build?.beforeBuildCommand !== undefined)
      violations.push(`${file} must inherit the native-client build`);
  }
  if (!appImageContent) {
    violations.push(
      `${TAURI_APPIMAGE_CONFIG} must define the AppImage overlay`,
    );
    return violations;
  }
  const [appImageFile, appImageConfigContent] = appImageContent;
  const appImage = parse(appImageConfigContent, appImageFile);
  if (
    JSON.stringify(appImage?.bundle?.resources) !==
    JSON.stringify(EXPECTED_APPIMAGE_REMOVED_RESOURCES)
  ) {
    violations.push(
      `${appImageFile} must delete only the inherited server, raw node_modules and examples resources`,
    );
  }
  if (
    JSON.stringify(appImage?.bundle?.linux?.appimage?.files) !==
    JSON.stringify(EXPECTED_APPIMAGE_RUNTIME_FILES)
  ) {
    violations.push(
      `${appImageFile} must colocate the AppImage server and runtime tree outside usr/lib`,
    );
  }
  return violations;
}

function listTrackedUiSources() {
  return (
    execFileSyncBounded('git', ['ls-files', 'src-ui/src'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\n')
      .filter((file) => /\.(?:ts|tsx)$/.test(file))
      // `git ls-files` includes a tracked file removed in the current working
      // tree. Do not make a removal itself prevent the static gate from
      // inspecting the remaining live source.
      .filter((file) => existsSync(file))
      .filter((file) => !file.includes('/__tests__/'))
  );
}

export function findRendererCredentialBoundaryViolations(readText) {
  const violations = [];
  const uiSources = listTrackedUiSources();
  const forbidden =
    /credential_vault_(?:read|write)|createNativeCredentialVault|nativeCredentialStorage|platform\/native\/credentialVault/;
  for (const file of uiSources) {
    const content = readText(file);
    const match = forbidden.exec(content);
    if (match) {
      violations.push(
        `${file}:${lineNumberAt(content, match.index)} exposes native credential hydration or arbitrary keyring access`,
      );
    }
  }
  const apiBase = readText('src-ui/src/contexts/ApiBaseContext.tsx');
  if (!apiBase.includes('new RejectingCredentialStorage()')) {
    violations.push(
      'src-ui/src/contexts/ApiBaseContext.tsx must install a rejecting desktop credential adapter',
    );
  }
  const connectionList = readText(
    'packages/connect/src/react/connection-manager-modal/ConnectionListPanel.tsx',
  );
  if (!connectionList.includes('allowManualCredentials &&')) {
    violations.push(
      'ConnectionListPanel must gate manual bearer controls outside native desktop',
    );
  }
  return violations;
}

function main() {
  const findings = findNativeBoundaryViolations(
    listTrackedUiSources(),
    // Without an encoding this yields a Buffer, and the first violation found
    // then died in lineNumberAt with "slice(...).split is not a function" —
    // so this gate could only ever report a clean run.
    (file) => readFileSync(file, 'utf8'),
  );
  const manifestFindings = findCapabilityManifestViolations(
    readFileSync(TAURI_CAPABILITY_MANIFEST, 'utf8'),
  );
  const desktopRootFlag = process.argv.indexOf('--desktop-root');
  const nativeOnlyGrantFindings = findNativeOnlyPermissionGrants(
    listTauriAclSources(
      desktopRootFlag === -1
        ? TAURI_DESKTOP_ROOT
        : process.argv[desktopRootFlag + 1],
    ),
  );
  const cspFindings = findTauriCspViolations(
    readFileSync(TAURI_BASE_CONFIG, 'utf8'),
  );
  const resourceFindings = findTauriResourceBoundaryViolations(
    readFileSync(TAURI_BASE_CONFIG, 'utf8'),
    TAURI_DESKTOP_CONFIGS.map((file) => [file, readFileSync(file, 'utf8')]),
    TAURI_MOBILE_CONFIGS.map((file) => [file, readFileSync(file, 'utf8')]),
    [TAURI_APPIMAGE_CONFIG, readFileSync(TAURI_APPIMAGE_CONFIG, 'utf8')],
  );
  const nonceMarkerFindings = findTauriNonceMarkerViolations(
    readFileSync('src-ui/index.html', 'utf8'),
  );
  const credentialFindings = findRendererCredentialBoundaryViolations((file) =>
    readFileSync(file, 'utf8'),
  );
  if (
    findings.length === 0 &&
    manifestFindings.length === 0 &&
    nativeOnlyGrantFindings.length === 0 &&
    cspFindings.length === 0 &&
    nonceMarkerFindings.length === 0 &&
    resourceFindings.length === 0 &&
    credentialFindings.length === 0
  ) {
    console.log(
      'OK: native access remains behind the adapter and Tauri webview permissions are minimal.',
    );
    return;
  }

  console.error('FAIL: native platform boundary violations:');
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line} ${finding.kind} (${finding.snippet})`,
    );
  }
  for (const finding of credentialFindings) console.error(`  ${finding}`);
  for (const finding of manifestFindings) {
    console.error(`  ${TAURI_CAPABILITY_MANIFEST}: ${finding}`);
  }
  for (const finding of nativeOnlyGrantFindings) console.error(`  ${finding}`);
  for (const finding of cspFindings) {
    console.error(`  src-desktop/tauri.conf.json: ${finding}`);
  }
  for (const finding of nonceMarkerFindings) {
    console.error(`  src-ui/index.html: ${finding}`);
  }
  for (const finding of resourceFindings) {
    console.error(`  ${finding}`);
  }
  process.exitCode = 1;
}

if (invokedDirectly(import.meta.url)) main();
