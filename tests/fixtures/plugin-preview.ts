import type { PluginPreview } from '@kontourai/station-contracts/plugin';
import type { PluginPreviewPayload } from '../helpers/install-plugin';

export const DEMO_LAYOUT_PREVIEW = {
  valid: true,
  manifest: {
    name: 'demo-layout',
    displayName: 'Demo Layout',
    version: '1.0.0',
  },
  components: [{ type: 'layout', id: 'demo' }],
  conflicts: [],
  contentDigest: 'sha256:demo',
  permissions: { required: [], autoGranted: [], pendingConsent: [] },
  dependencies: [],
} satisfies PluginPreview & PluginPreviewPayload;
