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
