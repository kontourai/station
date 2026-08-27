#!/usr/bin/env node
// Compile the native shell for its mobile targets.
//
// #919: `verify:desktop-rust` runs `cargo test`, which compiles for the host
// only. That makes a `cfg(mobile)` mistake *structurally invisible* to the
// whole local suite — not "slipped through", but unobservable. Two shipped
// this way: #908's credential vault took `AppHandle` imported under
// `#[cfg(not(mobile))]`, so it never compiled for the platforms it exists for;
// and `tauri-plugin-notification` sat in a not-android/not-ios dependency
// table, so a mobile notification plugin was not a dependency on mobile.
// Both were caught by the first real `tauri android build` and nothing else.
//
// `cargo check` is the cheap 90%: it type-checks every cfg path for the target
// without linking or packaging.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: the latter does not percent-decode, so a
// checkout under a path containing a space resolves to `.../s1083%20space/` and
// every `cargo check` fails with a false RED blaming the mobile build. That is
// reachable in this repo today — the dogfood release checkouts live under
// `~/Library/Application Support/Station Dogfood/releases/<sha>` — and on
// Windows `.pathname` yields `/C:/...`, which is not a valid cwd at all.
const DESKTOP_DIR = fileURLToPath(new URL('../src-desktop/', import.meta.url));

function installedTargets() {
  try {
    return execFileSync('rustup', ['target', 'list', '--installed'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The NDK supplies the C compiler that native build scripts (ring) need. */
function findNdk() {
  if (
    process.env.ANDROID_NDK_HOME &&
    existsSync(process.env.ANDROID_NDK_HOME)
  ) {
    return process.env.ANDROID_NDK_HOME;
  }
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.HOME ?? '', 'Library/Android/sdk'),
    join(process.env.HOME ?? '', 'Android/Sdk'),
  ].filter(Boolean);
  for (const root of roots) {
    const ndkRoot = join(root, 'ndk');
    if (!existsSync(ndkRoot)) continue;
    // Highest version present, compared numerically so 27 beats 9.
    const versions = readdirSync(ndkRoot).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    if (versions.length) return join(ndkRoot, versions.at(-1));
  }
  return null;
}

function androidEnv(ndk) {
  // The prebuilt directory is named darwin-x86_64 even on Apple silicon.
  const hostTag =
    process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
  const bin = join(ndk, 'toolchains/llvm/prebuilt', hostTag, 'bin');
  if (!existsSync(bin)) return null;
  return {
    ...process.env,
    ANDROID_NDK_HOME: ndk,
    PATH: `${bin}:${process.env.PATH}`,
    CC_aarch64_linux_android: 'aarch64-linux-android24-clang',
    AR_aarch64_linux_android: 'llvm-ar',
  };
}

function check(target, env) {
  process.stdout.write(`  cargo check --target ${target} ... `);
  try {
    execFileSync('cargo', ['check', '--quiet', '--target', target], {
      cwd: DESKTOP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    process.stdout.write('ok\n');
    return true;
  } catch (error) {
    // A spawn-level failure is not a compile failure, and must not be reported
    // as one. On ENOENT (`cargo` absent from PATH, or an unusable cwd) node
    // leaves stderr/stdout undefined, so the old branch printed NOTHING and the
    // summary still said "mobile compilation broken" — a confident accusation
    // against the code with no evidence attached, which is the exact failure
    // mode this gate exists to remove, pointed at its own operator.
    if (error.code === 'ENOENT') {
      process.stdout.write(`SKIPPED (${error.message})\n`);
      return null;
    }
    process.stdout.write('FAILED\n');
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim();
    // Always surface something. A cargo failure writes stderr; anything else
    // (a lockfile, a permissions error) must still say what happened.
    console.error(`\n${detail || error.message}\n`);
    return false;
  }
}

const targets = installedTargets();
const failures = [];
const skipped = [];

console.log(
  'Mobile compile check (#919): the local suite is host-only otherwise.',
);

// Android
const androidTarget = 'aarch64-linux-android';
if (!targets.includes(androidTarget)) {
  skipped.push(
    `${androidTarget} (target not installed: rustup target add ${androidTarget})`,
  );
} else {
  const ndk = findNdk();
  const env = ndk ? androidEnv(ndk) : null;
  if (!env) {
    skipped.push(
      `${androidTarget} (no Android NDK found; set ANDROID_NDK_HOME)`,
    );
  } else {
    // `check` returns null for a spawn-level failure — an unusable toolchain is
    // an unchecked target, not a broken build.
    const result = check(androidTarget, env);
    if (result === null) skipped.push(`${androidTarget} (toolchain unusable)`);
    else if (!result) failures.push(androidTarget);
  }
}

// iOS — device target, and only where it can exist.
const iosTarget = 'aarch64-apple-ios';
if (process.platform !== 'darwin') {
  skipped.push(`${iosTarget} (needs macOS)`);
} else if (!targets.includes(iosTarget)) {
  skipped.push(
    `${iosTarget} (target not installed: rustup target add ${iosTarget})`,
  );
} else {
  const result = check(iosTarget, process.env);
  if (result === null) skipped.push(`${iosTarget} (toolchain unusable)`);
  else if (!result) failures.push(iosTarget);
}

// Say what was not checked, loudly. A gate that skips quietly reproduces the
// exact problem #919 is about: green output that never looked at the code.
for (const note of skipped) console.log(`  SKIPPED: ${note}`);

if (failures.length) {
  console.error(
    `\nFAIL: mobile compilation broken for: ${failures.join(', ')}`,
  );
  process.exit(1);
}
if (skipped.length && !failures.length) {
  console.log(
    `\nOK for what ran — ${skipped.length} target(s) NOT checked (see SKIPPED above).`,
  );
} else {
  console.log('\nOK: the native shell compiles for its mobile targets.');
}
