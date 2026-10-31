import test from "node:test";
import assert from "node:assert/strict";
import { buildMapStatusResponse, buildMapsListResponse, buildServerStatusResponse, parseBackupAutoStatus, parseBackupListRows, parseDoctorWarnings, parseFlsSummary, parseHomeStatus, parseMapListRows, parseMemoryStatusRows, parsePortRows, parseRabbitConnections, parseReadyRows, parseServerPartitionRows, parseSkillModules, parseStatusGameServers, parseStatusListenerRows } from "../src/statusParsers.js";

const healthyStatus = `=== Dune status ===
Overall:     READY
Title:       My Local Dune
Region:      Europe
Mode:        public
Server IP:   37.76.210.36
Battlegroup: test-bg
Population:  0/60

=== Database ===
World partitions: 30

=== RabbitMQ game connections ===
Director connections:    1
Game server connections: 4
TextRouter connections:  0

=== Funcom/FLS summary ===
Director heartbeat:       OK
Population declaration:   OK
Max capacity declaration: OK
Gateway DB monitoring:    OK`;

const healthyReady = `=== Container checks ===
OK   container dune-postgres
OK   container dune-rmq-admin
OK   container dune-rmq-game
OK   container dune-text-router
OK   container dune-director
OK   container dune-server-gateway
OK   container dune-server-survival-1
OK   container dune-server-overmap

=== Listener checks ===
OK   TCP 15432 Postgres localhost
OK   TCP 32573 RabbitMQ admin localhost
OK   TCP 31982 RabbitMQ game public
OK   TCP 31983 RabbitMQ game HTTP public
OK   TCP 5059 TextRouter localhost
OK   TCP 11717 Director localhost
OK   UDP 7777 Overmap clients
OK   UDP 7778 Survival_1 clients
OK   UDP 7888 Survival_1 S2S
OK   UDP 7889 Overmap S2S

=== Database world partition checks ===
OK   world_partition rows: 30

=== Readiness log checks ===
OK   Survival_1 ready
OK   Overmap ready
OK   Director FLS population
OK   Gateway monitoring DB

=== Dynamic game map checks ===
OK   no dynamic game maps currently running

=== RabbitMQ game users ===
OK   game server sg.* RMQ connections

READY: Dune Awakening Self-Host Docker stack looks healthy.`;

const healthyStatusWithSections = `${healthyStatus}

=== Containers ===
SERVICE                    STATUS
dune-postgres              Up 29 minutes
dune-rmq-admin             Up 29 minutes
dune-rmq-game              Up 29 minutes
dune-text-router           Up 29 minutes
dune-director              Up 2 minutes
dune-server-gateway        Up 29 minutes
dune-server-survival-1     Up 29 minutes
dune-server-overmap        Up 29 minutes
dune-orchestrator          Up 29 minutes

=== Listeners ===
CHECK                    PORT     STATUS
Postgres localhost       15432/tcp OK
RabbitMQ admin           32573/tcp OK
RabbitMQ game            31982/tcp OK
RabbitMQ game HTTP       31983/tcp OK
TextRouter               5059/tcp OK
Director                 11717/tcp OK
Overmap clients          7777/udp OK
Survival_1 clients       7778/udp OK
Survival_1 S2S           7888/udp OK
Overmap S2S              7889/udp OK
DeepDesert_1 clients     7786/udp OK
DeepDesert_1 S2S         7897/udp OK

=== Game servers ===
MAP          STATE        UPTIME
Survival_1   READY        Up 29 minutes
Overmap      READY        Up 29 minutes`;

const mapsListOutput = `SH_Arrakeen                  Current: dynamic   Partitions: 1   Assigned: 0
DeepDesert_1                 Current: dynamic   Partitions: 1   Assigned: 0
CB_Dungeon_ThePit            Current: always-on Partitions: 1   Assigned: 1
SH_HarkoVillage              Current: overmap-active Partitions: 1   Assigned: 0
Story_ProcesVerbal           Current: disabled  Partitions: 1   Assigned: 0`;

const memoryStatusOutput = `=== Memory configuration ===
Default memory: built-in per-map defaults, or server catalog for other dynamic maps

MAP                          MEMORY
Survival_1                   16g default
Overmap                      3g default
DeepDesert_1                 16g default
Survival_1:1                 16g default
Survival_1:31                16g default
CB_Dungeon_ThePit            13Gi`;

