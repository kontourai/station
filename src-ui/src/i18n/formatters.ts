export type IntlLocale = 'en-US' | 'en-XA';

type DateOptions = Intl.DateTimeFormatOptions;
type NumberOptions = Intl.NumberFormatOptions;
type CollatorOptions = Intl.CollatorOptions;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const collators = new Map<string, Intl.Collator>();

function formatterLocale(locale: IntlLocale): 'en-US' {
  // en-XA is a presentation test locale, not a real CLDR data set. Its
  // numerals/dates intentionally retain English behavior.
  return locale === 'en-XA' ? 'en-US' : locale;
}

function cacheKey(locale: IntlLocale, options: object | undefined): string {
  return `${locale}:${JSON.stringify(options ?? {})}`;
}

export function formatDate(
  locale: IntlLocale,
  value: Date | number | string,
  options?: DateOptions,
): string {
  const key = cacheKey(locale, options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(formatterLocale(locale), options);
    dateFormatters.set(key, formatter);
  }
  return formatter.format(typeof value === 'string' ? new Date(value) : value);
}

export function formatNumber(
  locale: IntlLocale,
  value: number,
  options?: NumberOptions,
): string {
  const key = cacheKey(locale, options);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(formatterLocale(locale), options);
    numberFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

export function compareStrings(
  locale: IntlLocale,
  left: string,
  right: string,
  options?: CollatorOptions,
): number {
  const key = cacheKey(locale, options);
  let collator = collators.get(key);
  if (!collator) {
    collator = new Intl.Collator(formatterLocale(locale), options);
    collators.set(key, collator);
  }
  return collator.compare(left, right);
}
