/**
 * The values `loadAppConfigFile` writes into `config/app.json` when the file
 * does not carry them. They live in `@kontourai/station-contracts/config`
 * (#4517: `station policy check` builds the same validation probe as server
 * startup), and are re-exported here for the server's existing importers.
 */
export {
  APP_CONFIG_SEED,
  isSeededAppConfigValue,
  SEEDED_APP_CONFIG_KEYS,
} from '@kontourai/station-contracts/config';
