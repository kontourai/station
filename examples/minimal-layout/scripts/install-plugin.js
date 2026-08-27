#!/usr/bin/env node

/**
 * Plugin Installation Script
 *
 * Copies the built plugin to the core app's workspaces directory.
 * Runs automatically after `npm install`.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pluginName = 'minimal-workspace';
const sourceDir = join(__dirname, '../dist');
const pluginJsonPath = join(__dirname, '../plugin.json');

// Find the core app directory (3 levels up from node_modules)
const targetBaseDir = join(__dirname, '../../../src-ui/src/workspaces');
const targetDir = join(targetBaseDir, pluginName);

try {
  // Check if source directory exists
  if (!existsSync(sourceDir)) {
    console.warn(`⚠️  Plugin not built yet. Run 'npm run build' first.`);
    process.exit(0);
  }

  // Create target directory if it doesn't exist
  if (!existsSync(targetBaseDir)) {
    mkdirSync(targetBaseDir, { recursive: true });
  }

  // Copy plugin files
  console.log(`📦 Installing ${pluginName} plugin...`);

  cpSync(sourceDir, targetDir, { recursive: true });
  cpSync(pluginJsonPath, join(targetDir, 'plugin.json'));

  console.log(`✅ Installed ${pluginName} to ${targetDir}`);
} catch (error) {
  console.error(`❌ Failed to install plugin:`, error.message);
  process.exit(1);
}
