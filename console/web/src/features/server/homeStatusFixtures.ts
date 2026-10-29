// Shared generator for status.sh-shaped text, used by the Home summariser
// tests. Shaped after real dune2 output captured 2026-08-31.
//
// It lives in its own module rather than being duplicated per test file: the
// property test and the example tests have to agree on what a realistic status
// looks like, and two copies drift invisibly -- the property test would keep
// passing against a shape the app no longer produces.

export const BATTLEGROUP_CONTAINER_NAMES = [
  "dune-postgres",
  "dune-rmq-admin",
  "dune-rmq-game",
  "dune-text-router",
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
];

// The real dune2 roster: seven map servers, two of them second partitions.
export const MAPS: Array<[string, string]> = [
  ["Survival_1", "READY"],
  ["Survival_1#60", "READY"],
  ["Overmap", "READY"],
  ["SH_Arrakeen", "READY"],
  ["SH_HarkoVillage", "READY"],
  ["DeepDesert_1", "READY"],
  ["DeepDesert_1#59", "READY"]
];

export type StatusTextOptions = {
  downContainers?: number;
  maps?: Array<[string, string]>;
  badListeners?: number;
  flsWait?: number;
  /** The `Overall:` line. `null` omits it entirely. */
  overall?: string | null;
  /** Drop the Database section, so the Database row reads Unknown. */
  omitDatabase?: boolean;
};

export function statusText(options: StatusTextOptions = {}) {
  const down = options.downContainers ?? 0;
  const maps = options.maps ?? MAPS;
  const badListeners = options.badListeners ?? 0;
  const flsWait = options.flsWait ?? 0;
  const overall = options.overall === undefined ? "READY" : options.overall;
  const listeners = [
    "Postgres localhost       15432/tcp",
    "Director                 11717/tcp",
    "TextRouter               5059/tcp",
    "RabbitMQ game            31982/tcp"
  ];
  const fls = ["Director heartbeat:      ", "Population declaration:  ", "Max capacity declaration:", "Gateway DB monitoring:   "];
  return [
    "=== Dune status ===",
    ...(overall === null ? [] : [`Overall:     ${overall}`]),
    "Title:       Example Sietch",
    "Population:  0/120",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...BATTLEGROUP_CONTAINER_NAMES.map((name, i) => `${name.padEnd(26)} ${i < down ? "missing" : "Up 15 hours"}`),
    `${"dune-coriolis-coordinator".padEnd(26)} Up 15 hours`,
    `${"dune-orchestrator".padEnd(26)} Up 15 hours`,
    "",
    "=== Listeners ===",
    "CHECK                    PORT     STATUS",
    ...listeners.map((line, i) => `${line} ${i < badListeners ? "MISSING" : "OK"}`),
    "",
    ...(options.omitDatabase ? [] : ["=== Database ===", "World partitions: 32", ""]),
    "=== Game servers ===",
    "MAP                      STATE         UPTIME",
    ...maps.map(([label, state]) => `${label.padEnd(24)} ${state.padEnd(13)} ${state === "READY" ? "Up 5 hours" : "Up 9 seconds"}`),
    `Note: ${maps.length} always-on map servers expected, starting 2 at a time.`,
    "",
    "=== RabbitMQ game connections ===",
    "RabbitMQ connection details: Checked by readiness",
    "",
    "=== Funcom/FLS summary ===",
    ...fls.map((line, i) => `${line} ${i < flsWait ? "WAIT" : "OK"}`),
    ""
  ].join("\n");
}

export const READY_READINESS = [
  "OK container dune-postgres",
  "OK container dune-rmq-admin",
  "OK container dune-rmq-game",
  "OK container dune-text-router",
  "OK container dune-director",
  "OK container dune-server-gateway",
  "OK container dune-server-survival-1",
  "OK container dune-server-overmap",
  "OK world_partition rows: 32",
  "OK game server sg.* RMQ connections",
  "READY: all checks passed"
].join("\n");

// isHomeReadinessOperational requires every one of its signals, so failing one
// line is enough to make readiness non-operational.
export const FAILING_READINESS = READY_READINESS
  .replace("OK container dune-director", "FAIL container dune-director")
  .replace("READY: all checks passed", "NOT READY: one or more checks failed");
