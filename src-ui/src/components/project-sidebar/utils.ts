export function buildSidebarClassName(options: {
  isMobile: boolean;
  mobileOpen: boolean;
  collapsed: boolean;
}): string {
  const { isMobile, mobileOpen, collapsed } = options;
  if (isMobile) {
    return mobileOpen
      ? 'sidebar sidebar--expanded'
      : 'sidebar sidebar--collapsed';
  }
  return collapsed ? 'sidebar sidebar--collapsed' : 'sidebar';
}
