import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const channels = ['stable', 'beta', 'nightly'];
const typescriptPath =
  'packages/connect/src/core/pairingDeepLinkChannels.generated.ts';
const rustPath = 'src-desktop/src/pairing_deep_link_channels_generated.rs';

export function readChannelPlatformMatrix(rootDir = root) {
  return JSON.parse(
    readFileSync(
      resolve(rootDir, 'config/channel-platform-matrix.json'),
      'utf8',
    ),
  ).channels;
}
export function pairingSchemeForChannel(matrix, channel) {
  const scheme = matrix[channel]?.pairingDeepLinkScheme;
  if (
    typeof scheme !== 'string' ||
    !/^station-(stable|beta|nightly)$/.test(scheme)
  )
    throw new Error(`Channel ${channel} has no valid release pairing scheme.`);
  return scheme;
}
export function normalizeDevPairingDeepLinkSuffix(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}
export function devPairingDeepLinkScheme(instance) {
  return `station-dev-${normalizeDevPairingDeepLinkSuffix(instance)}`;
}

export function renderPairingDeepLinkTypeScript(matrix) {
  const entries = channels
    .map(
      (channel) =>
        `  ${channel}: '${pairingSchemeForChannel(matrix, channel)}',`,
    )
    .join('\n');
  return `// Generated from config/channel-platform-matrix.json by scripts/channel-platform-matrix.mjs.\nexport const RELEASE_PAIRING_DEEP_LINK_SCHEMES = {\n${entries}\n} as const;\n\n/** Normalizes the native bundle suffix and custom-scheme suffix identically. */\nexport function normalizeDevPairingDeepLinkSuffix(value: string): string {\n  return (\n    value\n      .toLowerCase()\n      .replace(/[^a-z0-9]+/g, '-')\n      .replace(/-+/g, '-')\n      .replace(/^-+|-+$/g, '') || 'instance'\n  );\n}\n\nexport function devPairingDeepLinkScheme(instance: string): string {\n  return \`station-dev-\${normalizeDevPairingDeepLinkSuffix(instance)}\`;\n}\n`;
}
export function renderPairingDeepLinkRust(matrix) {
  const stable = pairingSchemeForChannel(matrix, 'stable');
  const beta = pairingSchemeForChannel(matrix, 'beta');
  const nightly = pairingSchemeForChannel(matrix, 'nightly');
  return `// Generated from config/channel-platform-matrix.json by scripts/channel-platform-matrix.mjs.\npub fn normalize_dev_pairing_deep_link_suffix(value: &str) -> String {\n    let mut output = String::new();\n    for character in value.chars().flat_map(char::to_lowercase) {\n        if character.is_ascii_alphanumeric() {\n            output.push(character);\n        } else if !output.is_empty() && !output.ends_with('-') {\n            output.push('-');\n        }\n    }\n    let output = output.trim_end_matches('-').to_string();\n    if output.is_empty() {\n        "instance".to_string()\n    } else {\n        output\n    }\n}\n\npub fn native_pairing_deep_link_scheme(identifier: &str, dev_build: bool, channel: &str) -> String {\n    if dev_build {\n        let suffix = identifier\n            .strip_prefix("io.kontourai.station.dev.")\n            .unwrap_or("instance");\n        return format!(\n            "station-dev-{}",\n            normalize_dev_pairing_deep_link_suffix(suffix)\n        );\n    }\n    match channel {\n        "beta" => "${beta}".to_string(),\n        "nightly" => "${nightly}".to_string(),\n        _ => "${stable}".to_string(),\n    }\n}\n`;
}
export function generatedChannelPlatformOutputs(matrix) {
  return new Map([
    [typescriptPath, renderPairingDeepLinkTypeScript(matrix)],
    [rustPath, renderPairingDeepLinkRust(matrix)],
  ]);
}
export function checkChannelPlatformMatrix(rootDir = root) {
  const matrix = readChannelPlatformMatrix(rootDir);
  const drift = [];
  for (const [path, expected] of generatedChannelPlatformOutputs(matrix))
    if (readFileSync(resolve(rootDir, path), 'utf8') !== expected)
      drift.push(path);
  for (const channel of channels) {
    const config =
      channel === 'stable' ? 'tauri.conf.json' : `tauri.${channel}.conf.json`;
    const parsed = JSON.parse(
      readFileSync(resolve(rootDir, 'src-desktop', config), 'utf8'),
    );
    const expected = pairingSchemeForChannel(matrix, channel);
    if (
      parsed.plugins?.['deep-link']?.desktop?.schemes?.[0] !== expected ||
      parsed.plugins?.['deep-link']?.mobile?.[0]?.scheme?.[0] !== expected
    )
      drift.push(`src-desktop/${config}`);
  }
  return drift;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const matrix = readChannelPlatformMatrix();
  const drift = checkChannelPlatformMatrix();
  if (process.argv.includes('--check')) {
    if (drift.length)
      throw new Error(`channel platform matrix drift: ${drift.join(', ')}`);
  } else
    for (const [path, contents] of generatedChannelPlatformOutputs(matrix))
      writeFileSync(resolve(root, path), contents);
}
