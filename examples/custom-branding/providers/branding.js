/**
 * Custom branding provider example
 *
 * This shows how a plugin can override the default Station branding.
 * The server loads this module and calls each method to build the
 * branding response served at GET /api/branding.
 *
 * To install:
 *   cp -r examples/custom-branding .station/plugins/custom-branding
 *
 * To revert to defaults, disable the branding provider in the UI
 * (Plugins → custom-branding → Providers → branding toggle)
 * or remove the plugin.
 */

module.exports = () => ({
  async getAppName() {
    return 'Project Station';
  },

  async getLogo() {
    return { src: '/favicon.png', alt: 'Station' };
  },

  async getTheme() {
    // White-label overrides, per mode. Station applies only the brand-slot
    // properties below, only as #rgb/#rrggbb colours, and only when each
    // group passes its contrast check against that mode's page and panel;
    // anything else is dropped and logged in the browser console. Return
    // null to keep the defaults. A flat { '--k-brand': '#…' } object is
    // also accepted and applies to both modes. See README.md.
    return {
      dark: {
        '--k-brand': '#60a5fa',
        '--k-brand-contrast': '#06080b',
        '--k-action': '#60a5fa',
        '--k-action-contrast': '#06080b',
        '--k-focus': '#93c5fd',
      },
      light: {
        '--k-brand': '#1d4ed8',
        '--k-brand-contrast': '#ffffff',
        '--k-action': '#1d4ed8',
        '--k-action-contrast': '#ffffff',
        '--k-focus': '#1d4ed8',
      },
    };
  },

  async getWelcomeMessage() {
    return 'Welcome to Project Station — your AI-powered workspace';
  },
});
