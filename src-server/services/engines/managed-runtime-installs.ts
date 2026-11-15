/**
 * Where launch and detection read installed managed runtimes from. A leaf
 * module (no imports) so the ACP descriptor layer and the built-in engine
 * catalogue can both read it without an import cycle; bootstrap registers
 * the instance's `ManagedInstaller`.
 */
export interface ManagedRuntimeInstalls {
  installed(installId: string): { runtime: string; script: string } | undefined;
}

let registered: ManagedRuntimeInstalls | null = null;

export function registerManagedRuntimeInstalls(
  installs: ManagedRuntimeInstalls | null,
): void {
  registered = installs;
}

export function managedRuntimeInstalls(): ManagedRuntimeInstalls | null {
  return registered;
}
