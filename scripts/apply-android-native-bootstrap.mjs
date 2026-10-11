#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAndroidInsets } from './lib/android-window-insets.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_ANDROID = join('src-desktop', 'gen', 'android', 'app');
// tao 0.37 (Tauri 2.12) initializes ndk_context from its own onCreate, and
// ndk_context asserts it is initialized exactly once. The activity used to
// initialize it first through android-native-keyring-store's JNI bridge, so
// every launch panicked inside Rust onCreate and aborted. The keyring store
// reads the context tao installs; nothing may initialize it again.
const LEGACY_CONTEXT_INIT = 'Keyring.initializeNdkContext(applicationContext)';
const LEGACY_CONTEXT_IMPORT = 'import io.crates.keyring.Keyring';

export function androidNamespace(buildGradle) {
  const matches = [...buildGradle.matchAll(/\bnamespace\s*=\s*"([^"]+)"/g)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Android namespace in generated build.gradle.kts; found ${matches.length}.`,
    );
  }
  const namespace = matches[0][1];
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(namespace)) {
    throw new Error(
      `Invalid generated Android namespace ${JSON.stringify(namespace)}.`,
    );
  }
  return namespace;
}

function addImport(source, packageName, imported) {
  if (source.includes(`import ${imported}`)) return source;
  const declaration = `package ${packageName}`;
  if (!source.startsWith(declaration)) {
    throw new Error(`MainActivity.kt does not declare package ${packageName}.`);
  }
  return source.replace(declaration, `${declaration}\n\nimport ${imported}`);
}

export function activityWithTauriOnCreate(source, packageName) {
  if (!source.startsWith(`package ${packageName}`)) {
    throw new Error(`MainActivity.kt does not declare package ${packageName}.`);
  }
  const next = source
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== LEGACY_CONTEXT_INIT &&
        line.trim() !== LEGACY_CONTEXT_IMPORT,
    )
    .join('\n');
  if (next.includes('initializeNdkContext')) {
    throw new Error(
      'MainActivity initializes ndk_context; tao owns that initialization.',
    );
  }
  if (next.includes('override fun onCreate(savedInstanceState: Bundle?)')) {
    if (!next.includes('super.onCreate(savedInstanceState)')) {
      throw new Error(
        'MainActivity onCreate does not call Tauri super.onCreate.',
      );
    }
    return next;
  }

  const withBundle = addImport(next, packageName, 'android.os.Bundle');
  const body = `class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }
}`;
  if (/class MainActivity\s*:\s*TauriActivity\(\)\s*\{\s*\}/.test(withBundle)) {
    return withBundle.replace(
      /class MainActivity\s*:\s*TauriActivity\(\)\s*\{\s*\}/,
      body,
    );
  }
  if (/class MainActivity\s*:\s*TauriActivity\(\)\s*$/.test(withBundle)) {
    return withBundle.replace(
      /class MainActivity\s*:\s*TauriActivity\(\)\s*$/,
      body,
    );
  }
  throw new Error(
    'Unsupported generated MainActivity shape; refusing an unsafe bootstrap edit.',
  );
}

