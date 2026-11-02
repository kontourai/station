/**
 * #4403: controls and labels are at least 12px; 11px is only for secondary
 * metadata such as timestamps and counts. This proves the stylesheet rule
 * (every declared size, and the legacy size tokens); the rendered sizes of the
 * audited chrome are measured in `minimum-text-size.browser.test.tsx`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/** Sizes that are not text a person reads as a label, or that another change owns. */
const BELOW_FLOOR_EXCEPTIONS: Readonly<Record<string, string>> = {
  'index.css .loading-dots': 'the animated dots are decoration, not text',
  'components/icons/BrandIcon.css .brand-icon__glyph--text':
    'scales with the icon it is drawn in',
  'components/icons/BrandIcon.css .brand-icon__initials':
    'scales with the icon it is drawn in',
  'components/coding-layout/DiffPanel.css .diff-file-collapse-toggle__icon':
    'a disclosure glyph inside a labelled button, not text',
  'components/status/StatusGlyph.css .status-glyph':
    'a status glyph beside its label, not text',
  'views/task-workspace/review/TaskReviewLayout.css .review-avatar .task-room-avatar':
    'initials sized to the avatar circle they fill',
  'workspace-panes/device/DeviceToolsDrawer.css .device-ax-overlay__label':
    'labels a device screenshot overlay at the device scale',
  'workspace-panes/browser-pane/BrowserPane.css .browser-pane__badge-count':
    'owned by the open browser-experience change (#4442)',
};
const ELEVEN_PX_FILES_OWNED_ELSEWHERE = new Set([
  'workspace-panes/browser-pane/BrowserPane.css',
]);

const METADATA =
  /(\btime\b|[-_]time\b|stamp|__date\b|__ago\b|elapsed|duration|[-_]count\b|__counts\b|axis\b|__usage\b|__size\b|__bytes\b|notification-badge|more-badge|attachment-btn__badge)/i;

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cssFiles(path, out);
    else if (name.endsWith('.css')) out.push(path);
  }
  return out;
}

function tokenSizes(): Record<string, number> {
  const tokens = readFileSync(join(SRC, 'tokens.css'), 'utf8');
  const sizes: Record<string, number> = { '--k-text-xs': 11 };
  for (const match of tokens.matchAll(/(--text-[a-z0-9]+):\s*(\d+)px/g))
    sizes[match[1]] = Number(match[2]);
  return sizes;
}

function declaredSize(value: string, tokens: Record<string, number>) {
  const v = value.trim();
  const token = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (token) return tokens[token[1]] ?? null;
  const px = /^(\d*\.?\d+)px$/.exec(v);
  if (px) return Number(px[1]);
  const rem = /^(\d*\.?\d+)rem$/.exec(v);
  if (rem) return Number(rem[1]) * 16;
  const floor = /max\(.*,\s*(\d+)px\)$/.exec(v);
  return floor ? Number(floor[1]) : null;
}

function declarations() {
  const tokens = tokenSizes();
  const found: { at: string; key: string; size: number; selector: string }[] =
    [];
  for (const file of cssFiles(SRC)) {
    const name = relative(SRC, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) =>
      c.replace(/[^\n]/g, ' '),
    );
    const stack: string[] = [];
    let pending = '';
    let line = 1;
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      if (ch === '\n') line += 1;
      if (ch === '{') {
        stack.push(pending.trim());
        pending = '';
      } else if (ch === '}') {
        stack.pop();
        pending = '';
      } else if (ch === ';') {
        const match = /font-size:\s*([^;]+)$/.exec(pending.trim());
        if (match) {
          const size = declaredSize(match[1], tokens);
          const selector = (stack.at(-1) ?? '').replace(/\s+/g, ' ');
          if (size !== null)
            found.push({
              at: `${name}:${line}`,
              key: `${name} ${selector}`,
              size,
              selector,
            });
        }
        pending = '';
      } else pending += ch;
    }
  }
  return found;
}

describe('minimum text size (#4403)', () => {
  test('the legacy size tokens keep labels at 12px and metadata at 11px', () => {
    const tokens = tokenSizes();
    expect(tokens['--text-2xs']).toBeGreaterThanOrEqual(11);
    expect(tokens['--text-xs']).toBeGreaterThanOrEqual(12);
    expect(tokens['--text-sm']).toBeGreaterThanOrEqual(12);
  });

  test('no stylesheet declares text under 11px', () => {
    const under = declarations()
      .filter((entry) => entry.size < 11)
      .filter((entry) => !(entry.key in BELOW_FLOOR_EXCEPTIONS))
      .map((entry) => `${entry.at} ${entry.selector} (${entry.size}px)`);
    expect(under).toEqual([]);
  });

  test('11px is only for metadata: times, counts, sizes and axis ticks', () => {
    const labels = declarations()
      .filter((entry) => entry.size >= 11 && entry.size < 12)
      .filter(
        (entry) =>
          !ELEVEN_PX_FILES_OWNED_ELSEWHERE.has(entry.key.split(' ')[0]) &&
          !(entry.key in BELOW_FLOOR_EXCEPTIONS),
      )
      .filter(
        (entry) =>
          /field|label/.test(entry.selector) ||
          !entry.selector.split(',').every((part) => METADATA.test(part)),
      )
      .map((entry) => `${entry.at} ${entry.selector} (${entry.size}px)`);
    expect(labels).toEqual([]);
  });
});
