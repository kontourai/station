import type { FeaturePreviewSelector } from './feature-preview-registry.js';

export class FeaturePreviewDisabledError extends Error {
  readonly refusal;
  constructor(previewId: string, label: string) {
    const error = `Enable ${label} in Settings → Advanced → Feature previews.`;
    super(error);
    this.refusal = {
      success: false as const,
      error,
      code: 'feature_preview_disabled' as const,
      previewId,
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews' as const,
    };
  }
}

export function requireFeaturePreview(
  preview: FeaturePreviewSelector,
  id: string,
  label: string,
): void {
  preview.select({
    enabled: () => {},
    disabled: () => {
      throw new FeaturePreviewDisabledError(id, label);
    },
  });
}
