# Incident Report: INC-2026-07-24-001

## Steam CDN Content-Server Directory Failure Causing Extended Game Server Version-Lag Outage (Operator Case Study)

**Scope note**: This is a case study of a single self-hosted operator's incident and response, not a confirmed project-wide or platform-wide finding. Identifiers specific to this operator's deployment (public IP, battlegroup ID, FLS/player IDs, character name, internal server IDs, filesystem paths) have been redacted below. Several root-cause conclusions about Valve/Steam-side behavior are the responding engineer's **inference from the available evidence**, not confirmed via Valve documentation, support contact, or source access — these are explicitly labeled as hypotheses throughout, not established facts.

| Field | Value |
|---|---|
| **Incident ID** | INC-2026-07-24-001 |
| **Classification** | Availability — suspected third-party dependency failure (external CDN); see Section 3 for confidence levels |
| **Severity** | **SEV-2** (High) — full player-facing service unavailability inferred; no data loss; no security impact from the underlying incident (see Section 5.7 for a security note on the remediation itself) |
| **Status** | **Resolved** (update completed, service restored, player connectivity confirmed) — root cause attribution partially inferred, see Section 3 |
| **Affected Service** | Operator's self-hosted Dune Awakening game server (identifying details redacted) — all maps |
| **Affected Component** | Steam content-delivery update pipeline (`runtime/scripts/update.sh` → SteamCMD → Valve `IContentServerDirectoryService`) |
| **Detection Method** | Player reports (Discord + direct messages) that the server could not be found/joined |
| **Incident Commander** | Operator (redacted) |
| **Responding Engineer** | AI SRE agent (this session) |
| **Report Prepared** | 2026-07-24, post-incident, same-day |
| **Report Standard** | Structured per NIST SP 800-61r2 incident lifecycle phases, adapted for an availability/infrastructure incident; formatted as an operator-level NOC/SOC-style postmortem. Revised 2026-07-24 following technical review — see Section 12 (Revision Notes) for what changed and why. |

---

## 1. Executive Summary

On 2026-07-24, the operator's self-hosted Dune Awakening game server could not be found or joined by players, despite all internal container-level and application-level health checks reporting nominal (green) status. Players reported the outage via Discord and direct messages.

Investigation established the following as **confirmed facts**, directly evidenced by logs and direct testing (see Section 8):
- The routine Steam content update (SteamCMD `app_update`) was failing repeatedly, over an extended window, always against the same content-server hostname (`cache1-blv2.valve.org`).
- That hostname was independently confirmed unresolvable (NXDOMAIN) via three separate DNS resolvers.
- Valve's `IContentServerDirectoryService` API repeatedly and consistently returned that same hostname as the sole member of the highest-priority download-source class for the operator's network cell.
- The locally-installed game server's Steam app manifest was left in a failed update state (`buildid: 0`, `UpdateResult: 7`, no depots installed) for the duration of the failure window.
- After a remediation (Section 2.4) allowed the Steam update to complete, the server was rebuilt on the new build and cold-started, and player connectivity was subsequently confirmed via database and application-log evidence (Section 2.6).

The following causal claims are **inferences, not confirmed facts**, and are presented as such throughout this report:
- That the stale build version was *the* reason (or the *sole* reason) the server could not be found by players in Funcom's official in-game server browser specifically. No Funcom-side documentation, API, or log access was available to confirm this mechanism directly; it is the responding engineer's best explanation consistent with the evidence, but the recovery process changed several variables at once (Steam build, all container images, a full stack cold-start), so an alternative or partial explanation involving one of those other changes cannot be fully ruled out from the available evidence. See Section 3 and Section 5.4 for the reasoning and its limits.
- That the dead CDN hostname represents a Valve-side "decommissioned" node, that the priority-class change relative to an earlier successful run represents a Valve-side "regression," and that this fallback behavior is "entirely unconfigurable" on the client side. These are reasonable hypotheses grounded in the observed evidence, not confirmed via any Valve source, changelog, or support channel. See Section 5 for what is directly evidenced versus inferred.

The incident was worked around by engineering a temporary, host-local TLS-intercepting reverse proxy that allowed the SteamCMD update to complete against a different, reachable Steam CDN host while presenting itself under the dead hostname's identity. This is **not** end-to-end TLS between SteamCMD and Valve; it is controlled interception with locally-generated, locally-trusted certificates. Section 5.7 describes the security implications explicitly. This was used as a one-time, hands-on emergency measure by an engineer with full control of the affected container — it is not recommended as a general or automatic remediation path (see Section 7, R2).

**Duration**: reconstructed evidence places the earliest observed failed update attempt at approximately 2 hours 49 minutes before confirmed player-facing recovery. As detailed in Section 6.2, this is a conservative lower bound, not a precise total outage duration — the true start of player-facing impact is not independently established.

No player data, character state, or persistent world state was lost or corrupted at any point in this incident, based on the database checks performed (Section 8.7).

---

## 2. Incident Timeline (NIST SP 800-61r2 Lifecycle Phases)

All times UTC. Evidence sources cited inline; raw log excerpts are preserved in Section 8 (Evidence Appendix), redacted per the scope note above.

### 2.1 Phase: Preparation (Pre-Incident State)

| Time (UTC) | Event |
|---|---|
| 2026-07-17 22:55:22 | Last known-good Steam update completed successfully. This run's logs *also* show a failed connection attempt to the same `cache1-blv2.valve.org` host, but the update succeeded anyway because SteamCMD attempted multiple hosts in parallel during that run (see Section 5.3). |

### 2.2 Phase: Detection & Analysis

