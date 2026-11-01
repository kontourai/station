export const STATION_CONTROL_DISCOVERY_TOOL_NAMES = {
  listFamilies: 'list_tool_families',
  loadFamily: 'load_tool_family',
} as const;

/** A transport owns one instance per verified credential incarnation and drops it on revoke. */
export class StationControlDisclosure {
  private readonly loaded = new Set<string>();

  constructor(private readonly isCurrent: () => boolean) {}

  current(): boolean {
    try {
      return this.isCurrent();
    } catch {
      return false;
    }
  }

  has(family: string): boolean {
    return this.current() && this.loaded.has(family);
  }

  load(family: string): boolean {
    if (!this.current()) return false;
    this.loaded.add(family);
    return true;
  }
}
