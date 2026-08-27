/** Small shared parser rules for the three named-Station pairing adapters. */
export type PairingFlagValue = string | true;

export function addUniquePairingFlag(
  flags: Map<string, PairingFlagValue>,
  name: string,
  value: PairingFlagValue,
): void {
  if (flags.has(name)) throw new Error(`Duplicate option --${name}.`);
  flags.set(name, value);
}

export function pairingBooleanFlag(
  flags: Map<string, PairingFlagValue>,
  name: string,
): boolean {
  const value = flags.get(name);
  if (value === undefined || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(
    `--${name} accepts only a bare flag, --${name}=true, or --${name}=false.`,
  );
}

export function pairingValueFlag(
  flags: Map<string, PairingFlagValue>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === true || value === '') {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

/** Extracts a narrow flag subset before another parser can collapse duplicates. */
export function collectPairingFlags(
  args: readonly string[],
  names: readonly string[],
): Map<string, PairingFlagValue> {
  const flags = new Map<string, PairingFlagValue>();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const separator = arg.indexOf('=');
    const name = separator < 0 ? arg.slice(2) : arg.slice(2, separator);
    if (!names.includes(name)) continue;
    addUniquePairingFlag(
      flags,
      name,
      separator < 0 ? true : arg.slice(separator + 1),
    );
  }
  return flags;
}
