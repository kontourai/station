import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const install = 'StationAndroidInsetsBridge.install(webView, this)';

export function activityWithAndroidInsets(source) {
  let next = source;
  // Migrate the previous checked-in bridge, whose system-bar-only snapshot
  // could not report IME overlap. Keep unrelated activity behavior intact.
  if (next.includes('private var safeAreaJson')) {
    const legacy =
      / {2}\/\/ Android's WebView[\s\S]*? {2}private var safeAreaJson = [^\n]*\n\n/;
    const callback =
      / {2}override fun onWebViewCreate\(webView: WebView\) \{[\s\S]*?\n {2}\}\n/;
    const bridge =
      / {2}private inner class SafeAreaBridge \{\n {4}@JavascriptInterface\n {4}fun safeArea\(\): String = safeAreaJson\n {2}\}\n/;
    // Only replace the exact prior owned callback (whitespace-insensitive).
    // A customized callback must be reviewed, never silently discarded.
    const prior = callback.exec(next)?.[0];
    if (
      !legacy.test(next) ||
      !prior ||
      !bridge.test(next) ||
      createHash('sha256')
        .update(prior.replace(/\s+/g, ' ').trim())
        .digest('hex') !==
        '63083fc467c5ae0d85ce8af10fd5bf89b29198991b1107a93852f989c169e57b'
    )
      throw new Error('Unrecognized legacy Android inset bridge.');
    next = next.replace(legacy, '').replace(callback, '').replace(bridge, '');
    for (const name of [
      'android.webkit.JavascriptInterface',
      'androidx.core.view.ViewCompat',
      'androidx.core.view.WindowInsetsCompat',
    ])
      next = next.replace(`import ${name}\n`, '');
  }
  if (!next.includes('import android.webkit.WebView')) {
    next = next.replace(
      /^(package [^\n]+\n)/,
      '$1\nimport android.webkit.WebView\n',
    );
  }
  if (next.includes(install)) return next;
  const callback = /override fun onWebViewCreate\(webView: WebView\) \{/g;
  const matches = [...next.matchAll(callback)];
  if (matches.length > 1)
    throw new Error('Ambiguous Android WebView callback.');
  if (matches.length === 1) return next.replace(callback, `$&\n    ${install}`);
  const activity = /class MainActivity\s*:\s*TauriActivity\(\)\s*\{/g;
  if ([...next.matchAll(activity)].length !== 1)
    throw new Error('Expected one Android MainActivity.');
  return next.replace(
    activity,
    `$&\n  override fun onWebViewCreate(webView: WebView) {\n    ${install}\n  }\n`,
  );
}

export function applyAndroidInsets(activityPath, namespace) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(namespace))
    throw new Error('Invalid Android inset namespace.');
  const current = readFileSync(activityPath, 'utf8');
  if (!current.startsWith(`package ${namespace}\n`))
    throw new Error('Android inset activity namespace mismatch.');
  const next = activityWithAndroidInsets(current);
  const template = readFileSync(
    join(
      import.meta.dirname,
      '../templates/android/StationAndroidInsetsBridge.kt',
    ),
    'utf8',
  );
  if (template.split('__STATION_NAMESPACE__').length !== 2)
    throw new Error('Invalid Android inset template.');
  writeFileSync(
    join(dirname(activityPath), 'StationAndroidInsetsBridge.kt'),
    template.replace('__STATION_NAMESPACE__', namespace),
  );
  if (next !== current) writeFileSync(activityPath, next);
}

import { createHash } from 'node:crypto';
