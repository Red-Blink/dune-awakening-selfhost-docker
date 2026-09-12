# Running Multiple Dune: Awakening Servers Behind One Public IPv4

**Status:** Current | **Last Updated:** August 2026

This document is the operator guide and standard operating procedure (SOP) for running multiple independent `dune-awakening-selfhost-docker` battlegroups on one physical server while sharing a single public IPv4 address.

The recommended architecture is **one isolated Linux VM per Dune battlegroup**. Proxmox VE is used in the examples, but the same model applies to KVM/libvirt, VMware, Hyper-V, and similar hypervisors.

This guide is source-driven. Port defaults, host bindings, runtime advertisement behavior, and configuration methods are derived from the repository rather than from generic Docker or game-server assumptions.

> **Validated source baseline**
>
> - Upstream repository: `Red-Blink/dune-awakening-selfhost-docker`
> - Upstream baseline reviewed: `7b7d8f1950a278e6431519841d5408cf04c582fb`
> - Staging fork: `yacketrj/dune-awakening-selfhost-docker`
>
> Re-run the validation steps in this SOP after every upstream update. The helper intentionally fails closed when source patterns it depends on can no longer be derived.

---

# Executive Summary

## Objective

A single public IPv4 address can support multiple independent Dune: Awakening battlegroups when every battlegroup has:

1. an isolated VM and unique LAN IPv4 address;
2. its own Docker daemon and runtime state;
3. its own battlegroup identity and credentials;
4. a complete per-instance host-port namespace;
5. a distinct Player/Game UDP range;
6. a distinct IGW UDP range;
7. distinct RabbitMQ Game and RabbitMQ Game HTTP host ports;
8. distinct service/control-plane host ports;
9. a distinct Admin Web host port;
10. a distinct optional Prometheus host port;
11. correct `SERVER_IP`, `SERVER_IP_MODE`, and `SERVER_BIND_IP` values;
12. authoritative UserEngine `Port` and `IGWPort` values that match the instance profile;
13. router/NAT and VM-firewall rules that match the profile;
14. NAT reflection/hairpin behavior where required by the public endpoint path.

Recommended physical topology:

```text
                              Internet
                                 |
                          One Public IPv4
                                 |
                         Firewall / Router
                                 |
                         Proxmox VE Host
                                 |
             +-------------------+-------------------+
             |                   |                   |
          DUNE-01             DUNE-02             DUNE-03
          VM #1               VM #2               VM #3
      192.168.68.127      192.168.68.128      192.168.68.129
          Docker               Docker               Docker
          Stack A              Stack B              Stack C
```

All battlegroups may advertise the **same public IPv4**. The public router distinguishes them by destination port and protocol.

---

## Non-negotiable rule: no host-port overlap anywhere

For this community deployment model, a numeric **host-facing port** is treated as belonging to exactly one managed endpoint across the complete multi-VM deployment.

The rule is intentionally stricter than the operating system's normal TCP/UDP socket tuple rules:

> **No repo-managed host port or host-port range may overlap another managed host port or range on any VM, even when protocols differ.**

This means the following is invalid:

```text
VM1 IGW UDP       7888-7921
VM2 Player UDP    7877-7910
```

because the numeric ranges intersect at:

```text
7888-7910
```

The earlier mixed-offset example using `7877` and `7988` is therefore **obsolete and must not be used**.

Why this stricter policy is used:

- both Player/Game and IGW ranges may be forwarded through the same public IPv4;
- NAT rules remain deterministic and easy to audit;
- packet captures are immediately attributable to a single VM/service;
- monitoring and runbooks do not need protocol-specific exceptions to identify ownership;
- future upstream binding changes cannot unexpectedly convert a duplicated numeric port into a collision;
- the guide remains safe when an operator later exposes a service that was originally loopback-only.

---

## What the global rule covers

The collision domain in this SOP is **repo-managed host-facing/published ports**.

It includes:

- Player/Game UDP range;
- IGW UDP range;
- PostgreSQL host port;
- RabbitMQ Admin host port;
- RabbitMQ Game host port;
- RabbitMQ Game HTTP host port;
- RabbitMQ Game local-management host port;
- Text Router host port;
- Director host port;
- Admin Web host port;
- optional Prometheus host port.

It does **not** require container-internal-only ports to change. For example:

```text
Host VM1:15432 -> Postgres container:5432
Host VM2:16432 -> Postgres container:5432
Host VM3:17432 -> Postgres container:5432
```

The internal container port `5432` may remain fixed because it is not part of the shared VM/public host namespace.

The same principle applies to RabbitMQ's internal `5672` and internal management `15672` ports. What must be unique is the **host-side mapping**.

Operating-system services such as SSH are outside this repository's configuration. If they are forwarded through the same public IPv4, the operator must add those public ports to the site-wide port registry and ensure they do not collide with this plan.

