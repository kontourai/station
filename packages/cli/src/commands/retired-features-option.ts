/**
 * SUNSET(#3909): delete once lifecycle parsing rejects unknown options, or
 * once registrations installed before #3909 are no longer supported.
 *
 * `strands-runtime`, passed as `--features=<list>` or in `STATION_FEATURES`,
 * used to switch one process to the Strands runtime. Station no longer reads
 * it, and lifecycle commands ignore unknown options, so a caller still
 * passing it would run on VoltAgent without being told. Only that value is
 * refused; any other `--features` or `STATION_FEATURES` value never changed
 * the runtime and stays ignored.
 */

function listsStrandsRuntime(list: string | undefined): boolean {
  return (list ?? '')
    .split(',')
    .some((flag) => flag.trim() === 'strands-runtime');
}

function refusal(input: string): Error {
  return new Error(
    `${input} no longer selects the Strands runtime: the persisted \`runtime\` setting is the only runtime selector (#3909). Run \`station config set runtime strands\` (with --offline while Station is stopped), then start Station, or reinstall its service, without it.`,
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
