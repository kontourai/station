module.exports = () => ({
  async getAppName() {
    return 'Project Station';
  },

  async getLogo() {
    return { src: '/favicon.png', alt: 'Station' };
  },

  async getTheme() {
    // White-label overrides, per mode. Station applies only the brand-slot
    // properties below, only as #rgb/#rrggbb colours, and only when the
    // whole theme passes its contrast checks against each mode's page, panel
    // and raised panel. If anything is rejected, nothing is applied and the reasons are
    // logged in the browser console. Return null to keep the defaults. A
    // flat { '--k-brand': '#…' } object is also accepted and is expanded
    // into both modes before checking. See README.md.
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
