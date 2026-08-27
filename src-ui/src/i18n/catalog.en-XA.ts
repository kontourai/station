import { enUSCatalog } from './catalog.en-US';
import { pseudoLocalize } from './pseudo';

/** Generated from the English authority; this module is loaded only in DEV. */
export const enXACatalog = Object.fromEntries(
  Object.entries(enUSCatalog).map(([key, message]) => [
    key,
    pseudoLocalize(message),
  ]),
) as { readonly [Key in keyof typeof enUSCatalog]: string };

// This is non-enumerable, so catalog parity stays exact. Its only job is to
// let the production-build test prove this development-only module is absent
// from emitted assets rather than inferring that from the source shape.
Object.defineProperty(enXACatalog, 'station-pseudo-locale-f2d6d755', {
  enumerable: false,
  value: true,
});
