# Diagnostic telemetry receipt

This is the fixture and query result for the scheduler, dashboard, and primary chat observability change. The producer enters the mounted scheduler routes and the real primary chat harness with in-process fixture engines. It makes no external provider requests.

The probe ran the platform-native releases corresponding to the pinned container versions: Collector contrib 0.162.0, Prometheus 3.15.0, and Grafana 13.2.3. It used isolated loopback listeners and generated credentials. The Collector transform and ingress authentication came from the source configuration. The trace exporter was switched to the Collector's local debug sink so the projected codes could be observed without Tempo. This evidence covers the native process fixture only.

To reproduce from the feature checkout with managed dependencies, copy `produce.ts` and `probe.mjs` to `.kontourai/metrics-populations/`. Put the official Collector and Prometheus native executables in the `bin/` subdirectory and unpack the official Grafana distribution outside the Station checkout. Its own test and instruction files would otherwise be picked up by Station verification. Ensure loopback ports 44981 through 44984 are unused, then run:

```sh
STATION_METRICS_GRAFANA_ROOT=/absolute/path/to/grafana node .kontourai/metrics-populations/probe.mjs
```

The probe creates a distinct private run directory, starts the three owned services, checks unauthenticated refusals, sends real SDK telemetry, and runs every provisioned expression through the Grafana Prometheus datasource. It checks the fixture results, including exact execution and management counts and projected trace status. It stops its own processes on exit. The retained JSON holds the complete query result for the fixture, including panels intentionally left empty.