const serversOutput = `=== Dune server partitions ===
 partition_id |                map                 | dim |             label              |    assigned_server     | game_port | igw_port | ready | alive
--------------+------------------------------------+-----+--------------------------------+------------------------+-----------+----------+-------+-------
            1 | Survival_1                         |   0 | Abbir                          | KaLlYa2RToK+eMbbBZe0Zw | 7778      | 7888     | true  | false
            2 | Overmap                            |   0 | Overland                       | KJqZ3FXJR0OKwghAsOfsRg | 7777      | 7889     | true  | true
            8 | DeepDesert_1                       |   0 | DeepDesert_0                   |                        |           |          |       |
(30 rows)`;

const postgresBooleanServersOutput = `=== Dune server partitions ===
 partition_id |                map                 | dim |             label              |    assigned_server     | game_port | igw_port | ready | alive
--------------+------------------------------------+-----+--------------------------------+------------------------+-----------+----------+-------+-------
            3 | SH_Arrakeen                        |   0 | Arrakeen                       | Wt8UaAi5QrumxjclQehfpQ | 7800      | 7900     | t     | t
            4 | SH_HarkoVillage                    |   0 | HarkoVillage                   | 2oB5rNdVR_OSiKWcurBLAQ | 7801      | 7901     | f     | t
            5 | CB_Story_Hephaestus                |   0 | Hephaestus                     |                        |           |          | f     | f
(3 rows)`;

const autoscalerOutput = `=== Autoscaler status ===
State: running
Container: dune-autoscaler
Status: Up 56 minutes
Logs: dune autoscaler logs`;

test("healthy home status does not create false warnings", () => {
  const summary = parseHomeStatus(healthyStatus);
  assert.equal(summary.population, "0/60");
  assert.equal(summary.database, "Ready");
  assert.equal(summary.rabbitmq, "Ready");
  assert.equal(summary.fls, "Ready");
});

test("RabbitMQ status delegated to readiness does not create a false warning", () => {
  const summary = parseHomeStatus(`=== RabbitMQ game connections ===
RabbitMQ connection details: Checked by readiness`);
  assert.equal(summary.rabbitmq, "Ready");
});

test("home population parser normalizes unknown current population", () => {
  assert.equal(parseHomeStatus("Population: unknown/60").population, "?/60");
  assert.equal(parseHomeStatus("Population: unknown/unknown").population, "");
});

test("ready parser ignores section headings and keeps only check rows", () => {
  const rows = parseReadyRows(`=== Container checks ===
OK   container dune-postgres
OK   container dune-rmq-game

=== Listener checks ===
OK   TCP 15432 Postgres localhost
OK   world_partition rows: 30
READY: Dune Awakening Self-Host Docker stack looks healthy.`);
  assert.deepEqual(rows.map((row) => row.label), [
    "container dune-postgres",
    "container dune-rmq-game",
    "TCP 15432 Postgres localhost"
  ]);
});

test("port parser ignores diagnostics and deduplicates logical listeners", () => {
  const rows = parsePortRows(`=== Expected endpoints ===
Overmap game          7777/udp       advertised as 37.76.210.36:7777
WARN Public mode advertises 37.76.210.36 while game UDP is bound on private host IP 10.0.0.5.
OK   Overmap game listening on UDP 7777
OK   Survival_1 game listening on UDP 7778
OK   Survival_1 IGW listening on UDP 7888
OK   Overmap IGW listening on UDP 7889
OK   RabbitMQ game listening on TCP 31982
OK   RabbitMQ game listening on TCP 31982`);
  assert.deepEqual(rows.map((row) => `${row.name}:${row.port}/${row.protocol}`), [
    "Overmap game:7777/UDP",
    "Survival_1 game:7778/UDP",
    "Survival_1 IGW:7888/UDP",
    "Overmap IGW:7889/UDP",
    "RabbitMQ game:31982/TCP"
  ]);
});

