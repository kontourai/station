/** The sole authored catalog for eager route-shell UI. */
export const enUSCatalog = {
  'route.loading': 'Loading view',
  'route.chunk.title': 'This view could not be downloaded.',
  'route.chunk.description':
    '{product} may have been updated since this tab was opened. Reloading fetches the current version.',
  'route.chunk.action': 'Reload Station',
  'route.authority.title': 'This view is not available to you.',
  'route.authority.description':
    'Station refused the request for this view. Review the connection you are using, then try again.',
  'route.authority.reviewAction': 'Review connection',
  'route.generic.title': 'This view stopped working.',
  'route.generic.description':
    'Trying again reloads just this view — the rest of Station, and anything open elsewhere, stays as it is.',
  'route.retryAction': 'Try again',
} as const;

export type MessageKey = keyof typeof enUSCatalog;
