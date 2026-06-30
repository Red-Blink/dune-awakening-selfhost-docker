# RabbitMQ Management Localhost Binding

Branch: `security/rmq-management-localhost`

## Purpose

Remove the default public listener for the RabbitMQ game HTTP/management endpoint while preserving the public game messaging port.

This PR intentionally changes only the host exposure and operator guidance for port `31983`. It does not change RabbitMQ authentication, TLS, broker topology, or game messaging port `31982`.

## Source Findings

Primary source: `C:/Users/ronal/OneDrive/Downloads/security_report.pdf`

Related finding:

- DAST-C3: RabbitMQ management API exposed on `0.0.0.0:31983` with remote guest login enabled.

Related risk context:

- The report notes that README guidance listed `31982` as the public RabbitMQ/game port while `31983` was nevertheless bound on every interface by the startup script.

## Architecture Before

- `runtime/scripts/start-rabbitmq.sh` published the RabbitMQ game HTTP/management port with `-p 31983:15672/tcp`, which binds on all host interfaces by Docker default.
- Public hosting guidance in `runtime/scripts/init.sh` and `runtime/scripts/doctor.sh` told operators to forward `31983`.
- `runtime/scripts/local-loopback-optimize.sh` added a DNAT rule for `31983`, treating it as part of the public runtime surface.
- Diagnostics labeled the endpoint as public.

## Architecture After

- `runtime/scripts/start-rabbitmq.sh` defaults `RMQ_GAME_HTTP_BIND` to `127.0.0.1`.
- The `31983` host mapping now uses `-p "${RMQ_GAME_HTTP_BIND}:31983:15672/tcp"`.
- Operators can explicitly override `RMQ_GAME_HTTP_BIND` only when the internal endpoint is protected by a firewall or VPN.
- Public hosting guidance no longer instructs operators to forward `31983`.
- Local loopback optimization no longer DNATs `31983`.
- Readiness, status, doctor, and ping diagnostics label the endpoint as local/internal rather than public.

## Minimal Impact

- Public RabbitMQ game messaging on `31982` is unchanged.
- The RabbitMQ management plugin remains available locally on `31983`.
- The existing localhost-only `15672` mapping remains unchanged.
- Deployments that have a proven need to expose the HTTP/management endpoint can opt in with `RMQ_GAME_HTTP_BIND`, but the default is local-only.

## Code Evidence

- `runtime/scripts/start-rabbitmq.sh:14` defines `RMQ_GAME_HTTP_BIND` with a `127.0.0.1` default.
- `runtime/scripts/start-rabbitmq.sh:101-103` leaves `31982` public and binds `31983` through `RMQ_GAME_HTTP_BIND`.
- `runtime/scripts/init.sh:383-385` lists only `31982` and game UDP ports for public forwarding.
- `runtime/scripts/doctor.sh:134-138` still checks the local listener and labels it local.
- `runtime/scripts/doctor.sh:233-235` no longer tells operators to forward `31983`.
- `runtime/scripts/local-loopback-optimize.sh` no longer installs a TCP DNAT rule for `31983`.
- `runtime/scripts/ready.sh:346-350`, `runtime/scripts/status.sh:497-501`, and `runtime/scripts/ping-diagnostics.sh:168-190` label the endpoint as local.
- `.env.example:19-21` documents the explicit override.

## Test Evidence

Targeted shell assertion:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL
bash runtime/tests/test-rmq-management-localhost.sh
```

Result:

```text
PASS: RabbitMQ management HTTP is localhost-bound by default
```

Syntax checks:

```bash
bash -n runtime/scripts/start-rabbitmq.sh \
  runtime/scripts/ready.sh \
  runtime/scripts/status.sh \
  runtime/scripts/doctor.sh \
  runtime/scripts/init.sh \
  runtime/scripts/local-loopback-optimize.sh \
  runtime/scripts/ping-diagnostics.sh
```

Result: passed.

API parser tests:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL/console/api
npm test
```

Result: 143 tests passed.

## Follow-ups

- RabbitMQ TLS peer verification and certificate handling should be addressed separately.
- Removal of the `guest` user or stricter RabbitMQ management authentication should be addressed separately after compatibility testing.

