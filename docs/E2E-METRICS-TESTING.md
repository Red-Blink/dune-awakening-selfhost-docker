# E2E Metrics Stack Testing

This document describes the end-to-end validation procedure for the addon-supporting operational metrics stack.

The goal is to verify that the opt-in metrics stack can be started, scraped, validated, inspected, and stopped without changing the normal Dune server startup path.

## Scope

This test covers:

* metrics compose configuration
* Prometheus startup
* Prometheus scrape target health
* Prometheus rule loading
* Postgres exporter connectivity
* RabbitMQ metrics scrape reachability
* cAdvisor availability
* node exporter availability
* `dune metrics` command wiring
* `dune metrics validate`
* clean shutdown of the metrics stack

This test does not cover:

* WSL installer behavior
* Windows-specific setup
* admin tooling
* self-update behavior
* gameplay KPI analytics
* Grafana
* addon UI rendering
* player-level or gameplay-labeled metrics

## Prerequisites

Run from the repository root.

Required tools:

```bash
docker version
docker compose version
bash --version
```

The normal Dune Docker stack should already be configured.

The metrics stack is opt-in and should not start unless explicitly requested.

## Files Under Test

```text
docker-compose.metrics.yml
runtime/metrics/prometheus.yml
runtime/metrics/rules/containers.yml
runtime/metrics/rules/dune-stack.yml
runtime/metrics/rules/host.yml
runtime/metrics/rules/postgres.yml
runtime/metrics/rules/rabbitmq.yml
runtime/scripts/dune
runtime/scripts/metrics-stack.sh
runtime/scripts/metrics-status.sh
tests/metrics-stack-unit.sh
```

## Static Validation

Render the metrics compose file:

```bash
docker compose -f docker-compose.metrics.yml config
```

Expected result:

```text
Compose config renders successfully.
No YAML parse errors.
No missing required service references.
```

Run shell checks if ShellCheck is available:

```bash
shellcheck runtime/scripts/dune runtime/scripts/metrics-stack.sh runtime/scripts/metrics-status.sh tests/metrics-stack-unit.sh
```

Expected result:

```text
No ShellCheck findings.
```

Run the metrics unit tests:

```bash
bash tests/metrics-stack-unit.sh
```

Expected result:

```text
All unit tests pass.
```

## Start Metrics Stack

Start the metrics stack:

```bash
bash runtime/scripts/dune metrics start
```

Expected result:

```text
Metrics stack starts successfully.
Prometheus is available on 127.0.0.1:9090 by default.
Exporters are not exposed publicly by default.
```

Check status:

```bash
bash runtime/scripts/dune metrics status
```

Expected result:

```text
Prometheus container is running.
Configured exporters are running or reachable.
No failed metrics services are reported.
```

## Prometheus Health Check

Check Prometheus health:

```bash
curl -fsS http://127.0.0.1:9090/-/healthy
```

Expected result:

```text
Prometheus Server is Healthy.
```

Check Prometheus readiness:

```bash
curl -fsS http://127.0.0.1:9090/-/ready
```

Expected result:

```text
Prometheus Server is Ready.
```

## Target Scrape Validation

Query active Prometheus targets:

```bash
curl -fsS http://127.0.0.1:9090/api/v1/targets
```

Expected result:

```text
Prometheus returns target metadata.
Expected targets are present.
Expected active targets report health as up.
```

Run the built-in validator:

```bash
bash runtime/scripts/dune metrics validate
```

Expected result:

```text
READY: metrics validation passed.
```

The validator should confirm:

```text
Prometheus is reachable.
Scrape targets are loaded.
Rules are loaded.
Configured targets are healthy.
Postgres exporter reports pg_up == 1.
RabbitMQ metrics are reachable.
Container metrics are reachable.
Host metrics are reachable.
```

## Rule Loading Validation

Check loaded rules:

```bash
curl -fsS http://127.0.0.1:9090/api/v1/rules
```

Expected result:

```text
Prometheus returns rule groups.
Host, container, Postgres, RabbitMQ, and Dune stack rule groups are loaded.
```

## Metrics Query Validation

Check generic target health:

```bash
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up'
```

Expected result:

```text
The query succeeds.
Configured scrape targets report up == 1.
```

Check Postgres exporter connectivity:

```bash
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=pg_up'
```

Expected result:

```text
The query succeeds.
pg_up reports 1 for the configured Postgres target.
```

## Logs

Inspect all metrics stack logs:

```bash
bash runtime/scripts/dune metrics logs
```

Inspect a specific service log:

```bash
bash runtime/scripts/dune metrics logs prometheus
```

Expected result:

```text
Logs are available.
No repeated crash loop is present.
No authentication secret is printed.
No database password is printed.
```

## Restart Validation

Restart the metrics stack:

```bash
bash runtime/scripts/dune metrics restart
```

Then validate again:

```bash
bash runtime/scripts/dune metrics validate
```

Expected result:

```text
Restart succeeds.
Validation passes after restart.
```

## Stop Validation

Stop the metrics stack:

```bash
bash runtime/scripts/dune metrics stop
```

Expected result:

```text
Metrics stack stops cleanly.
Normal Dune stack remains unaffected.
```

Confirm status:

```bash
bash runtime/scripts/dune metrics status
```

Expected result:

```text
Metrics services are stopped or unavailable as expected.
No normal Dune game services are stopped by the metrics stop command.
```

## Pass Criteria

The E2E test passes when all of the following are true:

```text
docker compose -f docker-compose.metrics.yml config passes.
tests/metrics-stack-unit.sh passes.
dune metrics start succeeds.
Prometheus health endpoint succeeds.
Prometheus readiness endpoint succeeds.
Prometheus targets endpoint succeeds.
Prometheus rules endpoint succeeds.
dune metrics validate returns READY.
pg_up reports 1.
Configured scrape targets report up == 1.
dune metrics restart succeeds.
dune metrics stop succeeds.
Normal Dune stack behavior is not changed by metrics commands.
```

## Failure Criteria

The E2E test fails if any of the following occur:

```text
Metrics compose file does not render.
Prometheus does not start.
Prometheus binds publicly by default.
Required scrape targets are missing.
Configured scrape targets remain down.
Rules do not load.
pg_up does not report 1 when Postgres is running.
dune metrics validate fails.
Metrics logs expose secrets.
Metrics commands stop or modify normal Dune services unexpectedly.
```

## Evidence to Include in PR

Attach or paste the following validation output in the pull request:

```bash
docker compose -f docker-compose.metrics.yml config >/tmp/metrics-compose-config.txt
bash tests/metrics-stack-unit.sh | tee /tmp/metrics-unit-tests.txt
bash runtime/scripts/dune metrics start
bash runtime/scripts/dune metrics status | tee /tmp/metrics-status.txt
bash runtime/scripts/dune metrics validate | tee /tmp/metrics-validate.txt
curl -fsS http://127.0.0.1:9090/-/healthy
curl -fsS http://127.0.0.1:9090/-/ready
bash runtime/scripts/dune metrics stop
```

Minimum PR evidence:

```text
Compose config rendered successfully.
Metrics unit tests passed.
Metrics stack started.
Prometheus health passed.
Prometheus readiness passed.
dune metrics validate passed.
Metrics stack stopped cleanly.
```

## Rollback

The metrics stack is opt-in.

To stop it:

```bash
bash runtime/scripts/dune metrics stop
```

If needed, remove metrics containers and volumes using Docker Compose directly:

```bash
docker compose -f docker-compose.metrics.yml down
```

Normal Dune game services should not require rollback unless they were changed independently of the metrics stack.
