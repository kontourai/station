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
    // Return CSS custom property overrides, or null to keep defaults
    return null;
  },

  async getWelcomeMessage() {
    return 'Welcome to Project Station — your AI-powered workspace';
  },
});
