export class BrokerError extends Error {
  constructor(
    readonly code:
      | 'source_unauthorized'
      | 'credentials_stale'
      | 'invalid_cursor'
      | 'event_conflict'
      | 'storage_limit'
      | 'invalid_source'
      | 'storage_not_durable'
      | 'query_limit'
      | 'source_conflict'
      | 'storage_busy'
      | 'storage_timeout'
      | 'schema_incompatible'
      | 'invalid_daily_ping',
  ) {
    super(code);
  }
}