---

## Standard allocation policy: uniform +1000 stride

The recommended profile keeps upstream defaults for Instance 1 and applies a single offset to **every host port and range base** for later instances:

```text
INSTANCE_PORT_STRIDE = 1000
instance_offset = (instance_number - 1) * 1000
```

Examples:

```text
Instance 1 offset =    0
Instance 2 offset = 1000
Instance 3 offset = 2000
Instance 4 offset = 3000
```

For a scalar host port:

```text
instance_port = stock_port + instance_offset
```

For a range:

```text
instance_start = stock_start + instance_offset
instance_end   = stock_end   + instance_offset
```

The included helper enforces the resulting allocation mathematically rather than assuming the stride is always safe.

---

# Authoritative Host-Port Inventory

The following inventory represents the audited single-instance host-facing configuration.

| Function | Stock host value | Protocol | Source / behavior |
|---|---:|---|---|
| Player/Game base | `7777` | UDP | UserEngine `Port`; runtime allocates through base `+33` |
| Player/Game pool | `7777-7810` | UDP | Dynamic game-server allocation |
| IGW base | `7888` | UDP | UserEngine `IGWPort`; runtime allocates through base `+33` |
| IGW pool | `7888-7921` | UDP | Server-to-server/game topology |
| Public probe direct ICE | `32000-32015` | UDP | Optional direct DuneDocker.app latency; relay fallback when closed |
| Text Router | `5059` | TCP | Host loopback publish |
| Admin Web | `8088` | TCP | Web Console host-network listener |
| Prometheus | `9090` | TCP | Optional metrics host loopback publish |
| Director | `11717` | TCP | Host loopback publish |
| PostgreSQL | `15432` | TCP | Host loopback publish to container `5432` |
| RMQ Game local HTTP | `15672` | TCP | Host loopback mirror to game RMQ management `15672`; configurable by this change |
| RMQ Game | `31982` | TCP | Host-published game RabbitMQ endpoint |
| RMQ Game HTTP | `31983` | TCP | Host-published game RabbitMQ HTTP/management endpoint |
| RMQ Admin | `32573` | TCP | Host loopback publish to admin RMQ `5672` |

See the "Source-of-Truth Reference" table near the end of this document for exactly which file governs each behavior above. The public probe uses host networking on native Linux and confines direct ICE listeners to UDP `32000-32015`.

---

# Collision-Free Standard Profiles

## VM1 / VM2 / VM3

| Function | VM1 / Instance 1 | VM2 / Instance 2 | VM3 / Instance 3 |
|---|---:|---:|---:|
| Player/Game UDP | `7777-7810` | `8777-8810` | `9777-9810` |
| Public probe direct ICE UDP | `32000-32015` | `32000-32015` | `32000-32015` |
| IGW UDP | `7888-7921` | `8888-8921` | `9888-9921` |
| Text Router TCP | `5059` | `6059` | `7059` |
| Admin Web TCP | `8088` | `9088` | `10088` |
| Prometheus TCP | `9090` | `10090` | `11090` |
| Director TCP | `11717` | `12717` | `13717` |
| PostgreSQL TCP | `15432` | `16432` | `17432` |
| RMQ Game local HTTP TCP | `15672` | `16672` | `17672` |
| RMQ Game TCP | `31982` | `32982` | `33982` |
| RMQ Game HTTP TCP | `31983` | `32983` | `33983` |
| RMQ Admin TCP | `32573` | `33573` | `34573` |

There are **no numeric overlaps** among any values in this table.

Generate and validate the same plan from source:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

The command must end with:

```text
VALIDATION: all generated managed host ports are globally non-overlapping.
```

At the audited baseline, the +1000 policy remains collision-free through Instance 33. Instance 34 is rejected because a generated host port exceeds `65535`.

That is an allocator boundary only; it is **not** a recommendation to run 33 battlegroups on one physical server.

---

# Configuration Sources: `.env` vs UserEngine

## Service/host ports are environment-backed

Current runtime service defaults include:

```text
POSTGRES_PORT=15432
RMQ_ADMIN_PORT=32573
RMQ_GAME_PORT=31982
RMQ_GAME_HTTP_PORT=31983
RMQ_GAME_LOCAL_HTTP_PORT=15672
TEXT_ROUTER_PORT=5059
DIRECTOR_PORT=11717
ADMIN_BIND_PORT=8088
METRICS_PROMETHEUS_PORT=9090
```

`ADMIN_WEB_PORT` is also recognized by the Web Compose path as an override alias. This guide keeps `ADMIN_BIND_PORT` and `ADMIN_WEB_PORT` aligned to the same Admin Web endpoint.

## Player/Game and IGW are authoritative UserEngine settings

The stock UserEngine network configuration is:

```ini
[URL]
Port=7777
IGWPort=7888
```

Current runtime resolution for these values goes through `usersettings.py`.

Therefore this alone is not sufficient:

```env
CLIENT_PORT_BASE=8777
IGW_PORT_BASE=8888
```

The authoritative values must also be written through UserEngine:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port 8888
python3 runtime/scripts/usersettings.py engine-set port 8777
python3 runtime/scripts/usersettings.py materialize-current
```

The helper performs both the `.env` compatibility writes and the authoritative UserEngine writes.

---

# Addressing Model

For a VM behind NAT:

```text
SERVER_IP       = shared public WAN IPv4
SERVER_IP_MODE  = public
SERVER_BIND_IP  = VM LAN IPv4
```

Example for VM2:

```env
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
```

The runtime's NAT/public-host logic preserves the local bind address while advertising the public address to the appropriate game/runtime paths.

---

# Public NAT / Port-Forwarding Plan

The examples below forward Player/Game and IGW because this SOP assumes both are externally forwarded in the target design.

Use **1:1 port translation** whenever possible.

Do this:

```text
PUBLIC:32982 -> VM2:32982
```

Avoid unnecessary translations such as:

```text
PUBLIC:32982 -> VM2:31982
```

because advertised/runtime port values and troubleshooting remain simpler when external and internal host ports match.

## VM1

```text
UDP 7777-7810   -> 192.168.68.127:7777-7810   Player/Game
UDP 7888-7921   -> 192.168.68.127:7888-7921   IGW
TCP 31982       -> 192.168.68.127:31982       RMQ Game
TCP 31983       -> 192.168.68.127:31983       RMQ Game HTTP
TCP 8088        -> 192.168.68.127:8088        Admin Web, if intentionally exposed
```

## VM2

```text
UDP 8777-8810   -> 192.168.68.128:8777-8810   Player/Game
UDP 8888-8921   -> 192.168.68.128:8888-8921   IGW
TCP 32982       -> 192.168.68.128:32982       RMQ Game
TCP 32983       -> 192.168.68.128:32983       RMQ Game HTTP
TCP 9088        -> 192.168.68.128:9088        Admin Web, if intentionally exposed
```

## VM3

```text
UDP 9777-9810   -> 192.168.68.129:9777-9810   Player/Game
UDP 9888-9921   -> 192.168.68.129:9888-9921   IGW
TCP 33982       -> 192.168.68.129:33982       RMQ Game
TCP 33983       -> 192.168.68.129:33983       RMQ Game HTTP
TCP 10088       -> 192.168.68.129:10088       Admin Web, if intentionally exposed
```

PostgreSQL, RMQ Admin, RMQ local HTTP, Text Router, Director, and Prometheus are still assigned unique host ports but should **not** be blindly forwarded to the Internet. Current upstream binds several of them to loopback.

---

# Detailed Standard Operating Procedure

## Phase 0 — Change-control preparation

Before changing an existing deployment:

1. identify every battlegroup and VM;
2. assign a stable instance number to each VM;
3. record the current public IPv4;
4. record every VM LAN IPv4;
5. export or record router/NAT rules;
6. record VM firewall rules;
7. back up each `.env`;
8. record current UserEngine `Port` and `IGWPort` values;
9. record current Docker listeners;
10. take a VM snapshot or other restore point where appropriate;
11. confirm hypervisor console access before changing remote networking.

On each VM:

```bash
cd /path/to/dune-awakening-selfhost-docker

cp -a .env ".env.pre-multiserver.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 runtime/scripts/usersettings.py engine-values

docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

ss -lntup
```

Record at minimum:

```text
port
igw_port
```

---

## Phase 1 — Validate the checked-out source before using numeric examples

Run:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

The helper derives current values from repository source rather than assuming this document is permanently correct.

It currently derives:

- service defaults from `runtime/scripts/runtime-env.sh`;
- UserEngine `Port` / `IGWPort` defaults from `runtime/scripts/usersettings.py`;
- game/IGW pool maximum offsets from `runtime/scripts/spawn-server.sh`;
- Admin Web default from `.env.example`;
- optional Prometheus default from `docker-compose.metrics.yml`;
- RabbitMQ local-management host default from `runtime/scripts/start-rabbitmq.sh`.

If one of those patterns can no longer be found, the helper exits with an error. Treat that as a required code-review point after an upstream change.

---

## Phase 2 — Build the VM isolation boundary

Create one VM per battlegroup.

Example:

```text
DUNE-01 -> Instance 1 -> 192.168.68.127
DUNE-02 -> Instance 2 -> 192.168.68.128
DUNE-03 -> Instance 3 -> 192.168.68.129
```

Each VM needs:

- its own virtual NIC;
- a stable LAN IPv4;
- its own filesystem;
- its own Docker daemon;
- its own repository checkout;
- its own `.env`;
- its own `runtime/` state;
- sufficient CPU, RAM, and storage for its maps.

A bridged Proxmox network is straightforward:

```text
vmbr0
  |
  +-- DUNE-01 192.168.68.127
  +-- DUNE-02 192.168.68.128
  +-- DUNE-03 192.168.68.129
