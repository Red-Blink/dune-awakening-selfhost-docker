## Summary

Adds an opt-in operational metrics stack intended to support Dune Ops Observability addon work without changing the default runtime path.

This PR adds:
- `docker-compose.metrics.yml`
- Prometheus scrape configuration
- Prometheus alert/rule groups for containers, host, Postgres, RabbitMQ, and the Dune stack
- `dune metrics` CLI support
- metrics stack/status helper scripts
- unit and validation tests
- reusable changed-file security checks
- R1 implementation notes
- E2E metrics testing documentation
- PR evidence documentation

## Why this is needed

The addon needs a supported operational metrics foundation before real dashboard data can be wired safely. This PR provides that foundation while keeping metrics opt-in and local by default.

It also separates infrastructure support from the later bridge/API work needed for browser-safe addon consumption.

## Scope

In scope:
- Opt-in metrics compose stack
- Prometheus configuration
- Prometheus rule files
- CLI entrypoints for metrics start/stop/restart/status/validate/logs
- Metrics validation tests
- Security validation script for changed files
- Implementation, E2E, and PR evidence docs

## Out of scope

Out of scope:
- WSL installer changes
- Windows/WSL docs
- Admin PowerShell docs
- `install.ps1`
- General admin/self-update work
- General command-auth-token changes
- Browser-side Prometheus access
- Browser-side Prometheus tokens
- Direct addon access to exporters
- `ops.health.summary` bridge implementation
- `metrics.query` or arbitrary PromQL exposed to addons

## Implementation details

Default posture:
- Metrics stack is opt-in.
- Prometheus binds to `127.0.0.1:9090` by default.
- Exporters are not public by default.
- No gameplay/player labels are emitted in R1.
- The addon should not query Prometheus directly.
- Future addon consumption should go through a permissioned Console/backend bridge or API action.

Added operational commands:
- `dune metrics start`
- `dune metrics stop`
- `dune metrics restart`
- `dune metrics status`
- `dune metrics validate`
- `dune metrics logs`

## Regression test results

Validated locally:
- `docker compose -f docker-compose.metrics.yml config`
- `shellcheck runtime/scripts/dune runtime/scripts/metrics-stack.sh runtime/scripts/metrics-status.sh tests/metrics-stack-unit.sh tests/security-pr-checks.sh`
- `git diff --check upstream/main...HEAD`
- `bash tests/metrics-stack-unit.sh`

Result: passed.

## Security check results

Validated locally with reusable changed-file security checks:
- Git whitespace/conflict check
- Changed-file inventory
- Changed-file secret keyword review
- ShellCheck
- Gitleaks changed-file scan
- Trivy filesystem scan against changed-file staging directory when available

Command used:
- `BASE_REF=upstream/main REPORT_DIR=.security-reports ./tests/security-pr-checks.sh`

Result: passed cleanly.

The security script stages only files changed by this PR, which separates inherited repository/history findings from new PR findings.

## E2E test results

Validated locally:
- `bash runtime/scripts/dune metrics start`
- `bash runtime/scripts/dune metrics status`
- `curl -fsS http://127.0.0.1:9090/-/healthy`
- `curl -fsS http://127.0.0.1:9090/-/ready`
- `bash runtime/scripts/dune metrics validate`
- `bash runtime/scripts/dune metrics stop`

Result: passed.

Observed validation outcome:
- Prometheus healthy
- Prometheus ready
- Six active targets discovered
- All configured targets returned `up=1` during validation
- Postgres exporter returned `pg_up=1`
- Four Prometheus rule groups loaded
- Validator returned `READY: metrics validation passed`
- Metrics stack stopped cleanly

Startup note:
- Initial `metrics status` may show target health as `unknown` immediately after startup while Prometheus scrape pools settle.
- Follow-up validation confirmed final scrape health with all targets returning `up=1`.

## WebUI test results

Validated manually:
- Dune Docker Console loaded normally.
- Addons panel loaded normally.
- Dune Ops Observability could be launched when locally installed.
- Browser network inspection did not show direct calls from the addon to Prometheus or exporters.
- No browser console errors were observed from this metrics-support change set.

Result: passed.

## Documentation

Added or updated:
- `docs/R1-METRICS-STACK-IMPLEMENTATION-NOTES.md`
- `docs/E2E-METRICS-TESTING.md`
- `docs/PR-EVIDENCE-ADDON-METRICS-SUPPORT.md`

The evidence document contains the detailed validation trail for local testing, security, E2E, and WebUI checks.

## Risks

Primary risks:
- Prometheus startup status may briefly report `unknown` targets before the first scrape completes.
- Metrics stack adds optional local containers when enabled.
- Operators may need Docker resources available for Prometheus/exporters.

Mitigations:
- Stack is opt-in.
- Validation command confirms target health after startup.
- Prometheus binds locally by default.
- Exporters are not exposed publicly by default.

## Rollback

Rollback path:
- Do not start the metrics stack.
- Run `dune metrics stop` if it was started.
- Revert this PR to remove the metrics compose file, Prometheus config/rules, CLI entrypoints, helper scripts, tests, and docs.

No database migrations are included.

## Related issues / PRs

- RFC issue: https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/43
- Follow-up real-data bridge issue: https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/44
- Source fork PR: https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL/pull/83

## Follow-up

Next focused work item after this PR:
- Add a read-only, permissioned Console/backend bridge action for aggregate OPS health data, scoped to issue #44.
- Proposed action: `ops.health.summary`.
- Addon UI consumption should be implemented only after the Core bridge exists.
