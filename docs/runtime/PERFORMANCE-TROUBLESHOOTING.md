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

Discord adapter operations and public translation-mesh endpoints now retain
their exact static route labels, even though they bypass the IAM action catalog.
Unknown paths still use `/api/*`; dynamic identifiers, query strings and payloads
are never included. A route label identifies an operation, not a specific caller.

RabbitMQ node-ping healthchecks and startup probes limit only their temporary
CLI Erlang VM to one normal scheduler, one dirty CPU scheduler and one dirty I/O
scheduler. They retain the existing authenticated node ping and healthcheck
interval, timeout and retries; the broker's own scheduler configuration is
unchanged. Existing brokers acquire the healthcheck change when recreated through
the normal RabbitMQ startup path. Updating repository files alone does not modify
a running container's healthcheck. This reduces probe overhead on large hosts;
the reporter's comparison ruled these probes out as the cause of the cross-map freeze.

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

In the reporter's later test on build `2180427`, the affected map reached
15.77 GiB of its configured 16 GiB limit and collected every 30 seconds.
After saving a 24 GiB limit and restarting that map, the reporter's 50-minute
follow-up showed GC returning to multi-minute intervals, with usage at
15.45 GiB. This supports the low-memory explanation for that installation;
the separate 63-second cross-map freezes continued. A fresh-process restart is
also a change, so the report does not prove the exact native memory signal or
that every live limit change requires a restart. See the
[reporter's follow-up](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/291#issuecomment-6803023359).

The reporter's [dated overnight follow-up](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/291#issuecomment-6812930738)
confirmed that the improvement held for more than 15 hours: GC ran at roughly
five-minute intervals from November 11 at 20:36 to November 12 at 13:00, 2026.
An apparent return to 30-second GC came from mixing undated entries from the
previous evening. Ordinary single-map catch-up messages remained; this resolved
the frequent-GC symptom, not every possible hitch or replication bottleneck.

To test the hypothesis, use the existing per-map **Memory** controls during a
planned maintenance window. Save the original limits, ensure the host can safely
support the higher limit, then restart only the affected map so the new native
process starts with that limit. Compare several minutes at similar player/load
conditions, recording GC timestamps/durations, RAM/limit, container start time
and Memory Balancer state. Restore the original setting if the test does not
help. A live limit change or an empty local map is not an equivalent test.
Save the per-map limit through the existing memory controls so the next scheduled
restart retains it. Size for peak usage plus more than 4 GiB of headroom where
the host can support it; do not apply the example's 24 GiB to every map blindly.

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

### Confirmed host cause in the 63-second stall report

In [issue #290](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/290),
host tracing identified a Proxmox host's `ksmtuned` service launching `ps` to
measure QEMU memory every 60 seconds. The command's run time accounted for the
roughly 63-second cadence. Its `show_smaps_rollup` scan held QEMU's `mmap_lock`
while guest vCPU threads waited during memory faults. The full queued-writer
sequence was not identified; the measurements do not explain every quiet interval.

KSM already reported `run=0`, but its tuning service was still polling. The
operator stopped that host service and measured no long lock holds in a short
trace. Their [longer follow-up](https://github.com/Red-Blink/dune-awakening-selfhost-docker/issues/290#issuecomment-6828090407)
then found zero catch-up events of one second or more across six maps during a
15-hour window from November 11 at 22:00 to November 12 at 13:00, 2026. Most of
the window had low player counts, so it was not a full-load stress test. Separate
startup and map-loading hitches were not established as recurrences.

This is a measured host configuration cause for that report, not a reason to
disable KSM or services on every host. Dune Docker does not change hypervisor
services. On a similar recurrence, have the host administrator correlate guest
stalls with QEMU lock waits and host process activity before changing settings.
Keep frequent GC and isolated gameplay hitches separate from synchronized pauses.

### Story ejections

Since v1.4.64, the Autoscaler retains one empty ready spare for an occupied
single-party story map and requests another instance when all assigned instances
are occupied. Configured dimension caps, warming instances and memory admission
still apply. Fresh-process activities keep their existing retirement behavior.
This addresses idle recycling of the spare; it does not establish how the native
Director selects a destination or guarantee admission when capacity is exhausted.

For story ejections, correlate the Director's exact travel request and refusal,
source/target server and partition, destination ready/alive state and Autoscaler
allocation/removal records from the same attempt. A spare merely running later
does not prove it was ready or selected at the time of travel. Keep any player
identifiers consistent when anonymizing the trace.
