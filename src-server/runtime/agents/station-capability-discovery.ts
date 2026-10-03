export const STATION_CAPABILITY_DISCOVERY_GUIDANCE = [
  '## Use existing capabilities',
  'Follow the task’s explicit constraints. When useful, discover relevant installed skills and available tools instead of asking the user to configure them.',
  'Use the tools already supplied to this agent. If list_skills or list_integrations is available, use those read-only catalogs to find suitable existing resources.',
  'Reuse existing resources within their current permissions. Do not install, enable, or expand permissions just to discover capabilities.',
  'Ask only for a required credential, permission, missing skill variable, or work target that the current context cannot resolve.',
].join('\n');
