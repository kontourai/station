#!/usr/bin/env node

// Capture: node scripts/region-grid-parity.mjs --css <stylesheet> --out <json> [--legacy-parent]
// Compare: node scripts/region-grid-parity.mjs --diff <before.json> <after.json>

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// A three-track grid legitimately changes these while every rectangle stays identical.
const STRUCTURAL_GRID_PROPERTIES = [
  'grid-template-columns',
  'grid-column',
  'grid-column-start',
  'grid-column-end',
  'grid-template-rows',
  'grid-row',
  'grid-row-start',
  'grid-row-end',
];

const DECLARED_PROPERTIES = [
  'align-items',
  'border-bottom',
  'border-left',
  'border-right',
  'border-top',
  'bottom',
  'box-shadow',
  'cursor',
  'display',
  'flex',
  'flex-direction',
  'flex-wrap',
  'font-size',
  'gap',
  'grid-column',
  'grid-row',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'justify-content',
  'left',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'overflow',
  'overflow-wrap',
  'overflow-x',
  'overflow-y',
  'padding',
  'padding-bottom',
  'position',
  'right',
  'text-orientation',
  'top',
  'width',
  'word-break',
  'writing-mode',
  'z-index',
];
const PROPERTIES = DECLARED_PROPERTIES.filter(
  (property) => !STRUCTURAL_GRID_PROPERTIES.includes(property),
);

const PLACEMENTS = ['left', 'right', 'bottom'];
const STATES = ['open', 'collapsed', 'maximized'];
const VIEWPORTS = [
  { id: 'desktop', width: 1280, height: 800, coarse: false },
  { id: 'coarse-landscape', width: 844, height: 390, coarse: true },
  { id: 'phone', width: 390, height: 844, coarse: true },
];

function usage() {
  return 'Usage: region-grid-parity.mjs --css <stylesheet> --out <json> [--legacy-parent]\n       region-grid-parity.mjs --diff <before.json> <after.json>';
}

function parseArgs(argv) {
  const args = { legacyParent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--legacy-parent') args.legacyParent = true;
    else if (arg === '--css') args.css = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--diff') {
      args.before = argv[++index];
      args.after = argv[++index];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function differences(before, after, trail = '') {
  if (Object.is(before, after)) return [];
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object'
  ) {
    return [`${trail}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
  }
  const keys = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort();
  return keys.flatMap((key) =>
    differences(before[key], after[key], trail ? `${trail}.${key}` : key),
  );
}

async function diffFiles(beforePath, afterPath) {
  const [before, after] = await Promise.all([
    readFile(beforePath, 'utf8').then(JSON.parse),
    readFile(afterPath, 'utf8').then(JSON.parse),
  ]);
  const found = differences(before.cases, after.cases);
  if (found.length === 0) {
    process.stdout.write('No differences.\n');
    return;
  }
  process.stdout.write(`${found.join('\n')}\n`);
  process.exitCode = 1;
}

async function capture({ css: cssPath, out, legacyParent }) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/region-grid-skeleton.html',
  );
  const css = await readFile(cssPath, 'utf8');
  const browser = await chromium.launch();
  const cases = {};

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.coarse,
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(fixturePath).href);
      await page.addStyleTag({ content: css });
      await page.addStyleTag({
        content:
          '*, *::before, *::after { transition: none !important; animation: none !important; }',
      });

      for (const placement of PLACEMENTS) {
        for (const state of STATES) {
          const fold = viewport.coarse ? 'bottom' : placement;
          const key = `${viewport.id}/${placement}/${state}`;
          await page.evaluate(
            ({ fold, legacyParent, placement, state }) => {
              const main = document.querySelector('.app__main');
              const dock = document.querySelector('.chat-dock');
              if (
                !(main instanceof HTMLElement) ||
                !(dock instanceof HTMLElement)
              ) {
                throw new Error('Parity fixture is missing its main or dock');
              }
              document.documentElement.style.setProperty(
                '--chat-dock-width',
                '400px',
              );
              document.documentElement.style.setProperty(
                '--dock-slot-size',
                state === 'collapsed' ? '38px' : '320px',
              );
              main.className = `app__main${legacyParent ? ` app__main--dock-${fold}` : ''}`;
              dock.className = `chat-dock chat-dock--${fold}${
                state === 'open' ? '' : ` is-${state}`
              }`;
              dock.dataset.region = placement;
              const handle = dock.querySelector('.chat-dock__resize-handle');
              handle?.classList.toggle(
                'chat-dock__resize-handle--left',
                fold === 'left',
              );
            },
            { fold, legacyParent, placement, state },
          );
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          cases[key] = await page.evaluate(
            (properties) =>
              Object.fromEntries(
                [...document.querySelectorAll('[data-parity]')]
                  .sort((left, right) =>
                    left.dataset.parity.localeCompare(right.dataset.parity),
                  )
                  .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const computed = getComputedStyle(element);
                    return [
                      element.dataset.parity,
                      {
                        rect: {
                          height: rect.height,
                          width: rect.width,
                          x: rect.x,
                          y: rect.y,
                        },
                        style: Object.fromEntries(
                          properties.map((property) => [
                            property,
                            computed.getPropertyValue(property),
                          ]),
                        ),
                      },
                    ];
                  }),
              ),
            PROPERTIES,
          );
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const elementCount = Object.keys(Object.values(cases)[0] ?? {}).length;
  const output = stable({
    cases,
    inventory: { elements: elementCount, properties: PROPERTIES.length },
  });
  await writeFile(out, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(
    `Captured ${Object.keys(cases).length} cases, ${elementCount} elements, ${PROPERTIES.length} properties.\n`,
  );
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.before || args.after) {
    if (!args.before || !args.after) throw new Error(usage());
    await diffFiles(args.before, args.after);
  } else {
    if (!args.css || !args.out) throw new Error(usage());
    await capture(args);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