| Time (UTC) | Event | Source |
|---|---|---|
| ~15:21:04 | First reconstructed evidence of the update mechanism failing. An update attempt (trigger not conclusively determined — see Section 6.2) begins, enumerates 30 Steam CDN download sources for the operator's network cell, and fails to reach the single, sole-member, highest-priority (`priority_class: 6`) source `cache1-blv2.valve.org`. | SteamCMD `content_log.txt`; preserved cache snapshot directory name |
| 15:21:04 – 15:22:36 and later | Update mechanism retries automatically (script-level retry loop, default 3 attempts) approximately every 30 seconds; all attempts fail identically against the same host. 48 near-identical failure entries recorded across this window and later windows through the incident. | `content_log.txt` |
| ~15:38:35 | Local Steam app manifest is left in a failed state: `buildid: 0`, `UpdateResult: 7`, `InstalledDepots: {}` (empty) — the update job aborted with zero depots installed. The already-running game server processes continued operating on their previously-loaded binaries; this failure affects *future* updates, not the *currently running* instance directly. | `appmanifest_4754530.acf` |
| ~15:29 (approx.) | Separately: the host's hourly automated update-check timer (systemd) is discovered, later in this response, to have been failing every hour since at least 2026-07-22, due to a stale working-directory path left over from a prior repository relocation. This is **not** the proximate cause of the outage — the CDN issue would have blocked even a correctly-configured automatic update — but it meant no automated retry/alerting was active during the lead-up to this incident. | `journalctl` output for the relevant systemd service (48+ consecutive `203/EXEC` failures) |
| Unknown exact time (prior to operator engagement) | Players report being unable to find/join the server, via Discord and direct messages to the operator. | Operator report |
| Operator engagement (session start) | Operator engages incident response. | Operator statement |
| T+0 | Responding engineer begins triage. Initial internal status checks (container liveness, listener checks, database connectivity, Funcom heartbeat/population-declaration checks) report **all green** — a materially misleading signal relative to the player-reported outage. | Internal status-check output |
| T+~15 min | Responding engineer identifies that internal "all green" status does not by itself establish player-facing availability, and pivots to directly inspecting the installed Steam build state. | Session transcript |
| T+~20 min | The installed Steam app manifest shows `buildid: 0` and a `TargetBuildID` ahead of the installed build, confirming the update had been failing and the running server was behind the latest available Steam build. This is a confirmed fact; see Section 3 for the separate, inferential question of whether this build gap was *the* reason players could not find the server. | Direct file inspection inside the orchestrator container |
| T+~25–90 min | Methodical investigation of why the Steam update itself was failing. Ruled out, with evidence for each: local disk space (900GB free); local network/DNS health generally (other internet access worked); SteamCMD client staleness (already self-updated same day); `CellIDServerOverride` config changes (tested values had no effect on this specific API call path); TCP/IP-layer reachability of the target IP (reachable on port 80). Isolated to: the hostname `cache1-blv2.valve.org` returning NXDOMAIN across three independent DNS resolvers, while Valve's `IContentServerDirectoryService` API continued to return this hostname, consistently, as the sole member of the highest-priority source class for the operator's cell. | Session transcript; DNS lookups; raw `IContentServerDirectoryService` API responses (Section 8) |

### 2.3 Phase: Containment (Interim Player Communication)

| Time (UTC) | Event |
|---|---|
| T+~90 min | With the update failure understood but not yet fixed, the responding engineer drafted an interim player-facing status message (Section 9) describing what was known and what was still being worked, without asserting a guaranteed cause or ETA. |

### 2.4 Phase: Eradication (Remediation)