test("healthy ready fixture keeps expected checks and omits database partition row", () => {
  const rows = parseReadyRows(healthyReady);
  assert(rows.some((row) => row.label === "container dune-postgres"));
  assert(rows.some((row) => row.label === "Survival_1 ready"));
  assert(rows.some((row) => row.label === "Overmap ready"));
  assert(rows.some((row) => row.label === "game server sg.* RMQ connections"));
  assert(!rows.some((row) => /world_partition/.test(row.label)));
  assert(!rows.some((row) => /^===/.test(row.label)));
});

test("status fixture exposes exact logical listeners and game servers", () => {
  const listeners = parseStatusListenerRows(healthyStatusWithSections);
  assert.deepEqual(listeners.map((row) => `${row.name}:${row.port}/${row.protocol}`), [
    "Postgres localhost:15432/TCP",
    "RabbitMQ admin:32573/TCP",
    "RabbitMQ game:31982/TCP",
    "RabbitMQ game HTTP:31983/TCP",
    "TextRouter:5059/TCP",
    "Director:11717/TCP",
    "Overmap clients:7777/UDP",
    "Survival_1 clients:7778/UDP",
    "Survival_1 S2S:7888/UDP",
    "Overmap S2S:7889/UDP",
    "DeepDesert_1 clients:7786/UDP",
    "DeepDesert_1 S2S:7897/UDP"
  ]);
  assert.deepEqual(parseStatusGameServers(healthyStatusWithSections).map((row) => row.map), ["Survival_1", "Overmap"]);
});

// status.sh reports one row per expected always-on map server, not the two it
// used to hardcode. The fixture above stays as the fresh-install shape; this is
// the real dune2 roster, where two maps have a second partition and therefore a
// "#<partition>" label.
test("status game server parser reads a full always-on roster", () => {
  const roster = `=== Game servers ===
MAP                      STATE         UPTIME
Survival_1               READY         Up 4 hours
Survival_1#60            READY         Up 4 hours
Overmap                  READY         Up 4 hours
SH_Arrakeen              WARMING       Up 12 seconds
DeepDesert_1             NOT RUNNING   missing
DeepDesert_1#59          WAIT          pending

Note: 6 always-on map servers expected, starting 2 at a time.`;

  const rows = parseStatusGameServers(roster);

  assert.deepEqual(rows.map((row) => row.map), [
    "Survival_1",
    "Survival_1#60",
    "Overmap",
    "SH_Arrakeen",
    "DeepDesert_1",
    "DeepDesert_1#59"
  ]);
  // "NOT RUNNING" contains a space, so it exercises the lazy group in the row
  // regex rather than just the single-token states.
  assert.deepEqual(rows.map((row) => row.state), [
    "READY",
    "READY",
    "READY",
    "WARMING",
    "NOT RUNNING",
    "WAIT"
  ]);
  assert.deepEqual(rows.map((row) => row.uptime), [
    "Up 4 hours",
    "Up 4 hours",
    "Up 4 hours",
    "Up 12 seconds",
    "missing",
    "pending"
  ]);
  // The concurrency note must not be mistaken for a map.
  assert.equal(rows.length, 6);
});

test("server status response provides a typed contract and preserves command diagnostics", () => {
  const response = buildServerStatusResponse({ operation: "status", stdout: healthyStatusWithSections, stderr: "", exitCode: 0 });
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.ok, true);
  assert.equal(response.stdout, healthyStatusWithSections);
  assert.deepEqual(response.data.summary.population, { current: 0, capacity: 60 });
  assert.equal(response.data.summary.serverIp, "37.76.210.36");
  assert.deepEqual(response.data.containers[0], { name: "dune-postgres", status: "Up 29 minutes" });
  assert.deepEqual(response.data.listeners[0], { name: "Postgres localhost", port: 15432, protocol: "TCP", status: "OK" });
  assert.deepEqual(response.data.database, { worldPartitions: 30 });
  assert.deepEqual(response.data.gameServers[0], { map: "Survival_1", status: "READY", uptime: "Up 29 minutes" });
  assert.equal(response.data.rabbitmq.directorConnections, 1);
  assert.equal(response.data.fls.gatewayDbMonitoring, "OK");
});

