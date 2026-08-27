import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { enUSCatalog, type MessageKey } from './catalog.en-US';
import {
  compareStrings,
  formatDate,
  formatNumber,
  type IntlLocale,
} from './formatters';

type MessageTemplate = (typeof enUSCatalog)[MessageKey];
type PlaceholderName<Template extends string> =
  Template extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PlaceholderName<Rest>
    : never;
type MessageValues<Key extends MessageKey> = [
  PlaceholderName<(typeof enUSCatalog)[Key]>,
] extends [never]
  ? []
  : [
      values: Record<
        PlaceholderName<(typeof enUSCatalog)[Key]>,
        string | number
      >,
    ];

type Catalog = Readonly<Record<MessageKey, string>>;

export interface LocaleContextValue {
  readonly locale: IntlLocale;
  message<Key extends MessageKey>(
    key: Key,
    ...values: MessageValues<Key>
  ): string;
  formatDate(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  compare(left: string, right: string, options?: Intl.CollatorOptions): number;
}

export function interpolate(
  template: string,
  values?: Record<string, string | number>,
): string {
  const names = [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  if (names.length === 0) return template;
  if (!values || names.some((name) => !(name in values))) {
    throw new Error(`Missing named message placeholder in ${template}`);
  }
  if (Object.keys(values).some((name) => !names.includes(name))) {
    throw new Error(`Unexpected named message placeholder in ${template}`);
  }
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name: string) =>
    String(values[name]),
  );
}

function createLocaleValue(
  locale: IntlLocale,
  catalog: Catalog,
): LocaleContextValue {
  return {
    locale,
    message: <Key extends MessageKey>(
      key: Key,
      ...values: MessageValues<Key>
    ) => interpolate(catalog[key], values[0]),
    formatDate: (value, options) => formatDate(locale, value, options),
    formatNumber: (value, options) => formatNumber(locale, value, options),
    compare: (left, right, options) =>
      compareStrings(locale, left, right, options),
  };
}

const englishLocaleValue = createLocaleValue('en-US', enUSCatalog);
const LocaleContext = createContext<LocaleContextValue>(englishLocaleValue);

export function resolveDevelopmentLocale(
  search: string,
  isDevelopment: boolean,
): 'en-XA' | undefined {
  if (!isDevelopment) return undefined;
  return new URLSearchParams(search).get('locale') === 'en-XA'
    ? 'en-XA'
    : undefined;
}

/** English is always available; the pseudo locale exists only in development. */
export function LocaleProvider({
  children,
  developmentLocale,
}: {
  children: ReactNode;
  /** Test and development harnesses may request this. Production ignores it. */
  developmentLocale?: 'en-XA';
}) {
  const wantsPseudo = developmentLocale === 'en-XA';
  const [catalog, setCatalog] = useState<Catalog>(enUSCatalog);

  useEffect(() => {
    let current = true;
    if (!import.meta.env.DEV || !wantsPseudo) {
      setCatalog(enUSCatalog);
      return () => {
        current = false;
      };
    }

    // Keep the generated catalog outside production's graph and leave English
    // visible until the development-only chunk has arrived.
    void import('./catalog.en-XA').then(({ enXACatalog }) => {
      if (current) setCatalog(enXACatalog);
    });
    return () => {
      current = false;
    };
  }, [wantsPseudo]);

  const locale =
    import.meta.env.DEV && wantsPseudo && catalog !== enUSCatalog
      ? 'en-XA'
      : 'en-US';
  const value = useMemo(
    () => createLocaleValue(locale, catalog),
    [catalog, locale],
  );
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export type { MessageKey, MessageTemplate, MessageValues };