| Time (UTC) | Event |
|---|---|
| T+~95–110 min | Multiple remediation attempts made and ruled out, each with clear technical justification (full list in Section 5.6): a SteamCMD CLI cell-ID override flag (had no observable effect on this API call path); direct edits to a local SteamCMD config value for cell ID (persisted in the file, confirmed via inspection, but had no effect on the actual request observed in logs); an `/etc/hosts` override pointing the dead hostname at a live Steam CDN IP (DNS resolved, but the connection failed **TLS certificate hostname validation**, since that IP's real certificate does not cover the dead hostname — this is TLS working as intended, not a bug, and is the reason the eventual fix required more than a plain hosts-file redirect); forcing different low-level connection-failure modes to see whether SteamCMD's behavior changed (it did not — every variant produced the same fatal abort). |
| ~17:46–17:47 | **Remediation deployed**: a purpose-built, temporary local TLS-intercepting reverse proxy was started inside the orchestrator container for this single remediation action. Full technical and security description in Section 5.6 (attempt #7) and Section 5.7 — in summary, it decrypted and re-encrypted traffic locally using a self-signed certificate matching the dead hostname's name, which the container was made to trust for this purpose, and forwarded the resulting plaintext request to a different, reachable Steam CDN host. This is TLS interception, not end-to-end TLS between SteamCMD and Valve, and its security implications are discussed explicitly in Section 5.7. |
| 17:47:46 | The redirected path was validated by directly requesting the exact manifest URL SteamCMD had been failing on, through the proxy — the request returned `HTTP/1.1 200 OK` with a payload matching the expected size and content type for a Steam manifest response. |
| 17:47 – 17:49:20 | The Steam update was re-run through the intercepted path and completed: full download, full verification, all depots staged and mounted. SteamCMD reported a successful install. |
| 17:49:20 | The local Steam app manifest now showed a successful state: nonzero `buildid` matching the current published remote build, `UpdateResult: 0`, and populated `InstalledDepots`. This is the point at which the Steam-update failure itself was resolved; whether this alone restored player-facing visibility is addressed separately in Section 3 and Section 2.6. |

### 2.5 Phase: Recovery

| Time (UTC) | Event |
|---|---|
| 17:49–17:56 | New game-server container images were extracted from the newly-downloaded server files and loaded into the local Docker image store, confirmed tagged with a newer build identifier than what was previously loaded. |
| 17:56:00 | Full stack cold-started against the new images (database, message queue, routing/directory service, and the world-server processes) via the project's own orchestration tooling. |
| 17:56:06 – 17:57:53 | Database, message-queue, and routing services online and healthy. |
| 17:57:53 | The always-on overworld map process started on the new build (confirmed via an in-container engine-log line reporting a revision number newer than the previously-installed one). |
| 18:04:49 | The primary player-facing map instance started on the new build. |
| 18:06:18 | The gateway service started. |
| 18:07:58 | The directory/battlegroup-registry service started (a brief additional restart cycle was observed around this time; investigated and assessed as a benign first cold-start within the new orchestration cycle, not a crash — `docker inspect`'s restart counter was `0` throughout; see Section 5.8). |
| ~18:08–18:10 | The autoscaler component restarted and, as part of its normal reconciliation duties, respawned the always-on secondary map that is managed dynamically by that component. |
| 18:10:03 | The directory service's periodic population declaration to Funcom's registry protocol began reporting a nonzero configured player capacity, consistent with the battlegroup being correctly configured post-restart. This confirms our own service was declaring itself correctly to Funcom; it does not by itself confirm what, if anything, Funcom's browser was displaying to players before this point (see Section 3). |

### 2.6 Phase: Post-Incident Verification (Player Connectivity Confirmation)

This phase provides direct evidence that a real player connected and remained connected after the remediation — the strongest, most directly-verifiable measure of recovery available to this investigation. It does **not**, on its own, prove what Funcom's public in-game server browser was displaying at any specific prior time; see Section 3 for that distinction.

| Time (UTC) | Event | Evidence Source |
|---|---|---|
| 18:10:27 | Directory-service log records an explicit player travel-request/arrival transaction for one Funcom Live Services (FLS) player identifier, to a specific world partition on the primary map instance, resolving as an already-completed, successful connection. (FLS ID and partition/server identifiers redacted in this report; preserved in the operator's own internal logs.) | Directory service container log |
| 18:10:31 | A corresponding message-queue-mediated travel-completion event was received and processed for the same player identifier, partition, and server, with matching flow/request correlation IDs. | Directory service container log |
| 18:10:32 | **Database-level confirmation**: the player-state table/view showed one specific character record (belonging to the operator) with `online_status = Online`, `life_state = Alive`, `character_state = Active`, and a server identifier matching the log entries above, with a login timestamp five seconds after the travel-completion log entry — consistent with normal state-write latency. (Character name and server identifier redacted.) | Live database query |
| 18:10:32 | Cross-referenced against the world-partition table: the same server identifier mapped to a real, unblocked, active partition on the newly-updated server, not stale/orphaned state. | Live database query |
| 18:11:03 – 18:17:04 (and ongoing at time of writing) | The directory service's periodic population declarations to Funcom showed the reported active-player count transitioning from 0 to 1 at 18:11:03 and remaining at 1 continuously across every subsequent declaration through at least 18:17:04 (7+ consecutive minutes, roughly one declaration per minute) — ruling out a single false-positive blip and indicating a sustained, stable connection from our own service's point of view. | Directory service container log, population-declaration entries |
| 18:17+ | Operator directly confirmed in-session being connected in-game, alongside a transient `WAIT` state on one internal heartbeat check (which cleared on the next polling interval, consistent with the directory service's restart at 18:07:58). A subsequent status poll showed the stack fully healthy with a nonzero reported player count. | Operator statement + internal status-check output |

**What this phase establishes, and what it does not**: this evidence conclusively shows that (a) our own service was declaring a connected player to Funcom's backend, and (b) our own database recorded that connection consistent with a real, successful session. It does **not** independently confirm that Funcom's separate, official in-game server browser was displaying the server as joinable to the general public at any specific timestamp before or after the fix — no direct access to that browser's data source or Funcom-side logs was available to this investigation. The player who connected did so with direct knowledge of the server (the operator), which does not by itself demonstrate general public discoverability. See Section 3 for the resulting confidence level on the browser-delisting explanation, and Section 5.4 for a corrected note on `dunedocker.app`, which was considered and rejected as a proxy for Funcom-browser visibility.

---

## 3. Root Cause Analysis (RCA) — Confidence-Graded

This section separates confirmed facts from inference, per item, rather than presenting a single blended narrative.

### 3.1 Confirmed facts (directly evidenced, low ambiguity)

- SteamCMD's update job for this application failed repeatedly over an extended window, every time attempting the same content-server hostname first and failing to reach it.
- That hostname was unresolvable (NXDOMAIN) via three independent DNS resolvers at the time of testing.
- Valve's `IContentServerDirectoryService` API, queried directly and repeatedly by this investigation, consistently returned that same hostname as the sole member of the highest-priority download-source class for the network cell used in these queries.
- The locally-installed game server's Steam app manifest was left in a failed-update state (`buildid: 0`, no depots) for the duration of the failure window, and was confirmed successfully updated (nonzero `buildid` matching the current remote build, depots populated) after the remediation in Section 2.4.
- After the update succeeded and the stack was cold-started on the new build, a real player connection was confirmed via directory-service logs and a live database query (Section 2.6), and that connection persisted for at least 7 minutes.

### 3.2 Reasonable inference, not independently confirmed

- **That the stale Steam build was the reason (or the sole reason) the server was not discoverable/joinable by the general playerbase in Funcom's official in-game server browser specifically.** This is the responding engineer's best explanation, consistent with (a) the general, publicly-known behavior of live-service games delisting stale server builds from matchmaking/browser services, and (b) the sequence of events (update fixed → stack restarted → a real connection succeeded shortly after). However: the remediation changed multiple variables simultaneously — the Steam build, every container image, and a full cold-start of every core service — so this investigation cannot fully rule out that some other factor contributed to or fully explains the restored connectivity (for example, a stale registration or a stuck connection state that a full restart alone would have cleared, independent of the build version). No Funcom-side documentation, API, support ticket, or log access was consulted to confirm the delisting mechanism directly. This should be treated as a strong, plausible hypothesis, not an established mechanism, unless and until it can be corroborated by Funcom-side evidence.

### 3.3 Hypotheses, explicitly flagged as unconfirmed

- **That `cache1-blv2.valve.org` is a "decommissioned" CDN node.** What is confirmed is that the hostname does not resolve in DNS and that Valve's directory service kept advertising it anyway. Whether this reflects an intentional decommissioning, a DNS-management error, a transient outage, or something else on Valve's side is not established by this investigation and should be treated as an open question, not a determined fact.
- **That the priority-class difference between the 2026-07-17 successful run and the 2026-07-24 failing runs represents a confirmed "server-side regression" on Valve's part.** What is confirmed is that the two runs' logs show a different priority-class value and different observed fallback behavior. The inference that this reflects a deliberate or accidental change on Valve's infrastructure, rather than some other explanation (e.g., a request-time or account-context difference this investigation did not control for), is plausible but not verified against any Valve-side source.
- **That the client-side fallback behavior (aborting the whole update job on failure of the sole top-priority-class source) is "entirely unconfigurable."** What is confirmed is that the specific configuration options tried during this incident (a CLI flag, a local config-file value) had no observed effect. This does not exhaustively rule out every possible SteamCMD configuration option, environment variable, or alternate invocation that might influence this behavior; it reflects the options attempted within the time constraints of this incident, not an exhaustive audit of SteamCMD's configuration surface.

### 3.4 Contributing factor (confirmed, local)

The host's automated hourly self-update safety net had been silently non-functional since at least 2026-07-22, due to a stale working-directory path left over from an earlier repository relocation. This did not cause the incident — the underlying Steam CDN issue would have blocked even a correctly-configured automatic update — but its failure meant no automated retry or alerting was active during the lead-up to this incident. This defect was identified and the broken timer was disabled during this response.

### 3.5 Why internal "all green" health checks did not reflect the outage

The operator's existing status tooling checks container liveness, listening ports, database connectivity, and the directory service's own heartbeat/population-declaration signals to Funcom — all of which remained genuinely healthy throughout, because the already-running game server processes were unaffected by the failed *future* update attempt. There is no existing check for "is our installed build version current enough to remain visible to players via Funcom's systems" — this is a real, identified gap in the operator's own tooling (Section 7, R1), independent of the confidence-graded root-cause discussion above.

---

## 4. Impact Assessment

| Dimension | Assessment |
|---|---|
| **Confidentiality** | No impact identified. No credential, account, or PII exposure identified during this incident or its remediation. |
| **Integrity** | No impact identified. Post-recovery database queries for player and world-partition state returned clean, internally-consistent results. |
| **Availability** | Player reports and the subsequent investigation are consistent with the server having been unjoinable/undiscoverable by players for an extended period; the precise mechanism (Funcom browser delisting vs. some other factor) is inferred, not confirmed (Section 3). Whether the server remained reachable via direct connect (if a player already had the IP/port) throughout the outage was not tested during this incident and is a real gap in this investigation's own diagnostic coverage. |
| **Data Loss** | None identified. The world-server processes remained continuously running throughout the update-failure window; only the *update mechanism*, not the *live server process*, was affected until the operator-approved stop/restart performed as part of remediation. |
| **Reputational** | Player-reported message volume to the operator during the outage window, as described by the operator. Addressed in real time with an interim status message (Section 9) once the update failure was understood, rather than remaining silent — this did not wait for full root-cause confirmation of the browser-delisting mechanism. |
| **Blast Radius** | Limited to this operator's single self-hosted game server instance and its player base, as far as this investigation determined. No claim is made about whether other self-hosted operators using the same network cell experienced the same Steam CDN issue; this was not investigated. |

---

## 5. Technical Deep-Dive

### 5.1 Steam CDN Directory Service Behavior (Confirmed Observation)

Direct, repeated queries (15 consecutive calls over several minutes) against Valve's public `IContentServerDirectoryService::GetServersForSteamPipe` API, using the network cell ID observed in this operator's own SteamCMD logs, returned **100% consistent results** across every call: the dead hostname first, in the sole highest-priority class, on every single call. Several `steamcontent.com`-suffixed alternatives in a lower-but-adjacent priority class were independently confirmed reachable (DNS-resolvable, TCP-connectable, valid TLS certificate, and serving correct manifest content via a direct request).

### 5.2 DNS Confirmation of Unresolvable Host (Confirmed)

The dead hostname returned NXDOMAIN consistently across three independent, non-caching-related DNS infrastructure providers: the system's default resolver, Google Public DNS, and Cloudflare's DNS-over-HTTPS service. This rules out local DNS cache poisoning, split-horizon DNS misconfiguration, or a single resolver's fault as the explanation — the hostname was genuinely unresolvable via the global DNS system at the time of testing. **What this does not establish**: why the hostname is unresolvable, or whether this is permanent — see Section 3.3.

### 5.3 Comparison to the 2026-07-17 Successful Update (Confirmed Observation, Inferred Explanation)

Log comparison between the successful 2026-07-17 run and the failing 2026-07-24 runs shows the *only* material behavioral difference visible in the logs was the priority-class value SteamCMD assigned to the request set: a lower-numbered class on 2026-07-17, under which the client attempted multiple hosts in parallel and succeeded when the dead host failed, versus the highest-priority class on 2026-07-24, under which the client appears to require the sole class member to succeed before proceeding, with no observed fallback. This class assignment is returned by Valve's directory service, not set by any local configuration observed in this investigation. Whether this represents a change on Valve's side between these two dates (Section 3.3) or some other explanation not identified by this investigation is not conclusively established.

### 5.4 Relationship Between Update Status and Player-Visible Availability (Partially Inferred — see Section 3)

The general, publicly-documented behavior of live-service games with self-hosted server options is that server builds significantly behind the current live client version may be hidden from official server-browser/matchmaking surfaces, as a compatibility-protection measure. This investigation's evidence (build was stale, update fixed, connection succeeded afterward) is **consistent with** that general behavior applying here, but this was not independently confirmed via Funcom-specific documentation, support contact, or direct inspection of what the official in-game browser displayed at any point during the incident. This should be read as the most likely explanation available from the evidence, not a proven mechanism.

**Correction regarding `dunedocker.app`**: an earlier internal consideration of this incident referenced the operator's own `dunedocker.app` community-listing integration as a potential corroborating signal. This is incorrect and has been removed from this report's evidentiary claims: `dunedocker.app` is the operator's own self-serve community website listing, which receives heartbeats directly from this project's own service (`publicDirectory.js`) — it can confirm that our own service was reporting itself as up, but it has no connection to and cannot confirm what Funcom's separate, official in-game server browser was displaying to players at any given time. It was not, and should not have been treated as, evidence of Funcom-browser visibility. See R4 in Section 7 for a corrected recommendation.

### 5.5 Why the Currently-Running Server Was Not Directly Restarted by the Failed Update Alone

The *currently running* game server process is unaffected by a failed *future* SteamCMD update — the process keeps running on its already-loaded binary and assets. The failed update only affects what would be installed on the *next* start. This is a confirmed mechanical fact about how the update pipeline and the running server process relate to each other, independent of the separate, inferred question of what Funcom's browser was doing during this window (Section 3.2).

### 5.6 Remediation Attempts Log (Full, Including Unsuccessful Attempts)

Every remediation approach attempted is recorded here, in chronological order, with outcome and reasoning, to avoid future responders re-treading the same dead ends.

| # | Attempt | Outcome | Reason |
|---|---|---|---|
| 1 | Simple retry of the update command (built-in retry loop, 3 attempts) | Failed | All attempts hit the identical unreachable host; no host-selection variance observed across retries. |
| 2 | SteamCMD CLI cell-ID override flag | No observed effect | Log inspection showed the same cell ID in use regardless; this flag did not appear to affect the specific API call path observed. |
| 3 | Direct edit of a local SteamCMD config value for cell ID (tried two different values) | No observed effect | The edit persisted in the file (confirmed via direct inspection), and one of the tested cell-ID values was independently confirmed via a direct API test to return an entirely different, healthy set of CDN hosts with no dead host present — but the actual running SteamCMD process's directory-service request, as observed in logs, continued to report the original cell ID regardless of the local file's contents. This suggests (but does not conclusively prove, absent SteamCMD source-level confirmation) that this specific request path derives its cell ID from a source other than this local config value. |
| 4 | `/etc/hosts` override pointing the dead hostname directly at a live Steam CDN IP | Failed (as expected for HTTPS) | DNS resolution succeeded, but the TLS handshake failed on certificate hostname validation, since the live IP's real certificate is scoped to its own real hostname. This is TLS behaving correctly, not a defect; it demonstrates why a plain hostname redirect cannot work against a real HTTPS CDN without also addressing certificate validation (see attempt #7). |
| 5 | Five rapid-fire sequential retries (testing for short-term directory-service variance) | Failed | Identical failure signature and host selection across all five attempts, at the time tested. |
| 6 | Alternate SteamCMD depot-download command, bypassing the normal app-update path | Failed differently | Rejected with a licensing-related error; anonymous login could not use this command path for this application. Unrelated dead end, reverted immediately. |
| 6b | Variation testing of the connection-failure mode (pointed the dead hostname at localhost, then at a reserved/unroutable test address) | Failed | Both produced the same fatal abort of the entire update job, regardless of how quickly or in what manner the connection failed — indicating the abort-on-single-source-failure behavior observed in this SteamCMD build does not depend on the specific failure mode (DNS vs. TCP-refused vs. unreachable). |
| 7 | **Remediation used**: a local TLS-*intercepting* reverse proxy, presenting a locally-generated, locally-trusted self-signed certificate matching the dead hostname's name, forwarding the resulting decrypted request to a different, reachable Steam CDN host | **Update completed** | This addresses the certificate-validation obstacle that blocked attempt #4, but — see Section 5.7 — this is achieved via controlled TLS interception inside a container the operator fully controlled, not via genuine end-to-end TLS between SteamCMD and Valve. This distinction, and its implications, are discussed explicitly below rather than glossed over. |

### 5.7 Security Note on the Remediation (TLS Interception, Not End-to-End TLS)

The working remediation in attempt #7 above is a **man-in-the-middle interception** of SteamCMD's traffic to the dead hostname, performed deliberately and locally by an operator with full administrative control of the affected container, for the specific, narrow purpose of completing one update. It is important to describe this precisely rather than understating it:

- It creates **two separate TLS sessions**: one between SteamCMD and the local proxy (using a certificate generated on the fly and explicitly, locally trusted for this purpose), and a second, independent TLS session between the local proxy and the real, healthy Steam CDN host. SteamCMD's TLS session terminates at the proxy, not at Valve's real infrastructure — SteamCMD has no cryptographic assurance about what happens after that point.
- It required modifying the **trust configuration of the container itself** (installing a new locally-generated certificate authority into that container's trust store) so that the interception would not be rejected by certificate validation. This is a real, if narrowly-scoped and temporary, weakening of that container's TLS trust boundary for the duration the certificate was present.
- It relied on the operator's own judgment, at the time, that the actual content being fetched (a public game-update manifest and depot data, not any secret or user-specific payload) made this an acceptable one-time tradeoff under outage pressure — this was a manual decision made with full context, not something that should be treated as a general policy.
- No credentials, tokens, or user-specific data were observed to transit this interception; the traffic involved was Steam's public content-delivery data.

This is documented here in full so that this technique is understood as what it actually is if referenced or reused in the future — see Section 7, R2, for why this should **not** become an automated or default remediation path, and R5 for how it should instead be documented (as an expert-only, manual emergency procedure with explicit warnings, not standard updater behavior).

### 5.8 Directory Service Restart During Recovery — Assessed as Benign

The directory/battlegroup-registry service was observed to have a comparatively short uptime relative to other core services during the recovery window, with a brief additional restart cycle around 18:07:58. The container's restart counter (via `docker inspect`) was confirmed to be `0` throughout — no crash occurred; this was the container's normal first cold-start within the new orchestration cycle (visible in logs as ordinary service startup activity), not a fault requiring separate remediation.

---

## 6. Detection Gap Analysis

### 6.1 Gap: No Build-Version-vs-Visibility Health Check

The operator's existing status tooling has no check for "is our currently-installed game build recent enough to remain visible to players via Funcom's systems." Every existing check remained green throughout the outage. The only detection mechanism that functioned was players independently reporting the problem — a reactive path, not a proactive one. See R1 in Section 7.

### 6.2 Gap: Unknown Exact Failure-Onset Time and Trigger

The earliest observed failed update attempt in the logs is at approximately 15:21:04 UTC, roughly 2 hours 49 minutes before confirmed player-facing recovery. This has two disclosed limitations:

1. **The exact trigger of that first attempt is not conclusively determined** — it may have been the last successful firing of the (separately broken) automated hourly timer before its path went stale, or a different manual/scripted trigger. The evidence does not distinguish between these with confidence.
2. **The true start of player-facing impact is likely earlier than 15:21:04 UTC** and is not independently established by this investigation, since there was no direct visibility into Funcom's own server-browser state, and the first player report has no precise recorded timestamp. The "~2h49m" figure in this report should be read as a conservative lower bound on total impact duration, not a precise total. See R4.

### 6.3 Gap: Automated Update Safety Net Silently Broken for 48+ Hours Prior

The hourly automated update-check timer had been failing silently (at the systemd level, not in a way that would surface in application logs) since at least 2026-07-22 — over 48 consecutive hourly failures — with no alerting to the operator. This is a monitoring/alerting gap independent of, but compounding, the primary incident.

---

## 7. Recommendations (Corrective and Preventive Actions)

These recommendations were checked against the current state of both this operator's fork and the real upstream project (`Red-Blink/dune-awakening-selfhost-docker`, latest published release `v1.3.64`) as of this report's revision date. **As of that check, the relevant scripts (`runtime/scripts/update.sh` and the orchestrator's download routine) are byte-identical between this fork and upstream, and neither contains CDN-host-failure detection, backoff/jitter beyond the existing fixed-interval retry, priority/host-selection logging, or systemd-timer-path validation.** An earlier internal draft of this report incorrectly asserted that upstream already addressed parts of these recommendations; that assertion was not verified before being written and has been corrected here. All items below remain open, unimplemented recommendations as of this revision.

| # | Priority | Recommendation | Rationale |
|---|---|---|---|
| **R1** | **P1 — High** | Add a health check that compares the locally-installed Steam build identifier against the latest remote build identifier reported by Steam, and surfaces a distinct, clearly-labeled "build is behind current — may affect player-facing visibility" warning, separate from existing infrastructure-health checks. This is phrased deliberately as a possibility, not a certainty, consistent with Section 3's confidence grading — the check should not assert a guaranteed browser-delisting outcome it cannot itself confirm. |
| **R2** | **P1 — High, but scoped narrowly** | Improve the *automated* update pipeline's handling of a single unreachable top-priority content-source: e.g., detect that the selected host is unreachable and log this clearly, add real backoff/retry against the *same* directory-service response before giving up, and/or surface enough diagnostic detail (selected host, priority class) for a human to diagnose the same class of failure faster next time. **This recommendation explicitly does not extend to automating the TLS-interception technique used in this incident** (installing a CA, intercepting Steam traffic, rewriting hostnames, forwarding to a different CDN) as routine or automatic updater behavior — that technique is security-sensitive, brittle against Valve-side changes, and was a manual, fully-informed, one-time decision by an operator with full context, not something that should run unattended or without explicit human awareness each time. See R5 for the appropriate way to preserve this technique for future use. |
| **R3** | **P1 — High** | Repair the automated hourly self-update systemd timer against the current, correct repository path, and add alerting if the underlying service fails N consecutive times — closing the Section 6.3 gap. Also consider a startup/periodic self-check that detects when a systemd unit's configured working directory or executable path no longer exists on disk (the actual failure mode in this incident), independent of the update-specific timer, since this class of failure (stale path after a repo relocation) could recur for other scheduled jobs. |
| **R4** | **P2 — Medium** | Investigate a genuine external check of player-facing discoverability, rather than relying on `dunedocker.app`'s heartbeat (which, per the Section 5.4 correction, only confirms our own service is reporting to itself, not that Funcom is listing it). This may require researching whether Funcom exposes any public server-list or status API suitable for this purpose; if none exists, this recommendation should be revised to rely on faster player-facing feedback channels instead, rather than a synthetic check that cannot actually verify the thing it claims to verify. |
| **R5** | **P2 — Medium** | Document the TLS-interception CDN-bypass technique (Section 5.6, attempt #7; Section 5.7) as an **expert-only, manual emergency runbook procedure** — not as an automated fallback (see R2). The runbook should explicitly state: what TLS interception is and is not doing (Section 5.7), the conditions under which it is an acceptable tradeoff (public, non-sensitive content only), step-by-step setup and — critically — verified cleanup instructions (removing the generated CA trust, the proxy process, and any hosts-file entries), and an explicit warning that this is not standard operating procedure. |
| **R6** | **P3 — Low** | Consider reporting the specific unreachable CDN hostname and the observed all-or-nothing single-source fallback behavior to Valve/Steamworks, as a data point for their own review — but frame this to Valve as an observation with the operator's own network cell and timestamp, not as an asserted defect, since this investigation could not confirm the underlying cause of either observation (Section 3.3). |
| **R7** | **P3 — Low** | Formalize the player communication process for outages of uncertain root cause — the interim status message used in this incident (Section 9) was effective but improvised, and correctly avoided overclaiming certainty about the cause at the time it was posted. A pre-approved template that structurally separates "what we know" from "what we suspect" would help maintain that discipline under pressure in future incidents. |

---

## 8. Evidence Appendix (Raw Data Excerpts, Redacted)

Public IP addresses, battlegroup identifiers, FLS/player identifiers, character names, internal server IDs, and operator-specific filesystem paths have been redacted or replaced with placeholders below. The original, unredacted data remains in the operator's own internal logs.

### 8.1 Failed Update — SteamCMD Manifest State (Prior to Fix)

```
"AppState"
{
    "appid"                 "4754530"
    "buildid"               "0"
    "UpdateResult"          "7"
    "TargetBuildID"         "24333838"
    "InstalledDepots"
    {
    }
}
```

### 8.2 Successful Update — SteamCMD Manifest State (After Fix)

```
"AppState"
{
    "appid"                 "4754530"
    "StateFlags"            "4"
    "LastUpdated"           "<redacted-timestamp>"
    "SizeOnDisk"            "5207498312"
    "buildid"               "24376904"
    "UpdateResult"          "0"
    "BytesToDownload"       "4880966032"
    "BytesDownloaded"       "4880966032"
    "BytesToStage"          "5207498312"
    "BytesStaged"           "5207498312"
    "TargetBuildID"         "24376904"
    "InstalledDepots"
    {
        "4754532"
        {
            "manifest"      "7470835453788624792"
            "size"          "5207498312"
        }
    }
}
```

### 8.3 Representative Failure Log Entry (repeated 48 times across the incident window)

```
[2026-07-24 17:26:58] Got 30 download sources and 0 caching proxies via
  ContentServerDirectoryService::BYieldingGetServersForSteamPipe (CellID <redacted> / Launcher 3)
[2026-07-24 17:26:58] Moving to source priority class '6'
[2026-07-24 17:26:58] Created download interface of type 'SteamCache' (7)
  to host cache1-blv2.valve.org (cache1-blv2.valve.org)
[2026-07-24 17:26:59] HTTPS (SteamCache,450) - cache1-blv2.valve.org
  (0.0.0.0:443 / 0.0.0.0:443, host: cache1-blv2.valve.org):
  cache1-blv2.valve.org/depot/4754532/manifest/... - failed to send manifest request
[2026-07-24 17:26:59] AppID 4754530 update canceled : Failed downloading 1 manifests
  (Connection timeout)
```

### 8.4 DNS Confirmation (Cloudflare DNS-over-HTTPS, independent of local resolver)

```json
{
  "Status": 3,
  "Question": [{"name": "cache1-blv2.valve.org", "type": 1}],
  "Authority": [{"name": "valve.org", "type": 6, "data": "ns1.valvesoftware.com. admin.valvesoftware.com. ..."}]
}
```
(`Status: 3` = NXDOMAIN)

### 8.5 Content-Server Directory API Raw Response (excerpt, operator's network cell)

```json
{"type": "SteamCache", "source_id": 450, "cell_id": "<redacted>", "priority_class": 6,
 "host": "cache1-blv2.valve.org", "https_support": "mandatory"}
{"type": "SteamCache", "source_id": 422, "cell_id": "<redacted>", "priority_class": 5,
 "host": "cache7-sea1.steamcontent.com", "https_support": "mandatory", "group": "sea-general"}
```

### 8.6 Successful Intercepted-Path Manifest Fetch (Remediation Validation)

```
> GET /depot/4754532/manifest/7470835453788624792/5/13020187876919183990 HTTP/1.1
> Host: cache1-blv2.valve.org
< HTTP/1.1 200 OK
< Server: nginx/1.29.8
< Content-Type: application/x-steam-manifest
< Content-Length: 166406
< X-Cache-Status: HIT
```

### 8.7 Player-State Database Evidence (Connectivity Confirmation, Redacted)

```sql
SELECT character_name, account_id, server_id, life_state, online_status,
       character_state, previous_server_partition_id, last_login_time
FROM dune.player_state
WHERE character_name ILIKE '<redacted>';
```
```
 character_name | account_id |       server_id        | life_state | online_status | character_state | previous_server_partition_id |        last_login_time
----------------+------------+------------------------+------------+---------------+------------------+-------------------------------+--------------------------------
 <redacted>     | <redacted> | <redacted-server-id>   | Alive      | Online        | Active           |                        <redacted> | 2026-07-24 18:10:32.400085+00
```

```sql
SELECT partition_id, server_id, map, label, blocked
FROM dune.world_partition
WHERE server_id = '<redacted-server-id>';
```
```
 partition_id |       server_id        |    map     |    label      | blocked
--------------+------------------------+------------+---------------+---------
 <redacted>   | <redacted-server-id>   | <redacted> | <redacted>    | f
```

### 8.8 Directory-Service Application-Log Corroboration (Redacted)

```
[18:10:27] Player <redacted-fls-id> requested WorldPartition { PartitionId = <redacted>,
  ServerId = <redacted-server-id>, Map = <redacted>, Label = "<redacted>" }
  and is in WorldPartition { ...same... }. No action needed.

[18:10:31] Received the following travel completion: TravelCompletion
  { RequestID = <redacted>, FlsId = <redacted-fls-id>,
    FlowId = <redacted>, MapName = <redacted>,
    PartitionId = <redacted>, ServerID = <redacted-server-id>,
    OriginId = <redacted> }

[18:11:03] Population declaration: {"BattlegroupCurrentActive":1, ...
  "ServerIdToPopulationAndActivityMap":{"<redacted-server-id>":
  {"CurrentActive":1, ...}}}
```
(`BattlegroupCurrentActive: 1` confirmed sustained continuously through 18:17:04 across 7+ consecutive per-minute declarations.)

### 8.9 Final Post-Recovery Status Poll

```
=== Dune status ===
Overall:     READY
Population:  1/60
...
Game servers:
MAP          STATE        UPTIME
<redacted>   READY        Up 12 minutes
<redacted>   READY        Up 19 minutes
...
Funcom/FLS summary:
Director heartbeat:       OK
Population declaration:   OK
Max capacity declaration: OK
Gateway DB monitoring:    OK
```

(Note: "Funcom/FLS summary: OK" here reflects our own service's heartbeat/declaration checks to Funcom's backend succeeding — it is not itself confirmation of public server-browser listing status; see Section 3 and Section 5.4.)

---

## 9. Communications Log

### 9.1 Interim Player Status Message (drafted during investigation, prior to fix)

> **Server Status Update — Known Issue, Investigating**
>
> Hey everyone — we know the server isn't showing up in the in-game server browser right now. Here's what's going on:
>
> - The server itself is up and healthy behind the scenes.
> - It's currently stuck on an older game version because our update process is hitting a broken Steam CDN node on Valve's side (not something on our end we can just restart our way out of).
> - Because of that version mismatch, the game client won't list us in the browser until the update completes.
>
> We're actively working on a workaround to force the update through a different Steam content server. No ETA yet, but we'll post again as soon as it's back and visible. Thanks for your patience — sorry for the radio silence while we dig into it.

### 9.2 Resolution Status Message (recommended, for operator to post)

> **Server Status — Resolved ✅**
>
> The server is back and players are connecting successfully. The update that had been stuck went through, and the server's on the current build. If you still have trouble finding it in the browser after this, let us know — thanks for your patience!

(Revised from the original draft, which asserted with more certainty than this report's Section 3 supports that the browser-visibility issue was fully and specifically explained by the build version.)

---

## 10. Workaround Retirement Notice

The temporary local TLS-intercepting reverse proxy and its accompanying hosts-file override and locally-generated CA trust entry, deployed inside the orchestrator container as the tactical remediation for this incident (Section 5.6, attempt #7; security implications in Section 5.7), were transient and container-local. They did not survive the subsequent container recreation performed as part of the normal recovery sequence (Section 2.5), and were confirmed, post-recovery, to leave no residual artifacts in the current running container: no lingering proxy process, no stray hosts-file entry, no stray CA trust entry. No manual cleanup action was required in this instance. This should not be read as evidence that the technique is safe to leave running unattended in general — see R5 for why it should be documented as a manual, verified-cleanup emergency procedure rather than assumed to always self-clean.

---

## 11. Sign-Off

| Item | Status |
|---|---|
| Confirmed facts documented and evidenced separately from inference | ✅ Yes — Section 3, Section 8 |
| Remediation deployed and validated | ✅ Yes — Section 2.4, Section 8.6 |
| Real player connectivity confirmed post-remediation (database + application log) | ✅ Yes — Section 2.6, Section 8.7–8.9 |
| Claim of Funcom-browser-visibility restoration | ⚠️ Presented as inference, not confirmed fact — Section 3.2 |
| No data loss / no integrity impact identified | ✅ Confirmed via database checks performed |
| Security implications of the remediation itself documented | ✅ Yes — Section 5.7 |
| Recommendations checked against current upstream state | ✅ Yes — Section 7 (R2/R3 confirmed still open, not already implemented) |
| Operator-identifying details redacted | ✅ Yes — Section 8 and throughout |
| Preventive recommendations documented | ✅ Yes — Section 7 |
| Temporary workaround fully retired / no residual risk in this instance | ✅ Confirmed — Section 10 |

**Incident Status: CLOSED** (as an operational matter — the update succeeded and player connectivity was confirmed). **Root-cause attribution for browser-visibility specifically remains a graded inference, not a fully closed determination** — see Section 3.

---

## 12. Revision Notes

This report was revised from its original version following technical review. Changes made:

1. Reframed the TLS-bypass remediation accurately as controlled TLS interception (two separate TLS sessions, local trust modification), not end-to-end TLS, with an explicit new security-implications section (5.7).
2. Downgraded the claim that the stale build was confirmed to be the reason for Funcom browser delisting to a graded inference, given that the recovery process changed multiple variables at once and no Funcom-side evidence was available (Section 3, Section 5.4).
3. Downgraded several Valve-specific conclusions — "decommissioned" node, "regression" in priority-class assignment, "entirely unconfigurable" fallback — from stated facts to explicitly-labeled hypotheses (Section 3.3).
4. Removed the recommendation to turn the TLS-interception workaround into an automatic/production fallback; replaced with a narrower R2 (improve automated retry/diagnostics only) and a revised R5 (document as an expert-only manual emergency procedure with explicit warnings and verified cleanup steps, not standard behavior).
5. Checked R2/R3 against the actual current state of both this fork and real upstream (`Red-Blink/dune-awakening-selfhost-docker`, latest release `v1.3.64`) before finalizing — confirmed the relevant scripts are unchanged and identical between fork and upstream, and corrected an earlier, unverified draft claim that upstream already addressed parts of these recommendations.
6. Removed `dunedocker.app` as evidence of Funcom-official-browser visibility; corrected to state it only confirms the operator's own service is heartbeating to itself (Section 5.4).
7. Redacted public IP, battlegroup ID, FLS/player identifiers, character name, internal server IDs, and operator-specific filesystem paths throughout (Section 8 and elsewhere).
8. Re-framed the document as an operator-specific case study in the title and opening scope note, rather than a project-wide confirmed-incident report.