test("map status response provides typed arrays without removing legacy command results", () => {
  const response = buildMapStatusResponse({
    maps: { operation: "mapsList", stdout: mapsListOutput, stderr: "", exitCode: 0 },
    services: { operation: "servers", stdout: postgresBooleanServersOutput, stderr: "", exitCode: 0 },
    readiness: { operation: "readiness", stdout: healthyReady, stderr: "", exitCode: 0 },
    autoscaler: { operation: "autoscalerStatus", stdout: autoscalerOutput, stderr: "", exitCode: 0 }
  });
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.ok, true);
  assert.equal(response.maps.stdout, mapsListOutput);
  assert.deepEqual(response.data.maps[0], { map: "SH_Arrakeen", mode: "dynamic", partitions: 1, assigned: 0 });
  assert.deepEqual(response.data.partitions[0], {
    partitionId: 3,
    map: "SH_Arrakeen",
    dimension: 0,
    label: "Arrakeen",
    serverId: "Wt8UaAi5QrumxjclQehfpQ",
    gamePort: 7800,
    igwPort: 7900,
    ready: true,
    alive: true,
    status: "Ready"
  });
  assert.equal(response.data.readiness.status, "ready");
  assert(response.data.readiness.checks.some((row) => row.section === "Database world partition checks" && row.label === "world_partition rows: 30"));
  assert.deepEqual(response.data.autoscaler, { state: "running", container: "dune-autoscaler", status: "Up 56 minutes" });
});

test("status responses can omit raw command diagnostics", () => {
  const server = buildServerStatusResponse(
    { operation: "status", stdout: healthyStatusWithSections, stderr: "", exitCode: 0 },
    { includeRaw: false }
  );
  assert.equal(server.ok, true);
  assert.equal(server.data.summary.overall, "READY");
  assert.equal("stdout" in server, false);
  assert.equal("operation" in server, false);

  const maps = buildMapStatusResponse({
    maps: { stdout: mapsListOutput, exitCode: 0 },
    services: { stdout: postgresBooleanServersOutput, exitCode: 0 },
    readiness: { stdout: healthyReady, exitCode: 0 },
    autoscaler: { stdout: autoscalerOutput, exitCode: 0 }
  }, { includeRaw: false });
  assert.equal(maps.ok, true);
  assert.equal(maps.data.maps[0].map, "SH_Arrakeen");
  assert.equal("maps" in maps, false);
});

test("maps list response adds typed rows and can omit legacy stdout", () => {
  const raw = { operation: "mapsList", stdout: mapsListOutput, stderr: "", exitCode: 0 };
  const compatible = buildMapsListResponse(raw);
  assert.equal(compatible.stdout, mapsListOutput);
  assert.deepEqual(compatible.data.maps[0], { map: "SH_Arrakeen", mode: "dynamic", partitions: 1, assigned: 0 });

  const compact = buildMapsListResponse(raw, { includeRaw: false });
  assert.equal(compact.ok, true);
  assert.equal("stdout" in compact, false);
  assert.equal(compact.data.maps.length > 0, true);
});

test("structured status responses remain valid when a command fails or output is empty", () => {
  const server = buildServerStatusResponse({ operation: "status", stdout: "", stderr: "failed", exitCode: 2 });
  assert.equal(server.ok, false);
  assert.deepEqual(server.data.summary.population, { current: null, capacity: null });
  assert.deepEqual(server.data.containers, []);

  const maps = buildMapStatusResponse({
    maps: { stdout: "", exitCode: 0 },
    services: { stdout: "", exitCode: 0 },
    readiness: { stdout: "", exitCode: 2 },
    autoscaler: { stdout: "", exitCode: 0 }
  });
  assert.equal(maps.ok, false);
  assert.deepEqual(maps.data.maps, []);
  assert.deepEqual(maps.data.partitions, []);
  assert.deepEqual(maps.data.readiness, { status: "unknown", message: null, checks: [] });
});

test("status listener parser keeps separate map rows even when ports match", () => {
  const listeners = parseStatusListenerRows(`=== Listeners ===
CHECK                    PORT     STATUS
Survival_1 S2S           7888/udp OK
SH_HarkoVillage S2S      7888/udp OK`);
  assert.deepEqual(listeners.map((row) => row.name), ["Survival_1 S2S", "SH_HarkoVillage S2S"]);
});