```

Validate each VM:

```bash
ip -4 addr
ip route
curl -4 https://api.ipify.org
```

All VMs behind the same edge router should report the same public IPv4.

---

## Phase 3 — Install one independent stack per VM

Install and initialize `dune-awakening-selfhost-docker` independently inside each guest.

Do not treat two checkouts inside one Linux host namespace as equivalent to two isolated battlegroups. The project uses fixed Docker resource names and host-network behavior in important paths.

Do not clone a fully initialized/running Dune VM unless you deliberately regenerate every identity, credential, and runtime artifact that must remain unique.

---

## Phase 4 — Assign stable instance numbers

Use stable numbering:

```text
DUNE-01 = instance 1
DUNE-02 = instance 2
DUNE-03 = instance 3
```

The offset is:

```text
offset = (instance - 1) * 1000
```

Do not renumber casually after firewall rules, monitoring, dashboards, and runbooks use these values.

---

## Phase 5 — Generate the complete plan

From a current checkout:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

Machine-readable output:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

The plan must pass the complete interval collision audit before you create router rules.

The validator treats:

```text
range A = start..end
scalar  = port..port
```

and compares every interval against every other interval **within this one `plan`/`apply` invocation** -- i.e. across the set of VMs the `--instances`/`--instance` argument actually generates for this specific command run, not against any other, already-deployed VM elsewhere on your network.

Protocol is deliberately ignored for collision purposes.

> **This tool cannot detect a real collision against a machine it isn't currently generating a profile for.** `plan --instances 3`'s "Global collision validation: PASS" only means VM1/VM2/VM3's own generated ports don't collide with each other in that one run -- it says nothing about whether instance 2 is already in use on some other, already-configured VM you didn't include in this invocation. `verify` has the same limitation in the other direction: it only checks the *local* machine's own `.env`/UserEngine values against what instance N *should* look like; it has no visibility into any other machine's configuration either. There is currently no mechanism in this tool that can see across separate VMs -- if you have already used a given instance number elsewhere, re-running `plan`/`apply`/`verify` for that same number will not warn you. Keep your own authoritative record (e.g. a simple spreadsheet or this document's own allocation table, filled in per VM as you provision it) of which instance number is assigned to which VM.

---

## Phase 6 — Stop the stack before applying a new host-port identity

Changing host ports while old containers remain active leaves stale listeners and makes validation ambiguous.

Use the project's normal stop workflow, then inspect:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

The helper refuses to apply while Dune game/database containers are running unless `--allow-running` is supplied. The console, orchestrator, and public-probe containers are excluded from this check -- but for a different reason for each. The orchestrator has no host-facing listener this tool rewrites. The public probe's dedicated UDP `32000-32015` range is fixed and is not rewritten by the profile tool, so leaving it running is safe during profile generation. **The console is different: it runs with `network_mode: host` and does listen directly on `ADMIN_BIND_PORT`/`ADMIN_WEB_PORT`, a port this tool's `apply` step does rewrite in `.env`.** It's excluded from the running-container check purely because you are almost always using the console itself to reach this tool in the first place, and `apply` only writes files -- it never touches already-running containers -- so leaving the console running during `apply` is safe in the sense that nothing crashes or corrupts. It is **not** safe in the sense of "already using the new port": the running console process keeps listening on its old `ADMIN_BIND_PORT` until it is explicitly restarted, exactly like every other Dune service this tool reconfigures. Restart the console (along with the rest of the stack) after `apply`, per the final step of this phase, before assuming the new Admin Web port is live.

> **In practice, `--allow-running` is required for this documented flow to work at all, not an edge case.** `docker ps` shown above will still list the console container itself after a normal `dune stop` (it's management tooling, not part of "the stack" this phase means) -- since you are almost always using the console (or a shell on the same host it's running on) to reach this tool in the first place, plan on passing `--allow-running` every time you follow this phase, immediately after stopping the game/database containers, not only when you hit the refusal message.

Treat `--allow-running` as a staging-only override for the *game/database* containers specifically. A restart is still required for running processes to adopt the new listeners.

---

## Phase 7A — Automated configuration with `multi-server-config.py`

### VM2 dry-run

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --dry-run
```

Expected VM2 host profile:

```text
Player/Game UDP          8777-8810
IGW UDP                  8888-8921
Text Router TCP          6059
Admin Web TCP            9088
Prometheus TCP           10090
Director TCP             12717
PostgreSQL TCP           16432
RMQ Game local HTTP TCP  16672
RMQ Game TCP             32982
RMQ Game HTTP TCP        32983
RMQ Admin TCP            33573
```

