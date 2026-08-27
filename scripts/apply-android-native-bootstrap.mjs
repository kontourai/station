#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_ANDROID = join('src-desktop', 'gen', 'android', 'app');
const KEYRING_BRIDGE = `package io.crates.keyring

import android.content.Context

class Keyring private constructor() {
  companion object {
    init {
      System.loadLibrary("station_ai_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
`;

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

export function activityWithNativeCredentialBootstrap(source, packageName) {
  const initialize = 'Keyring.initializeNdkContext(applicationContext)';
  if (source.includes(initialize)) return source;

  let next = addImport(source, packageName, 'io.crates.keyring.Keyring');
  if (next.includes('override fun onCreate(savedInstanceState: Bundle?)')) {
    if (!next.includes('super.onCreate(savedInstanceState)')) {
      throw new Error(
        'MainActivity onCreate does not call Tauri super.onCreate.',
      );
    }
    return next.replace(
      'super.onCreate(savedInstanceState)',
      `${initialize}\n    super.onCreate(savedInstanceState)`,
    );
  }

  next = addImport(next, packageName, 'android.os.Bundle');
  const body = `class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    ${initialize}
    super.onCreate(savedInstanceState)
  }
}`;
  if (/class MainActivity\s*:\s*TauriActivity\(\)\s*\{\s*\}/.test(next)) {
    return next.replace(
      /class MainActivity\s*:\s*TauriActivity\(\)\s*\{\s*\}/,
      body,
    );
  }
  if (/class MainActivity\s*:\s*TauriActivity\(\)\s*$/.test(next)) {
    return next.replace(/class MainActivity\s*:\s*TauriActivity\(\)\s*$/, body);
  }
  throw new Error(
    'Unsupported generated MainActivity shape; refusing an unsafe bootstrap edit.',
  );
}

export function applyAndroidNativeBootstrap({ root = ROOT } = {}) {
  const appRoot = join(root, GENERATED_ANDROID);
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
  const next = activityWithNativeCredentialBootstrap(current, namespace);
  if (next !== current) writeFileSync(activityPath, next);

  const bridgePath = join(javaRoot, 'io', 'crates', 'keyring', 'Keyring.kt');
  if (existsSync(bridgePath)) {
    const bridge = readFileSync(bridgePath, 'utf8');
    for (const required of [
      'package io.crates.keyring',
      'System.loadLibrary("station_ai_lib")',
      'external fun initializeNdkContext(context: Context)',
    ]) {
      if (!bridge.includes(required)) {
        throw new Error(
          `Existing Android keyring bridge is missing ${required}.`,
        );
      }
    }
  } else {
    mkdirSync(dirname(bridgePath), { recursive: true });
    writeFileSync(bridgePath, KEYRING_BRIDGE);
  }

  return { namespace, activityPath, bridgePath };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = applyAndroidNativeBootstrap();
  console.log(
    `Android native credential bootstrap applied to ${result.namespace}.`,
  );
}