/** Restore camera and voice declarations after Tauri regenerates AndroidManifest.xml. */
export function manifestWithMediaPermissions(source) {
  if (
    (source.match(/<manifest\b/g) ?? []).length !== 1 ||
    (source.match(/<application\b/g) ?? []).length !== 1
  ) {
    throw new Error('Expected one Android manifest and application element.');
  }
  let next = source;
  const declarations = [
    [
      'uses-permission',
      'android.permission.CAMERA',
      '<uses-permission android:name="android.permission.CAMERA" />',
    ],
    [
      'uses-permission',
      'android.permission.RECORD_AUDIO',
      '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    ],
    [
      'uses-permission',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
    ],
    [
      'uses-feature',
      'android.hardware.microphone',
      '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
    ],
    [
      'uses-feature',
      'android.hardware.camera.any',
      '<uses-feature android:name="android.hardware.camera.any" android:required="false" />',
    ],
  ];
  // CAMERA implies rear-camera and autofocus requirements in Play unless
  // each is explicitly optional; camera.any alone does not override them.
  for (const feature of [
    'android.hardware.camera',
    'android.hardware.camera.autofocus',
  ]) {
    declarations.push([
      'uses-feature',
      feature,
      `<uses-feature android:name="${feature}" android:required="false" />`,
    ]);
  }
  for (const [tag, name, declaration] of declarations) {
    const tags = next.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
    const matches = tags.filter((entry) =>
      new RegExp(`android:name=["']${name.replaceAll('.', '\\.')}["']`).test(
        entry,
      ),
    );
    if (matches.length > 1)
      throw new Error(`Duplicate Android declaration: ${name}`);
    if (matches.length === 0)
      next = next.replace(/<application\b/, `${declaration}\n    <application`);
    else if (
      tag === 'uses-permission' &&
      /android:maxSdkVersion|tools:node/.test(matches[0])
    ) {
      throw new Error(`${name} must not be restricted or removed.`);
    } else if (
      tag === 'uses-feature' &&
      !/android:required=["']false["']/.test(matches[0])
    ) {
      throw new Error(`${name} hardware must remain optional.`);
    }
  }
  return next;
}

function manifestWithBackupExclusions(source) {
  return source.replace(/<application\b[^>]*>/, (application) => {
    for (const [attribute, value] of [
      ['allowBackup', 'false'],
      ['fullBackupContent', 'false'],
      ['dataExtractionRules', '@xml/data_extraction_rules'],
    ]) {
      const pattern = new RegExp(
        `android:${attribute}\\s*=\\s*["'][^"']*["']`,
        'g',
      );
      const matches = application.match(pattern) ?? [];
      if (matches.length > 1)
        throw new Error(`Duplicate Android attribute: ${attribute}`);
      const declaration = `android:${attribute}="${value}"`;
      application = matches.length
        ? application.replace(pattern, declaration)
        : application.replace('<application', `<application ${declaration}`);
    }
    return application;
  });
}

export function applyAndroidNativeBootstrap({ root = ROOT } = {}) {
  const appRoot = join(root, GENERATED_ANDROID);
  const manifestPath = join(appRoot, 'src', 'main', 'AndroidManifest.xml');
  const manifest = readFileSync(manifestPath, 'utf8');
  const patchedManifest = manifestWithBackupExclusions(
    manifestWithMediaPermissions(manifest),
  );
  if (patchedManifest !== manifest)
    writeFileSync(manifestPath, patchedManifest);
  const extractionPath = join(
    appRoot,
    'src',
    'main',
    'res',
    'xml',
    'data_extraction_rules.xml',
  );
  const extractionRules = readFileSync(
    join(ROOT, 'scripts', 'templates', 'android', 'data_extraction_rules.xml'),
    'utf8',
  );
  mkdirSync(dirname(extractionPath), { recursive: true });
  if (
    !existsSync(extractionPath) ||
    readFileSync(extractionPath, 'utf8') !== extractionRules
  ) {
    writeFileSync(extractionPath, extractionRules);
  }
  const buildGradle = readFileSync(join(appRoot, 'build.gradle.kts'), 'utf8');
  const namespace = androidNamespace(buildGradle);
  const javaRoot = join(appRoot, 'src', 'main', 'java');
  const activityPath = join(
    javaRoot,
    ...namespace.split('.'),
    'MainActivity.kt',
  );
  if (!existsSync(activityPath)) {
    throw new Error(
      `Generated Android activity is missing for namespace ${namespace}: ${activityPath}`,
    );
  }
  const current = readFileSync(activityPath, 'utf8');
  const next = activityWithTauriOnCreate(current, namespace);
  if (next !== current) writeFileSync(activityPath, next);
  applyAndroidInsets(activityPath, namespace);

  // A bridge left by an earlier bootstrap would invite the double
  // initialization back; the generated project must not carry one.
  const bridgePath = join(javaRoot, 'io', 'crates', 'keyring', 'Keyring.kt');
  if (existsSync(bridgePath)) rmSync(bridgePath);

  return { namespace, activityPath };
}

if (invokedDirectly(import.meta.url)) {
  const result = applyAndroidNativeBootstrap();
  console.log(`Android native bootstrap applied to ${result.namespace}.`);
}
