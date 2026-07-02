# R1 Metrics Stack MVP Implementation Notes

Tracking issue: #82
Branch: `feature/metrics`
PR: #83

## Summary

R1 adds the first opt-in operational metrics stack for Dune Docker Console.

Implemented components:

- `docker-compose.metrics.yml`
- `runtime/metrics/prometheus.yml`
- `runtime/metrics/rules/host.yml`
- `runtime/metrics/rules/containers.yml`
- `runtime/metrics/rules/postgres.yml`
- `runtime/metrics/rules/rabbitmq.yml`
- `runtime/metrics/rules/dune-stack.yml`
- `runtime/scripts/metrics-stack.sh`
- `runtime/scripts/metrics-status.sh`
- `dune metrics ...` CLI dispatch in `runtime/scripts/dune`

## Why

The project needs industry-standard operational metrics for host, container, RabbitMQ, and Postgres health without forcing gameplay KPI analytics into Prometheus.

This first release phase creates the independent metrics control plane while keeping the Dune game stack unchanged.

## Operational Design

The metrics stack is opt-in and starts separately from the game stack:

```text
dune metrics start
dune metrics stop
dune metrics restart
dune metrics status
dune metrics logs [service]
dune metrics config
dune metrics pull
```

Prometheus binds to localhost only by default:

```text
127.0.0.1:9090
```

Exporters are attached to the existing internal `dune-net` network and are not published publicly by default.

Metrics compose now uses a separate project name by default:

```text
${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}-metrics
```

This prevents metrics compose operations from warning that the main game/web containers are orphaned.

## Metrics Stack Components

```text
dune-prometheus
dune-node-exporter
dune-cadvisor
dune-postgres-exporter
```

Prometheus also scrapes existing RabbitMQ containers when they are running:

```text
dune-rmq-admin:15692
dune-rmq-game:15692
```

## Prometheus Jobs

```text
dune-prometheus
dune-node
dune-cadvisor
dune-postgres
dune-rabbitmq-admin
dune-rabbitmq-game
```

## Alert Rule Groups

```text
dune-host
dune-containers
dune-postgres
dune-rabbitmq
dune-stack
```

The `dune-stack` rule file is currently a valid empty rule group. It is reserved for R2 console-exporter metrics.

## Security Notes

Security posture for R1:

- Metrics stack remains opt-in.
- Prometheus binds to `127.0.0.1` by default.
- node_exporter is not public.
- cAdvisor is not public.
- postgres_exporter is not public.
- RabbitMQ metrics are scraped on the internal Docker network.
- No passwords or tokens are committed.
- postgres_exporter uses environment-derived credentials, not Git-tracked literal secrets.
- No player identifiers or gameplay labels are emitted in R1.

## Validation Result: 2026-06-30, initial run

Local validation was run from:

```text
/home/darkdante/dune-clean-repro
```

Commands run:

```bash
docker compose -f docker-compose.metrics.yml config
bash runtime/scripts/metrics-stack.sh config
bash runtime/scripts/metrics-stack.sh start
bash runtime/scripts/metrics-stack.sh status
bash runtime/scripts/metrics-stack.sh stop
bash runtime/scripts/dune metrics status
```

Observed results:

- Compose config rendered successfully.
- Prometheus started and reported healthy on `127.0.0.1:9090`.
- cAdvisor started.
- postgres_exporter started.
- node_exporter failed to start under WSL/Docker mount propagation.
- Stack stopped cleanly afterward.
- Post-stop status correctly reported Prometheus unreachable.

Failure:

```text
Error response from daemon: path / is mounted on / but it is not a shared or slave mount
```

Root cause:

`dune-node-exporter` originally mounted the host root as:

```text
/:/host:ro,rslave
```

That propagation mode is common in Linux host examples, but it fails when the Docker host root mount is not configured as shared/slave. This is common in WSL/Docker Desktop environments.

Fix applied:

```text
/:/host:ro
```

The node exporter host root mount is still read-only, but no longer requires `rslave` propagation by default.

## Validation Result: 2026-06-30, retest after mount fix

Command run:

```bash
bash runtime/scripts/metrics-stack.sh start
```

Observed results:

- Metrics compose started all four containers.
- Prometheus started and exposed `127.0.0.1:9090`.
- cAdvisor started.
- node_exporter started.
- postgres_exporter started.
- Prometheus health reported `healthy`.

Container status:

```text
dune-prometheus          Up 2 seconds                      127.0.0.1:9090->9090/tcp
dune-cadvisor            Up 2 seconds (health: starting)   8080/tcp
dune-node-exporter       Up 2 seconds                      9100/tcp
dune-postgres-exporter   Up 2 seconds                      9187/tcp
```

Remaining issue observed:

- The status command printed the `=== Prometheus targets ===` header but no target rows.

Conclusion:

- Container startup and Prometheus health are now passing.
- Empty target output is not a complete validation pass. Prometheus should report active scrape targets for the configured jobs.

Fix applied after this observation:

- `metrics-stack.sh` now waits briefly for Prometheus targets after `start` and `restart`.
- `metrics-stack.sh status` now prints `active_targets=<count>`.
- Empty target output now renders an explicit message instead of silently passing.
- Metrics compose now uses a separate project name and ignores orphan warnings from the main game/web stack.

## Validation Result: 2026-06-30, retest after target reporting fix

User-reported local result:

- Metrics stack is running.
- Prometheus shows configured targets.
- Prometheus shows loaded rules.

Conclusion:

- Prometheus startup is validated.
- Compose service startup is validated after the node exporter mount fix.
- Prometheus scrape target loading is validated.
- Prometheus rule loading is validated.
- The previous blank target output issue is resolved.

## Validation Result: 2026-06-30, metric query pass

Commands run:

```bash
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=pg_up'
```

Observed `up == 1` targets:

```text
dune-postgres-exporter:9187  job=dune-postgres       service=postgres-exporter
dune-cadvisor:8080           job=dune-cadvisor       service=cadvisor
dune-rmq-admin:15692         job=dune-rabbitmq-admin service=rabbitmq-admin
dune-rmq-game:15692          job=dune-rabbitmq-game  service=rabbitmq-game
dune-prometheus:9090         job=dune-prometheus     service=prometheus
dune-node-exporter:9100      job=dune-node           service=node-exporter
```

Observed `pg_up == 1` target:

```text
dune-postgres-exporter:9187 job=dune-postgres service=postgres-exporter
```

Conclusion:

- All configured Prometheus scrape targets are reachable and healthy.
- RabbitMQ admin and game metrics endpoints are reachable from Prometheus on `dune-net`.
- postgres_exporter is connected successfully to Postgres.
- R1 metrics startup, target loading, rule loading, RabbitMQ scrape reachability, and Postgres exporter connectivity are validated.

PromQL selector curl note:

`curl` can return HTTP 400 when a PromQL selector is passed directly in the URL without URL encoding. Use `--data-urlencode` or an encoded URL for selector queries.

Correct examples:

```bash
curl -fsS -G 'http://127.0.0.1:9090/api/v1/query' --data-urlencode 'query=up{job=~"dune-rabbitmq-.*"}'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D~%22dune-rabbitmq-.*%22%7D'
```

## Validation Result: 2026-06-30, game-stack regression pass

Commands run:

```bash
bash runtime/scripts/dune --help
bash runtime/scripts/dune status
bash runtime/scripts/dune ready
bash runtime/scripts/dune ps
```

Observed results:

- CLI help renders and includes `dune metrics [start|stop|restart|status|logs|config|pull]`.
- `dune status` reports `Overall: READY`.
- `dune status` reports RabbitMQ admin listener OK.
- `dune status` reports RabbitMQ game listener OK.
- `dune ready` reports all core container checks OK.
- `dune ready` reports all listener checks OK.
- `dune ready` reports RabbitMQ game user connections OK.
- `dune ready` reports the stack as READY.
- `dune ps` shows metrics containers and game containers running.
- `dune ps` shows `dune-cadvisor` healthy after the initial startup period.

Conclusion:

- R1 did not break normal game-stack CLI status, readiness, or process listing checks.
- cAdvisor health settles to healthy under the tested WSL/Docker Desktop environment.
- Game/admin RabbitMQ runtime checks pass through existing CLI readiness and listener checks.

## Validation Result: 2026-06-30, unit and live metrics validator pass

Commands run:

```bash
git pull
bash tests/metrics-stack-unit.sh
bash runtime/scripts/dune metrics validate
```

Observed unit test result:

- TAP output rendered visibly.
- Test harness created isolated fake command directory.
- Fake Docker command installed.
- Fake curl/Prometheus command installed.
- Happy-path validation printed full metrics validator output.
- Happy-path assertions passed for Prometheus health, six targets, RabbitMQ admin/game targets, rule groups, `pg_up`, READY summary, and URL-encoded `up` / `pg_up` queries.
- Failure-path validation intentionally removed the required `dune-node` target.
- Failure-path assertions passed for missing target detection and failure summary.
- Final TAP plan reported `1..16`.

Observed live validator result:

- Prometheus health passed.
- Active targets reported: `6`.
- Live targets up: `dune-cadvisor`, `dune-node`, `dune-postgres`, `dune-prometheus`, `dune-rabbitmq-admin`, `dune-rabbitmq-game`.
- Rule groups reported: `4`.
- `up == 1` for all six live targets.
- `pg_up == 1` for `dune-postgres-exporter:9187`.
- Live validator ended with `READY: metrics validation passed.`

Conclusion:

- Metrics unit coverage is now visible and useful in local and CI logs.
- The live metrics validator passes against the running stack.
- The metrics validation command and unit harness are ready to be used as PR gates.

## Regression Expectations

R1 should not alter normal game startup behavior.

Regression checks:

```bash
bash runtime/scripts/dune --help
bash runtime/scripts/dune status
bash runtime/scripts/dune ready
bash runtime/scripts/dune ps
```

Current result: passed locally on 2026-06-30.

## Remaining R1 Work

- Run security/static checks before marking PR ready for review.