Expected validation:

```text
Global collision validation: PASS
```

### Apply VM2

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

The helper:

1. derives current defaults from source;
2. computes the instance profile;
3. validates every generated VM from Instance 1 through the requested instance;
4. rejects any range/range, range/scalar, or scalar/scalar numeric overlap;
5. rejects any generated port outside `1-65535`;
6. checks for running Dune containers;
7. creates a timestamped configuration backup;
8. updates or inserts managed `.env` keys;
9. removes duplicate active definitions for those managed keys;
10. writes authoritative UserEngine `IGWPort`;
11. writes authoritative UserEngine `Port`;
12. materializes current runtime settings;
13. prints Player/Game, IGW, RMQ Game, RMQ Game HTTP, and optional Admin Web forwarding rules;
14. does not restart the stack automatically.

Backups are created under:

```text
runtime/backups/multi-server-config-<UTC timestamp>/
```

---

## Phase 7B — Manual configuration (advanced, not recommended)

Use the automated helper (Phase 7A) unless you have a specific reason to configure a VM by hand. Manual configuration must set every field in the same "Collision-Free Standard Profiles" table above -- the `.env` keys (`SERVER_IP`, `SERVER_IP_MODE`, `SERVER_BIND_IP`, plus the 11 managed port keys from the "Configuration Sources" section) *and* the authoritative UserEngine values, which are separate and easy to forget:

```bash
python3 runtime/scripts/usersettings.py engine-set igw_port <IGW value from the profile table>
python3 runtime/scripts/usersettings.py engine-set port <Player/Game value from the profile table>
python3 runtime/scripts/usersettings.py materialize-current
```

Before editing `.env` by hand, audit for an existing definition rather than appending a duplicate:

```bash
grep -nE '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|RMQ_GAME_LOCAL_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|METRICS_PROMETHEUS_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

The interactive manager (`runtime/scripts/manager.sh`, UserEngine global-default editor) can also set `Port`/`IGWPort` directly if you prefer a menu over the two `engine-set` commands above. Running map containers retain the prior values until restarted either way.

---

## Phase 9 — Configure router/NAT forwarding

Create 1:1 mappings using the exact instance profile from the "Public NAT / Port-Forwarding Plan" table above (VM1/VM2/VM3 examples already shown there -- do not duplicate them per-VM here).

Do not expose PostgreSQL, RMQ Admin, RMQ local HTTP, Text Router, Director, or Prometheus merely because they have unique host ports. Unique allocation and WAN exposure are separate decisions.

---

## Phase 10 — Configure VM firewall rules

Example UFW rules follow the externally forwarded set, one VM at a time using that VM's own profile from the "Collision-Free Standard Profiles" table:

```bash
# VM1
sudo ufw allow 31982/tcp
sudo ufw allow 31983/tcp
sudo ufw allow 7777:7810/udp
sudo ufw allow 7888:7921/udp
sudo ufw allow 32000:32015/udp

# VM2 (same pattern, VM2's own port values)
sudo ufw allow 32982/tcp
sudo ufw allow 32983/tcp
sudo ufw allow 8777:8810/udp
sudo ufw allow 8888:8921/udp
sudo ufw allow 32000:32015/udp
```

Every additional VM follows the identical pattern with that instance's own values. Permit or forward UDP `32000-32015` at the internet-to-DMZ boundary as well as on the VM itself when direct public probe results are desired.

For Admin Web, prefer management-subnet restrictions rather than unrestricted WAN rules:

```bash
sudo ufw allow from 192.168.68.0/24 to any port 9088 proto tcp
```

---

## Phase 11 — Validate NAT reflection / hairpin NAT

Server Gateway receives the advertised `SERVER_IP` plus the configured RMQ Game and RMQ Game HTTP ports.

From VM2:

```bash
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983
```

From VM1:

```bash
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983
```

If external hosts can connect but these tests fail from inside, investigate:

- NAT reflection / NAT loopback;
- split routing;
- policy routing;
- double NAT;
- VM firewall policy;
- edge-gateway implementation.

---

## Phase 12 — Start the stack

Start the Dune stack only after:

- `.env` is correct;
- UserEngine is correct;
- router/NAT rules are correct;
- VM firewall rules are correct;
- collision validation passes.

Do not validate only one map. Dynamic maps may consume additional ports inside the allocated Player/Game and IGW pools.

---

## Phase 13 — Verify the saved profile

VM2:

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

Expected success includes:

```text
VERIFY: configuration matches expected profile.
Global collision validation: PASS
```

---

## Phase 14 — Verify `.env`

```bash
grep -E '^(SERVER_IP|SERVER_IP_MODE|SERVER_BIND_IP|POSTGRES_PORT|RMQ_ADMIN_PORT|RMQ_GAME_PORT|RMQ_GAME_HTTP_PORT|RMQ_GAME_LOCAL_HTTP_PORT|TEXT_ROUTER_PORT|DIRECTOR_PORT|ADMIN_BIND_PORT|ADMIN_WEB_PORT|METRICS_PROMETHEUS_PORT|CLIENT_PORT_BASE|IGW_PORT_BASE)=' .env
```

VM2 should show:

```text
SERVER_IP=203.0.113.50
SERVER_IP_MODE=public
SERVER_BIND_IP=192.168.68.128
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
RMQ_GAME_LOCAL_HTTP_PORT=16672
TEXT_ROUTER_PORT=6059
DIRECTOR_PORT=12717
ADMIN_BIND_PORT=9088
ADMIN_WEB_PORT=9088
METRICS_PROMETHEUS_PORT=10090
CLIENT_PORT_BASE=8777
IGW_PORT_BASE=8888
```

---

## Phase 15 — Verify authoritative UserEngine values

```bash
python3 runtime/scripts/usersettings.py engine-values | grep -E '^(port|igw_port)'
```

VM2 expected:

```text
port        8777
igw_port    8888
```

Inspect materialized runtime files:

```bash
find runtime/game -path '*/Saved/UserSettings/UserEngine.ini' -print

