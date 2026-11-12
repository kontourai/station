/**
 * SUNSET(#3909): delete once lifecycle parsing rejects unknown options, or
 * once registrations installed before #3909 are no longer supported.
 *
 * `strands-runtime` in `--features=` or `STATION_FEATURES` used to select the
 * Strands runtime. Nothing reads it now and lifecycle commands ignore unknown
 * options, so it is refused rather than silently starting VoltAgent. Other
 * values never selected a runtime and stay ignored.
 */

function listsStrandsRuntime(list: string | undefined): boolean {
  // Exact match, as the server read it: a padded entry never selected Strands.
  return (list ?? '').split(',').includes('strands-runtime');
}

function refusal(input: string): Error {
  return new Error(
    `${input} no longer selects the Strands runtime (#3909). Run \`station config set runtime strands\` (add --offline while Station is stopped), then start Station or reinstall its service without it.`,
  );
}

/** Refuses a `--features=<list>` argument that names `strands-runtime`. */
export function refuseStrandsRuntimeOption(arg: string): void {
  if (
    arg.startsWith('--features=') &&
    listsStrandsRuntime(arg.slice('--features='.length))
  ) {
    throw refusal(arg);
  }
}

/** Refuses a `STATION_FEATURES` value that names `strands-runtime`. */
export function refuseStrandsRuntimeEnvironment(env: NodeJS.ProcessEnv): void {
  if (listsStrandsRuntime(env.STATION_FEATURES)) {
    throw refusal(`STATION_FEATURES=${env.STATION_FEATURES}`);
  }
}