test("RabbitMQ TextRouter zero and FLS OK values are not failures", () => {
  const rabbit = parseRabbitConnections(healthyStatus);
  const fls = parseFlsSummary(healthyStatus);
  assert.equal(rabbit["TextRouter connections"], "0");
  assert.equal(rabbit["Director connections"], "1");
  assert.equal(fls["Director heartbeat"], "OK");
  assert.equal(fls["Gateway DB monitoring"], "OK");
});

test("FLS summary parser ignores status tips", () => {
  const summary = parseFlsSummary(`${healthyStatus}

Tip: use 'dune ready' for pass/wait/fail readiness checks.
Tip: use 'dune doctor' for troubleshooting suggestions.`);
  assert.deepEqual(Object.keys(summary), [
    "Director heartbeat",
    "Population declaration",
    "Max capacity declaration",
    "Gateway DB monitoring"
  ]);
});

test("doctor parser suppresses stale log-window warnings when readiness is healthy", () => {
  const doctor = `=== RabbitMQ and service signals ===
OK   RabbitMQ game reachable
WARN Director heartbeat not seen in recent logs
     If the stack just started, wait a few minutes and run: dune ready
WARN Gateway DB monitoring not seen in recent logs`;
  assert.deepEqual(parseDoctorWarnings(doctor, healthyReady), []);
  assert.equal(parseDoctorWarnings(doctor, "NOT READY: one or more required checks failed.").length, 2);
});

test("doctor parser treats DeepDesert always-on as informational", () => {
  const doctor = `=== Host latency and vehicle timing ===
WARN DeepDesert_1 is always-on; this can worsen vehicle timing on WSL2/dense bases`;
  assert.deepEqual(parseDoctorWarnings(doctor, healthyReady), []);
});

test("skill module parser attaches id and max level metadata to module rows", () => {
  const rows = parseSkillModules(`Bindu Dodge [BeneGesserit]
  id: Skills.Spice.BinduDodge
  max level: 1
Bindu Sprint [BeneGesserit]
  id: Skills.Ability.Hypersprint
  max level: 3`);
  assert.deepEqual(rows, [
    { skillModule: "Bindu Dodge", category: "BeneGesserit", id: "Skills.Spice.BinduDodge", maxLevel: "1" },
    { skillModule: "Bindu Sprint", category: "BeneGesserit", id: "Skills.Ability.Hypersprint", maxLevel: "3" }
  ]);
  assert(!rows.some((row) => row.skillModule === "max level: 1"));
});

test("map list parser keeps every dynamic map row and formats mode", () => {
  const rows = parseMapListRows(mapsListOutput);
  assert.deepEqual(rows.map((row) => row.map), ["SH_Arrakeen", "DeepDesert_1", "CB_Dungeon_ThePit", "SH_HarkoVillage", "Story_ProcesVerbal"]);
  assert.deepEqual(rows.map((row) => row.mode), ["Dynamic", "Dynamic", "Always On", "Overmap Active", "Disabled"]);
  assert.equal(rows[0].assigned, "0");
});

test("memory status parser formats Gi defaults as friendly GB labels", () => {
  const rows = parseMemoryStatusRows(memoryStatusOutput);
  assert.deepEqual(rows.find((row) => row.map === "Survival_1"), { map: "Survival_1", memory: "16.00 GB (Default)" });
  assert.deepEqual(rows.find((row) => row.map === "Survival_1:1"), { map: "Survival_1:1", memory: "16.00 GB (Default)" });
  assert.deepEqual(rows.find((row) => row.map === "Survival_1:31"), { map: "Survival_1:31", memory: "16.00 GB (Default)" });
  assert.deepEqual(rows.find((row) => row.map === "CB_Dungeon_ThePit"), { map: "CB_Dungeon_ThePit", memory: "13.00 GB" });
});

