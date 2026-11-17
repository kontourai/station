/** The sole authored catalog for eager route-shell UI. */
export const enUSCatalog = {
  'route.loading': 'Loading view',
  'route.chunk.title': 'Couldn’t download this view.',
  'route.chunk.description':
    '{product} may have been updated since this tab opened. Reload to get the current version.',
  'route.chunk.action': 'Reload Station',
  'route.chunk.offlineTitle': 'This view isn’t saved on this device.',
  'route.chunk.offlineDescription':
    'You’re offline and haven’t opened this view since {product} last updated. Reload when you’re back online.',
  'route.authority.title': 'This view isn’t available to you.',
  'route.authority.description':
    'You don’t have access to this view. Check which connection you’re using.',
  'route.authority.reviewAction': 'Review connection',
  'route.generic.title': 'This view stopped working.',
  'route.generic.description':
    'Retry reloads only this view. Nothing else is affected.',
  'route.retryAction': 'Retry',
  'route.troubleshootAction': 'Troubleshoot',
  'route.moreActions': 'More actions for this view',
} as const;

export type MessageKey = keyof typeof enUSCatalog;
