import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeDevPairingDeepLinkSuffix,
  pairingSchemeForChannel,
  readChannelPlatformMatrix,
} from './channel-platform-matrix.mjs';

const root = resolve(import.meta.dirname, '..');
const marker = '<!-- DEEP LINK PLUGIN. AUTO-GENERATED. DO NOT REMOVE. -->';

function androidPairingScheme(channel) {
  // The default Android debug identifier has no per-worktree suffix, matching
  // the native runtime's generated fallback. Desktop dev supplies its suffix.
  if (channel === 'dev')
    return `station-dev-${normalizeDevPairingDeepLinkSuffix('instance')}`;
  return pairingSchemeForChannel(readChannelPlatformMatrix(), channel);
}

export function manifestWithAndroidPairingScheme(source, channel) {
  const scheme = androidPairingScheme(channel);
  const activities = [
    ...source.matchAll(
      /<activity\b[^>]*android:name="(?:\.?|[a-zA-Z0-9_.]+\.)MainActivity"[^>]*>[\s\S]*?<\/activity>/g,
    ),
  ];
  if (activities.length !== 1)
    throw new Error('Expected one generated Android MainActivity.');
  const activity = activities[0][0];
  const pieces = activity.split(marker);
  if (pieces.length !== 1 && pieces.length !== 3)
    throw new Error('Malformed generated deep-link markers.');
  const clean = pieces.length === 3 ? pieces[0] + pieces[2] : activity;
  if (/android:scheme="station-/.test(clean))
    throw new Error(
      'Unmanaged Station pairing intent filter; refusing to duplicate it.',
    );
  const block = `${marker}
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <action android:name="org.chromium.arc.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${scheme}" />
            </intent-filter>
            ${marker}`;
  const next = clean.replace(
    /\s*<\/activity>$/,
    `\n            ${block}\n        </activity>`,
  );
  return source.replace(activity, next);
}

export function applyAndroidPairingScheme(channel, options = {}) {
  const manifest = resolve(
    options.root ?? root,
    'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
  );
  const source = readFileSync(manifest, 'utf8');
  const next = manifestWithAndroidPairingScheme(source, channel);
  if (next !== source) writeFileSync(manifest, next);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  applyAndroidPairingScheme(process.argv[2]);