test("memory status parser accepts long map names without fixed-width spacing", () => {
  const rows = parseMemoryStatusRows(`=== Memory configuration ===
Default memory: built-in per-map defaults, or server catalog for other dynamic maps

MAP                          MEMORY
DLC_Story_LostHarvest_EcolabA 6g
DLC_Story_LostHarvest_EcolabB 2Gi default
DLC_Story_LostHarvest_ForgottenLab 10g`);
  assert.deepEqual(rows.find((row) => row.map === "DLC_Story_LostHarvest_EcolabA"), { map: "DLC_Story_LostHarvest_EcolabA", memory: "6.00 GB" });
  assert.deepEqual(rows.find((row) => row.map === "DLC_Story_LostHarvest_EcolabB"), { map: "DLC_Story_LostHarvest_EcolabB", memory: "2.00 GB (Default)" });
  assert.deepEqual(rows.find((row) => row.map === "DLC_Story_LostHarvest_ForgottenLab"), { map: "DLC_Story_LostHarvest_ForgottenLab", memory: "10.00 GB" });
});

test("server partition parser derives status from real ready/alive fields", () => {
  const rows = parseServerPartitionRows(serversOutput);
  assert.equal(rows.find((row) => row.map === "Survival_1").status, "Starting");
  assert.equal(rows.find((row) => row.map === "Overmap").status, "Ready");
  assert.equal(rows.find((row) => row.map === "DeepDesert_1").status, "Not Running");
});

test("server partition parser accepts Postgres t/f boolean output", () => {
  const rows = parseServerPartitionRows(postgresBooleanServersOutput);
  assert.equal(rows.find((row) => row.map === "SH_Arrakeen").status, "Ready");
  assert.equal(rows.find((row) => row.map === "SH_HarkoVillage").status, "Loading");
  assert.equal(rows.find((row) => row.map === "CB_Story_Hephaestus").status, "Not Running");
});

test("backup list parser sorts newest first and formats filename timestamps", () => {
  const rows = parseBackupListRows(`dune-db-overmap_and_survival_1-20260603-115203.backup
dune-db-overmap_and_survival_1-20260603-115318.backup
dune-db-pre-update-20260603-115400.backup
dune-db-imported-20260531-010203.backup`);
  assert.deepEqual(rows.map((row) => row.backupName), [
    "dune-db-pre-update-20260603-115400.backup",
    "dune-db-overmap_and_survival_1-20260603-115318.backup",
    "dune-db-overmap_and_survival_1-20260603-115203.backup",
    "dune-db-imported-20260531-010203.backup"
  ]);
  assert.equal(rows[0].created, "2026-06-03 11:54:00");
  assert.equal(rows[0].type, "Pre-update Backup");
  assert.equal(rows[1].type, "Manual Backup");
  assert.equal(rows[3].type, "Imported Backup");
  assert.equal(rows[3].source, "External");
});

test("backup list parser labels market-bot backups by their origin-carrying filename", () => {
  const rows = parseBackupListRows(`dune-db-market-bot-buyback-hagga_basin-20260819-020000.backup
dune-db-market-bot-seed-hagga_basin-20260819-010000.backup
dune-db-market-bot-unseed-hagga_basin-20260819-000000.backup
dune-db-hagga_basin-20260818-000000.backup`);
  assert.equal(rows[0].type, "Market Bot Backup");
  assert.equal(rows[1].type, "Market Bot Backup");
  assert.equal(rows[2].type, "Market Bot Backup");
  assert.equal(rows[3].type, "Manual Backup");
});

test("backup list parser prefers server-local file timestamps", () => {
  const rows = parseBackupListRows(`2026-06-06 18:06:33  runtime/backups/db/dune-db-overmap_and_survival_1-20260606-150633.backup`);
  assert.equal(rows[0].created, "2026-06-06 18:06:33");
});

test("auto backup status parser handles retention, timer, and permission failures", () => {
  const status = parseBackupAutoStatus({
    exitCode: 0,
    stdout: `=== Automatic database backups ===
Enabled:          true
Backup time:      05:30
Interval hours:   12
Retention:        3 days
Backup directory: runtime/backups/db

Systemd timer:   enabled`
  });
  assert.equal(status.enabled, true);
  assert.equal(status.backupTime, "05:30");
  assert.equal(status.intervalHours, "12");
  assert.equal(status.retentionDays, "3");
  assert.equal(status.retentionLabel, "3 Days");
  assert.equal(status.timer, "enabled");

  const failed = parseBackupAutoStatus({ exitCode: 1, stderr: "runtime/scripts/db.sh: line 966: runtime/generated/db-backup.env: Permission denied" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "Backup scheduler status file is not readable by the web admin user.");
});