grep -RniE '^\[URL\]|^Port=|^IGWPort=' \
  runtime/game/*/Saved/UserSettings/UserEngine.ini
```

---

## Phase 16 — Verify actual host listeners

```bash
ss -lntup
```

For VM2, the managed host namespace is:

```text
Player/Game UDP          8777-8810
IGW UDP                  8888-8921
Text Router TCP          6059
Admin Web TCP            9088
Prometheus TCP           10090
Director TCP             12717
PostgreSQL TCP           16432
RMQ Game local HTTP TCP  16672
RMQ Game TCP             32982
RMQ Game HTTP TCP        32983
RMQ Admin TCP            33573
```

Not every port inside a dynamic Player/Game or IGW range must be actively listening at all times.

---

## Phase 17 — Inspect Docker state

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Verify host publications match the instance profile and that no service is unexpectedly using Instance 1 defaults.

For the game RabbitMQ container on VM2, the host-side local management mapping should be equivalent to:

```text
127.0.0.1:16672 -> container:15672
```

The container-side management port remains `15672`.

---

## Phase 18 — Run project diagnostics

```bash
dune doctor
dune ready
```

Review any port/listener warning before declaring the deployment healthy.

---

## Phase 19 — Validate game and IGW registration

```bash
runtime/scripts/network-addresses.sh status
```

Confirm:

- advertised game addresses use the intended public IP;
- local socket binds use the expected VM address;
- Player/Game ports fall only inside that VM's Player/Game pool;
- IGW ports fall only inside that VM's IGW pool;
- no runtime state references another VM's port namespace.

---

## Phase 20 — Validate from a genuinely external network

Use a host outside the server LAN, such as a cloud VM, mobile hotspot, or second site.

Example TCP checks:

```bash
# VM1
nc -vz 203.0.113.50 31982
nc -vz 203.0.113.50 31983

# VM2
nc -vz 203.0.113.50 32982
nc -vz 203.0.113.50 32983

# VM3
nc -vz 203.0.113.50 33982
nc -vz 203.0.113.50 33983
```

If Admin Web is intentionally exposed:

```bash
curl -I http://203.0.113.50:8088/
curl -I http://203.0.113.50:9088/
curl -I http://203.0.113.50:10088/
```

For UDP, actual game discovery/join/travel is the strongest functional validation. Generic UDP probes may not receive an application response even when the path is open.

---

## Phase 21 — Packet-capture validation (optional, advanced)

If Phase 20's external connectivity checks fail or are ambiguous, capture on the affected VM using that VM's own port profile:

```bash
# Example for VM2 -- substitute the target VM's own values from its profile
sudo tcpdump -ni any \
  'tcp port 32982 or tcp port 32983 or tcp port 9088 or udp portrange 8777-8810 or udp portrange 8888-8921'
```

Use packet capture to determine:

- which VM received a public packet;
- which exact port it reached;
- whether the process replied;
- whether hairpin traffic returns to the correct VM;
- whether any traffic uses a port belonging to another instance.

---

## Phase 22 — Prometheus and optional metrics

The optional metrics stack publishes Prometheus on loopback using `METRICS_PROMETHEUS_PORT`, default `9090`.

This guide includes Prometheus in the global host-port allocator even if metrics are currently disabled, so enabling metrics later does not introduce a hidden collision.

Standard values:

```text
VM1 Prometheus  9090
VM2 Prometheus 10090
VM3 Prometheus 11090
```

Prometheus should normally remain private. If an operator intentionally exposes it, apply the same site-wide forwarding and security review used for every other externally reachable service.

The public probe uses host networking and direct ICE UDP `32000-32015`; relay remains available when the range is closed.

---

## Phase 23 — Web Console security

The Web Console uses host networking and mounts `/var/run/docker.sock`.

That gives it broad control over the Docker host.

Preferred remote-access order:

1. LAN-only;
2. VPN;
3. authenticated reverse proxy with TLS and strict access control;
4. direct public forwarding only when explicitly required and secured.

Unique Admin Web ports are still assigned for every VM whether or not direct WAN forwarding is enabled.

---

## Phase 24 — Control-plane security

Do not directly expose PostgreSQL, RMQ Admin, RMQ local HTTP, Text Router, or Director to the Internet without a defined, reviewed requirement.

Unique host ports are assigned for deterministic instance identity, not as permission to publish them.

Keep secrets out of Git:

- Funcom self-host tokens;
- admin passwords;
- database credentials;
- RabbitMQ secrets;
- API tokens;
- SSH private keys.

Use a default-deny inbound policy and open only required public paths.

---

## Phase 25 — Site-wide non-Dune ports

The Python helper validates ports managed by this repository. It cannot automatically know every other listener on your network.

Before final deployment, maintain a site-level port registry that also accounts for:

- SSH public forwarding;
- hypervisor management;
- reverse proxies;
- VPN listeners;
- monitoring systems outside this repository;
- backup appliances;
- any other public service sharing the same IPv4.

If an OS service must be public, assign it a public port that does not intersect any Dune-managed range or scalar port.

---

## Phase 26 — Capacity planning

Port isolation (this document's subject) solves addressing, not compute contention. Sizing each VM's CPU/RAM/storage for its own map/Sietch count is a normal hypervisor capacity-planning exercise, outside this SOP's scope.

---

## Phase 27 — Upgrade procedure

After pulling upstream changes:

```bash
git pull
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

If the helper can no longer derive a required default, stop and review source changes.

Inspect changes to at least:

```bash
git diff HEAD@{1} -- \
  .env.example \
  docker-compose*.yml \
  runtime/defaults/UserEngine.ini \
  runtime/scripts/runtime-env.sh \
  runtime/scripts/usersettings.py \
  runtime/scripts/manager.sh \
  runtime/scripts/spawn-server.sh \
  runtime/scripts/start-rabbitmq.sh \
  runtime/scripts/start-postgres.sh \
  runtime/scripts/start-text-router.sh \
  runtime/scripts/start-director.sh \
  runtime/scripts/start-server-gateway.sh \
  runtime/scripts/network-addresses.sh \
  runtime/scripts/init.sh \
  runtime/scripts/doctor.sh
```

Re-run global collision validation before restarting production.

---

## Phase 28 — Rollback procedure

Stop the Dune stack before restoring a prior network identity.

Find the most recent helper backup:

```bash
ls -1dt runtime/backups/multi-server-config-* | head
```

Restore `.env` and generated settings from the appropriate backup, then:

```bash
python3 runtime/scripts/usersettings.py materialize-current
```

Restore previous firewall and NAT rules, restart the stack, and run:

```bash
dune doctor
dune ready
```

Do not mix a restored `.env` with newer UserEngine port values; verify both configuration paths after rollback.

---

# Troubleshooting Matrix

| Symptom | Likely cause | Checks |
|---|---|---|
| `plan` reports a global collision | generated or custom values intersect | read both allocations named by the error; do not override the validator |
| `plan` rejects a high instance number | port-space exhaustion above `65535` | reduce instance count or create a reviewed custom allocation strategy |
| VM2 still listens on `7777` | `.env` changed but authoritative UserEngine `Port` did not | `usersettings.py engine-values`; generated UserEngine files |
| VM2 still uses IGW `7888` | authoritative `IGWPort` not changed | `engine-values`; generated UserEngine files |
| VM2 Player/Game traffic arrives at VM1 | incorrect NAT destination | edge NAT rules; `tcpdump` on both VMs |
| VM2 IGW fails | IGW still forwarded to old or overlapping range | verify `8888-8921`; firewall; packet capture |
| VM2 RabbitMQ local management still shows `15672` host-side | `RMQ_GAME_LOCAL_HTTP_PORT` missing or old container still running | `.env`; `docker ps`; restart RabbitMQ service |
| Gateway cannot reach RMQ using public IP | missing hairpin/NAT reflection | `nc` from VM to its public RMQ tuples |
| VM2 Web Console opens VM1 | wrong Admin Web forward/reverse-proxy target | verify `9088 -> VM2:9088` |
| Prometheus conflicts after enabling metrics | `METRICS_PROMETHEUS_PORT` not using profile | verify VM2 `10090`, VM3 `11090` |
| `dune doctor` reports old service ports | stale/duplicate `.env` value or old container | grep `.env`; inspect runtime; restart |
| dynamic maps cannot allocate ports | range exhaustion, overlap, or stale process | spawn logs; `ss -lnup`; active map count |
| helper refuses while containers run | safety guard | stop stack or use `--allow-running` only to stage |
| helper cannot derive a default | upstream source layout changed | inspect source-of-truth files and update helper |
| only LAN access works | WAN NAT/firewall or advertised IP problem | external packet capture; `SERVER_IP`; router rules |

---

# Automation Helper Reference

File:

[`runtime/scripts/multi-server-config.py`](../../runtime/scripts/multi-server-config.py)

## `plan`

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

JSON:

```bash
python3 runtime/scripts/multi-server-config.py plan --instances 3 --json
```

`plan` does not modify configuration.

## `apply`

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

Dry run:

```bash
python3 runtime/scripts/multi-server-config.py apply \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128 \
  --dry-run
```

## `verify`

```bash
python3 runtime/scripts/multi-server-config.py verify \
  --instance 2 \
  --public-ip 203.0.113.50 \
  --bind-ip 192.168.68.128
```

## Collision algorithm

The helper represents every managed host endpoint as an interval:

```text
Player/Game              start-end
IGW                      start-end
PostgreSQL               port-port
RMQ Admin                port-port
RMQ Game                 port-port
RMQ Game HTTP            port-port
RMQ Game local HTTP      port-port
Text Router              port-port
Director                 port-port
Admin Web                port-port
Prometheus               port-port
```

It sorts the full interval set for all generated instances and rejects any intersection.

Protocol is deliberately ignored.

This catches:

- Game ↔ Game overlap;
- Game ↔ IGW overlap;
- IGW ↔ IGW overlap;
- range ↔ scalar overlap;
- scalar ↔ scalar reuse;
- same-port reuse across different protocols.

---

# Source-of-Truth Reference

| Behavior | Source |
|---|---|
| UserEngine `Port` / `IGWPort` defaults | `runtime/defaults/UserEngine.ini`, `runtime/scripts/usersettings.py` |
| UserEngine interactive editing | `runtime/scripts/manager.sh` |
| Dynamic Player/Game and IGW pool allocation | `runtime/scripts/spawn-server.sh` |
| Core service-port defaults | `runtime/scripts/runtime-env.sh` |
| PostgreSQL host mapping | `runtime/scripts/start-postgres.sh` |
| RabbitMQ host mappings | `runtime/scripts/start-rabbitmq.sh` |
| Text Router host mapping | `runtime/scripts/start-text-router.sh` |
| Director host mapping | `runtime/scripts/start-director.sh` |
| RMQ Game/RMQ HTTP public endpoint use | `runtime/scripts/start-server-gateway.sh` |
| Web Console host networking | `docker-compose.web.yml` |
| Admin Web default | `.env.example`, Web Compose/config |
| Prometheus host mapping | `docker-compose.metrics.yml`, `runtime/scripts/metrics-stack.sh` |
| Public/bind address handling | `runtime/scripts/runtime-env.sh`, `runtime/scripts/network-addresses.sh` |
| Public-host checks | `runtime/scripts/init.sh`, `runtime/scripts/doctor.sh` |
| Multi-server planner | `runtime/scripts/multi-server-config.py` |

---

# Maintainer Acceptance Checklist

Before publishing or submitting this guide upstream:

- [ ] `python3 -m py_compile runtime/scripts/multi-server-config.py` passes.
- [ ] `bash -n runtime/scripts/start-rabbitmq.sh` passes.
- [ ] `plan --instances 3` succeeds.
- [ ] VM1 Player/Game and IGW do not overlap.
- [ ] VM2 Player/Game and IGW do not overlap.
- [ ] VM3 Player/Game and IGW do not overlap.
- [ ] No Player/Game range overlaps another VM's IGW range.
- [ ] No scalar service port falls inside any Player/Game or IGW range.
- [ ] No scalar host port is reused by another managed endpoint.
- [ ] Prometheus is included in the global namespace.
- [ ] RMQ local-management host port is included in the global namespace.
- [ ] IGW is included in NAT/forwarding examples.
- [ ] `.env` examples match helper output.
- [ ] UserEngine examples match helper output.
- [ ] Router/NAT examples match helper output.
- [ ] Obsolete `7877/7988` mixed-stride values are not presented as active configuration.
- [ ] Container-internal ports are clearly distinguished from host-facing ports.
- [ ] Site-wide non-Dune public ports are reviewed separately.
- [ ] `git diff --check` passes on the upstream candidate branch.
