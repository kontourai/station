#!/usr/bin/env node
// Static architecture ratchet for #809. React features may only touch the
// Tauri SDK inside the dedicated native platform adapter. This keeps host
// detection, commands, and events out of feature code and makes the web
// fallback deterministic.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const TAURI_CAPABILITY_MANIFEST =
  'src-desktop/capabilities/default.json';
// Split from the shared manifest above (#575): tauri-plugin-updater and
// tauri-plugin-process are desktop-only Cargo dependencies, so a shared
// manifest referencing their permissions fails ACL resolution outright on a
// mobile build — the plugins are not compiled there to define them. The
// `platforms` scope excludes android/iOS entirely rather than granting and
// leaving unreachable.
export const TAURI_DESKTOP_UPDATER_CAPABILITY_MANIFEST =
  'src-desktop/capabilities/desktop-updater.json';
export const EXPECTED_DESKTOP_UPDATER_PERMISSIONS = [
  'updater:allow-check',
  'updater:allow-download-and-install',
  'process:allow-restart',
];
export const EXPECTED_DESKTOP_UPDATER_PLATFORMS = ['macOS', 'windows', 'linux'];
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
};
export const EXPECTED_APPIMAGE_RUNTIME_FILES = {
  'usr/share/Station/dist-server': '../dist-server',
  'usr/share/Station/node_modules': '../dist-desktop-runtime/node_modules',
};
export const EXPECTED_APPIMAGE_REMOVED_RESOURCES = {
  '../dist-server': null,
  '../dist-desktop-runtime/node_modules': null,
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
  // Desktop self-update via the official Tauri plugins (station#575).
  'src-ui/src/platform/native/desktopUpdate.ts',
]);
export const TAURI_NONCE_MARKER_PATTERN =
  /<script\s+data-station-csp-nonce(?:="")?\s+nonce="__TAURI_SCRIPT_NONCE__"\s*><\/script>/;

export const TAURI_IMPORT_PATTERN = /['"]@tauri-apps\/api(?:\/[^'"]+)?['"]/g;
export const NATIVE_GLOBAL_PATTERN = /(?:window\.)?__(?:TAURI|SHARE_TEXT)__/g;

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
    if (TAURI_ADAPTER_FILES.has(file)) continue;
    const content = readFile(file);
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

/**
 * The desktop-updater capability manifest additionally needs the `platforms`
 * scope pinned: dropping it grants the permissions on every target, which
 * fails mobile ACL resolution the same way a shared manifest entry would
 * (the plugins are not compiled there — see the manifest constant's comment).
 */
export function findDesktopUpdaterCapabilityViolations(content) {
  const violations = findCapabilityManifestViolations(
    content,
    EXPECTED_DESKTOP_UPDATER_PERMISSIONS,
  );
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return violations;
  }
  if (
    !Array.isArray(manifest.platforms) ||
    manifest.platforms.length !== EXPECTED_DESKTOP_UPDATER_PLATFORMS.length ||
    !EXPECTED_DESKTOP_UPDATER_PLATFORMS.every(
      (platform, index) => manifest.platforms[index] === platform,
    )
  ) {
    violations.push(
      `${TAURI_DESKTOP_UPDATER_CAPABILITY_MANIFEST} platforms must be exactly ${EXPECTED_DESKTOP_UPDATER_PLATFORMS.join(', ')}`,
    );
  }
  return violations;
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
      `${appImageFile} must delete only the inherited server and raw node_modules resources`,
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
    execFileSync('git', ['ls-files', 'src-ui/src'], {
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
  const desktopUpdaterManifestFindings = findDesktopUpdaterCapabilityViolations(
    readFileSync(TAURI_DESKTOP_UPDATER_CAPABILITY_MANIFEST, 'utf8'),
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
    desktopUpdaterManifestFindings.length === 0 &&
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
  for (const finding of desktopUpdaterManifestFindings) {
    console.error(`  ${TAURI_DESKTOP_UPDATER_CAPABILITY_MANIFEST}: ${finding}`);
  }
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

if (import.meta.url === `file://${process.argv[1]}`) main();
