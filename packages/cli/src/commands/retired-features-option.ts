/**
 * `--features=<flags>` only ever set `STATION_FEATURES`, and its last flag,
 * `strands-runtime`, was retired in #3909: the persisted `runtime` setting is
 * now the only runtime selector. The option is refused, not ignored, because
 * lifecycle commands ignore unknown flags, and ignoring this one would start
 * a Station that asked for Strands on VoltAgent without saying so.
 */

const SET_RUNTIME = 'station config set runtime strands';

/** True for `--features` in either spelling. */
export function isRetiredFeaturesOption(arg: string): boolean {
  return arg === '--features' || arg.startsWith('--features=');
}

/** Whether a retired `--features` value asked for the Strands runtime. */
export function requestsStrandsRuntime(features: string): boolean {
  return features
    .split(',')
    .map((flag) => flag.trim())
    .includes('strands-runtime');
}

/** The refusal for a command line that still passes `--features`. */
export function retiredFeaturesOptionError(arg: string): Error {
  return new Error(
    `${arg.split('=')[0]} was removed: Station no longer reads STATION_FEATURES, and the persisted \`runtime\` setting is the only runtime selector (#3909). To run Strands, set it with \`${SET_RUNTIME}\` (add --offline while Station is stopped) and restart Station. A Station service whose registration still passes --features does not start until it is reinstalled without it; \`station service status\` prints the reinstall command.`,
  );
}

/**
 * What `service status` and upgrade guidance say about an installed service
 * that still passes `--features=<value>`: it cannot start, and how to keep
 * the runtime it asked for before reinstalling. `home` is the service's
 * Station home, when known.
 */
export function describeRetiredServiceFeatures(
  features: string,
  home: string | undefined,
  shellArgument: (value: string) => string,
): string {
  const strands = requestsStrandsRuntime(features);
  const setRuntime =
    home === undefined
      ? `${SET_RUNTIME} --offline`
      : `STATION_HOME=${shellArgument(home)} ${SET_RUNTIME} --offline`;
  return [
    `this service passes --features=${shellArgument(features)}, which Station no longer accepts (#3909), so it does not start until it is reinstalled without it.`,
    strands
      ? `It asked for the Strands runtime: to keep Strands, run "${setRuntime}" before reinstalling, or it runs on the persisted \`runtime\` setting (VoltAgent unless set).`
      : 'No other value of --features changed what Station ran.',
  ].join(' ');
}
