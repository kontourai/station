/**
 * @vitest-environment jsdom
 */

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { RoutePendingSkeleton } from '../../app-shell/RoutePendingSkeleton';
import {
  formatSettingsMessage,
  localizedSettingsTargetLabel,
  SETTINGS_CATALOG,
  settingsRow,
} from '../../views/settings/settings-catalog';
import { enUSCatalog } from '../catalog.en-US';
import { enXACatalog } from '../catalog.en-XA';
import { compareStrings, formatDate, formatNumber } from '../formatters';
import {
  type LocaleContextValue,
  LocaleProvider,
  resolveDevelopmentLocale,
  useLocale,
} from '../LocaleContext';

const execFile = promisify(execFileCallback);
const PSEUDO_BUILD_MARKER = 'station-pseudo-locale-f2d6d755';

function MessageProbe() {
  const { message } = useLocale();
  return (
    <output>
      {message('route.chunk.description', { product: 'Station' })}
    </output>
  );
}

describe('i18n foundation', () => {
  test('keeps the generated pseudo catalog in exact key parity with English', () => {
    expect(Object.keys(enXACatalog).sort()).toEqual(
      Object.keys(enUSCatalog).sort(),
    );
  });

  test('has no dead catalog keys and only literal route-shell message calls', async () => {
    const routeShell = await Promise.all(
      [
        'app-shell/RoutePendingSkeleton.tsx',
        'app-shell/RouteViewBoundary.tsx',
      ].map((path) => readFile(resolve('src-ui/src', path), 'utf8')),
    );
    const calls = routeShell.flatMap((source) =>
      [...source.matchAll(/message\('([^']+)'/g)].map((match) => match[1]),
    );

    expect(new Set(calls)).toEqual(new Set(Object.keys(enUSCatalog)));
    expect(routeShell.join('\n')).not.toMatch(/message\((?!')/);
  });

  test('formats lazy Settings fragments from actual catalog ids and preserves substitutions', () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(localizedSettingsTargetLabel(entry.id, 'en-US')).toBe(
        settingsRow(entry.id).title,
      );
    }

    const rawTarget = 'Terminal shell';
    expect(
      formatSettingsMessage('paletteTitle', 'en-XA', { target: rawTarget }),
    ).toContain(rawTarget);
    expect(
      formatSettingsMessage('paletteTitle', 'en-XA', { target: rawTarget }),
    ).not.toContain('Ŧēřḿīñàľ');
    expect(() => formatSettingsMessage('paletteTitle', 'en-US')).toThrow(
      /Missing named message placeholder/,
    );
  });

  test('interpolates exact named placeholders with type-enforced callsites', () => {
    render(
      <LocaleProvider>
        <MessageProbe />
      </LocaleProvider>,
    );
    expect(screen.getByText(/Station may have been updated/)).toBeTruthy();

    declareMessageContract((message: LocaleContextValue['message']) => {
      message('route.chunk.description', { product: 'Station' });
      // @ts-expect-error a placeholder-bearing message requires its named value.
      message('route.chunk.description');
      // @ts-expect-error no extra placeholder names are accepted.
      message('route.chunk.description', { product: 'Station', extra: 'nope' });
      // @ts-expect-error a placeholder-free message does not accept a values object.
      message('route.loading', { product: 'Station' });
    });
  });

  test('expands pseudo text while preserving every placeholder token', () => {
    for (const [key, english] of Object.entries(enUSCatalog)) {
      const pseudo = enXACatalog[key as keyof typeof enUSCatalog];
      expect(pseudo.length).toBeGreaterThan(english.length);
      expect(pseudo.match(/\{[^}]+\}/g)).toEqual(english.match(/\{[^}]+\}/g));
    }
  });

  test('uses cached native Intl formatters with a caller-supplied locale', () => {
    expect(formatDate('en-US', '2026-08-24', { timeZone: 'UTC' })).toContain(
      '2026',
    );
    expect(formatNumber('en-US', 1234)).toBe('1,234');
    expect(compareStrings('en-US', 'a', 'b')).toBeLessThan(0);
  });

  test('reuses exact formatter cache keys and separates locale or option changes', () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    const NumberFormat = Intl.NumberFormat;
    const Collator = Intl.Collator;
    function dateFormatterSpy(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new DateTimeFormat(locales, options);
    }
    function numberFormatterSpy(
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      return new NumberFormat(locales, options);
    }
    function collatorSpy(
      locales?: Intl.LocalesArgument,
      options?: Intl.CollatorOptions,
    ) {
      return new Collator(locales, options);
    }
    const date = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(dateFormatterSpy);
    const number = vi
      .spyOn(Intl, 'NumberFormat')
      .mockImplementation(numberFormatterSpy);
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(collatorSpy);
    try {
      const dateOptions = { dateStyle: 'full' as const, timeZone: 'UTC' };
      formatDate('en-US', '2026-08-24', dateOptions);
      formatDate('en-US', '2026-08-24', dateOptions);
      formatDate('en-XA', '2026-08-24', dateOptions);
      formatDate('en-US', '2026-08-24', {
        dateStyle: 'long',
        timeZone: 'UTC',
      });

      const numberOptions = { currency: 'USD', style: 'currency' as const };
      formatNumber('en-US', 12, numberOptions);
      formatNumber('en-US', 12, numberOptions);
      formatNumber('en-XA', 12, numberOptions);
      formatNumber('en-US', 12, { currency: 'EUR', style: 'currency' });

      const collatorOptions = { numeric: true };
      compareStrings('en-US', '2', '10', collatorOptions);
      compareStrings('en-US', '2', '10', collatorOptions);
      compareStrings('en-XA', '2', '10', collatorOptions);
      compareStrings('en-US', 'a', 'A', { sensitivity: 'base' });

      expect(date).toHaveBeenCalledTimes(3);
      expect(number).toHaveBeenCalledTimes(3);
      expect(collator).toHaveBeenCalledTimes(3);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('allows the explicit dev query but rejects it in production', () => {
    expect(resolveDevelopmentLocale('?locale=en-XA', true)).toBe('en-XA');
    expect(resolveDevelopmentLocale('?locale=en-XA', false)).toBeUndefined();
  });

  test('renders translated route-shell status text after the dev-only chunk loads', async () => {
    render(
      <LocaleProvider developmentLocale="en-XA">
        <RoutePendingSkeleton />
      </LocaleProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(
        /Ľōàđīñğ/,
      );
    });
  });

  // A real `vite build --mode production` of the whole UI. On a hosted runner
  // sharing the machine with the rest of a sweep it needs well over the 30 s
  // default (the Fresh-home walkthrough's src-ui sweep hit exactly that), so
  // the budget is the build's, not the suite's.
  test('excludes the pseudo-locale module from the production build', {
    timeout: 180_000,
  }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'station-i18n-production-'));
    try {
      await execFile(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        [
          'exec',
          '--',
          'vite',
          'build',
          '--mode',
          'production',
          '--outDir',
          outputDir,
        ],
        { cwd: resolve('.'), env: { ...process.env, NODE_ENV: 'production' } },
      );
      const javascript = await builtJavaScript(outputDir);
      expect(javascript).not.toBe('');
      expect(javascript).toContain('Loading view');
      expect(javascript).not.toContain(PSEUDO_BUILD_MARKER);
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });
});

async function builtJavaScript(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return builtJavaScript(path);
      return entry.name.endsWith('.js') ? readFile(path, 'utf8') : '';
    }),
  );
  return contents.join('');
}

function declareMessageContract(
  assertion: (message: LocaleContextValue['message']) => void,
): void {
  // The type-only contract is compiled by `typecheck:ui`; it intentionally has
  // no runtime implementation to avoid a second formatting path in a test.
  void assertion;
}
