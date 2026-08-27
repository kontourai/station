import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PRODUCT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CARGO_PACKAGE_VERSION =
  /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const ROOT_CARGO_PACKAGE = 'station';
const CARGO_LOCK_VERSION = /(^version\s*=\s*")([^"]+)(")/gm;

export function assertProductVersion(version) {
  if (typeof version !== 'string' || !PRODUCT_VERSION.test(version)) {
    throw new Error(
      `Product version must be MAJOR.MINOR.PATCH, received ${String(version)}`,
    );
  }
  return version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cargoVersion(source) {
  const match = CARGO_PACKAGE_VERSION.exec(source);
  if (!match) throw new Error('Cargo.toml is missing [package].version');
  return match[2];
}

function cargoLockPackage(source, name = ROOT_CARGO_PACKAGE) {
  const starts = [...source.matchAll(/^\[\[package\]\]\s*$/gm)].map(
    (match) => match.index,
  );
  const packages = starts.map((start, index) => ({
    start,
    source: source.slice(start, starts[index + 1]),
  }));
  const named = packages.filter((entry) =>
    new RegExp(`^name\\s*=\\s*"${name}"\\s*$`, 'm').test(entry.source),
  );
  if (named.length !== 1) {
    throw new Error(
      `Cargo.lock must contain exactly one [[package]] name = "${name}"`,
    );
  }
  const versionMatches = [...named[0].source.matchAll(CARGO_LOCK_VERSION)];
  if (versionMatches.length !== 1) {
    throw new Error(
      `Cargo.lock [[package]] name = "${name}" must contain exactly one version`,
    );
  }
  return { ...named[0], version: versionMatches[0][2] };
}

/** Reads root release authority plus the checked-in native mirrors. */
export function productVersionState(root = process.cwd()) {
  const packagePath = resolve(root, 'package.json');
  const tauriPath = resolve(root, 'src-desktop/tauri.conf.json');
  const cargoPath = resolve(root, 'src-desktop/Cargo.toml');
  const cargoLockPath = resolve(root, 'src-desktop/Cargo.lock');
  const packageJson = readJson(packagePath);
  const tauri = readJson(tauriPath);
  const tauriSource = readFileSync(tauriPath, 'utf8');
  const cargoSource = readFileSync(cargoPath, 'utf8');
  const cargoLockSource = readFileSync(cargoLockPath, 'utf8');
  const version = assertProductVersion(packageJson.version);
  const rootCargoLockPackage = cargoLockPackage(cargoLockSource);
  return {
    version,
    packagePath,
    tauriPath,
    cargoPath,
    cargoLockPath,
    tauri,
    tauriSource,
    cargoSource,
    cargoLockSource,
    tauriVersion: tauri.version,
    cargoVersion: cargoVersion(cargoSource),
    cargoLockPackage: rootCargoLockPackage,
    cargoLockVersion: rootCargoLockPackage.version,
  };
}

export function productVersionMismatches(state) {
  const mismatches = [];
  if (state.tauriVersion !== state.version) {
    mismatches.push(
      `src-desktop/tauri.conf.json version ${String(state.tauriVersion)} does not match package.json version ${state.version}`,
    );
  }
  if (state.cargoVersion !== state.version) {
    mismatches.push(
      `src-desktop/Cargo.toml package version ${state.cargoVersion} does not match package.json version ${state.version}`,
    );
  }
  if (state.cargoLockVersion !== state.version) {
    mismatches.push(
      `src-desktop/Cargo.lock ${ROOT_CARGO_PACKAGE} package version ${state.cargoLockVersion} does not match package.json version ${state.version}`,
    );
  }
  return mismatches;
}

export function checkProductVersion(root = process.cwd()) {
  const state = productVersionState(root);
  const mismatches = productVersionMismatches(state);
  if (mismatches.length) {
    throw new Error(
      `Native product version is out of sync:\n${mismatches.map((line) => `- ${line}`).join('\n')}\nRun \`npm run product-version:sync\` after changing package.json.`,
    );
  }
  return state.version;
}

export function syncProductVersion(root = process.cwd()) {
  const state = productVersionState(root);
  if (state.tauriVersion !== state.version) {
    state.tauri.version = state.version;
    writeFileSync(state.tauriPath, `${JSON.stringify(state.tauri, null, 2)}\n`);
  }
  if (state.cargoVersion !== state.version) {
    writeFileSync(
      state.cargoPath,
      state.cargoSource.replace(CARGO_PACKAGE_VERSION, `$1${state.version}$3`),
    );
  }
  if (state.cargoLockVersion !== state.version) {
    const lockPackage = state.cargoLockPackage;
    const replacement = lockPackage.source.replace(
      CARGO_LOCK_VERSION,
      `$1${state.version}$3`,
    );
    writeFileSync(
      state.cargoLockPath,
      `${state.cargoLockSource.slice(0, lockPackage.start)}${replacement}${state.cargoLockSource.slice(lockPackage.start + lockPackage.source.length)}`,
    );
  }
  return checkProductVersion(root);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--sync'].includes(args[0])) {
    throw new Error('Usage: product-version.mjs --check|--sync');
  }
  const version =
    args[0] === '--sync' ? syncProductVersion() : checkProductVersion();
  console.log(`Product version ${version} is synchronized.`);
}
