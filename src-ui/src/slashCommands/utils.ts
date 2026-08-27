/**
 * Re-exported under its historical name, not re-implemented: the server uses
 * this exact slug to decide which `/command` a skill answers to and to refuse a
 * clash between two of them (`@kontourai/station-contracts/skill-command`). A
 * second copy here would let the client offer a command the server never
 * matches.
 */
export { skillCommandSlug as promptSlug } from '@kontourai/station-contracts/skill-command';
