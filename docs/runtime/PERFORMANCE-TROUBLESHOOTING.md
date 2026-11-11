# Performance troubleshooting

Record the installed Dune Docker version, native image/build, affected map,
container start time and a short UTC reproduction window first. Avoid changing
several settings at once: synchronized pauses and frequent garbage collection
can have different causes.

## Finding logs

Use **Logs → Console** in the existing Console service selector. Search for
`console.request` or `memory.limit`; live stream and Download work as for other
services. On the host, the same output is available with:

```bash
docker logs --timestamps --since 10m redblink-dune-docker-console
docker logs --timestamps --since 10m dune-autoscaler
docker logs --timestamps --since 10m dune-director
docker ps --format '{{.Names}}'   # identify the affected dune-server-* container
docker logs --timestamps --since 10m <affected-game-container>
```

Console JSON request records include UTC start/end time, HTTP method, static
route pattern/action, status, elapsed milliseconds and a coarse client/auth
category. They exclude query strings, dynamic path identifiers, bodies, headers,
credentials and player coordinates. A disconnected response has status `499`.
Long-lived streams are recorded when they finish or disconnect, not per message.
Timing covers HTTP response completion, not completion of an asynchronous task
started by that request.

`memory.limit` records describe Memory Balancer requests and their applied/failed
outcomes, with previous/new byte limits, reason and elapsed time. A previous limit
of `null` means it was not sampled for that operation. These records cover the
Console balancer, not manual `docker update` calls or native engine allocations.

Diagnostics use the existing Console container log and its rotation settings.
Output is bounded to 200 records per second and stops queuing on log-driver
backpressure. A later `diagnostics.dropped` record reports lost records. An absent
record therefore does not prove an operation never happened.

For removed containers, consult `runtime/generated/container-lifecycle.log`,
`runtime/generated/logs/containers/` and `runtime/generated/logs/archive/` as
described in the [operator guide](../operator-guide.md#9b-logs-after-a-restart-or-crash).
The project does not install the reporter's custom “stall-watcher”; its capture
location depends on that tool's output settings. Request its command and output
path rather than assuming captures exist under this installation.

Review native logs and traces before sharing: they may contain credentials,
addresses, names and coordinates. Share a redacted short window; use a private
channel for material that cannot be safely redacted.

## Frequent native garbage collection

In stock native build `2180427`, `DuneSandbox/Config/DefaultEngine.ini` contains
`gc.TimeBetweenPurgingPendingKillObjects=300` and
`gc.LowMemory.MemoryThresholdMB=4096`. A platform configuration also sets a normal
interval; loose-file values do not establish the final runtime value or all
reasons the game can trigger GC.

Epic documents separate [garbage collection settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/garbage-collection-settings-in-the-unreal-engine-project-settings)
and [low-memory console variables](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-console-variables-reference).
Their current reference lists a 30-second low-memory purge interval. This is a
lead to test against the installed game engine, not proof that the project's
memory controls cause a particular game's 30-second cadence.

A reported map using 16.2 GiB of a 19 GiB limit had less than 4 GiB of headroom,
but raising its live limit did not change the reported cadence. That does not
establish whether the native process cached the initial limit, uses a different
memory signal, or follows another GC policy.

To test the hypothesis, use the existing per-map **Memory** controls during a
planned maintenance window. Save the original limits, ensure the host can safely
support the higher limit, then restart only the affected map so the new native
process starts with that limit. Compare several minutes at similar player/load
conditions, recording GC timestamps/durations, RAM/limit, container start time
and Memory Balancer state. Restore the original setting if the test does not
help. A live limit change or an empty local map is not an equivalent test.

Do not disable GC or enable experimental incremental reachability as a blanket
fix. Epic's [incremental GC documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/incremental-garbage-collection-in-unreal-engine)
describes engine-side requirements; changing a console variable cannot verify
that a shipping game satisfies them.

## Cross-map stalls and story ejections

For synchronized stalls, request the raw watcher command plus redacted captures
spanning several pauses on two maps. Correlate UTC timestamps, per-thread waits,
CPU, native GC/hitch logs and Console timing. Native userspace stacks should
include module-relative addresses and the exact image/build so they can be
compared even without vendor symbols. Correlated `futex`/`munmap` activity alone
does not identify the caller or establish a repository defect.

For story ejections, correlate the Director's exact travel request and refusal,
source/target server and partition, destination ready/alive state and Autoscaler
allocation/removal records from the same attempt. A spare merely running later
does not prove it was ready or selected at the time of travel. Keep any player
identifiers consistent when anonymizing the trace.
