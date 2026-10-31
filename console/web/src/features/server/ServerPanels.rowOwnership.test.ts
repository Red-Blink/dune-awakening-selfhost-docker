import { describe, expect, it } from "vitest";
import { summarizeHomeStatus } from "./ServerPanels";
import { getServerPorts } from "../../api/serverPorts";

// The property this row set exists for: every battlegroup container has exactly
// one home, so nothing is reported twice.
//
// Before the regrouping, taking any one of the eight down lit up two or three
// rows -- Containers said the process was gone, Listeners said its port was
// shut, and whichever functional row covered it said so a third time.

const P = getServerPorts();

const BATTLEGROUP = [
  "dune-postgres",
  "dune-rmq-admin",
  "dune-rmq-game",
  "dune-text-router",
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
];

const MAPS = ["Survival_1", "Survival_1#60", "Overmap", "SH_Arrakeen", "SH_HarkoVillage", "DeepDesert_1", "DeepDesert_1#59"];

function healthyStatus() {
  return [
    "=== Dune status ===",
    "Overall:     READY",
    "Title:       Example Sietch",
    "",
    "=== Containers ===",
    "SERVICE                    STATUS",
    ...BATTLEGROUP.map((name) => `${name.padEnd(26)} Up 15 hours`),
    `${"dune-coriolis-coordinator".padEnd(26)} Up 15 hours`,
    `${"dune-orchestrator".padEnd(26)} Up 15 hours`,
    "",
    "=== Listeners ===",
    "CHECK                    PORT     STATUS",
    `${"Postgres localhost".padEnd(24)} ${`${P.postgres}/tcp`.padEnd(8)} OK`,
    `${"RabbitMQ admin".padEnd(24)} ${`${P.rmqAdmin}/tcp`.padEnd(8)} OK`,
    `${"RabbitMQ game".padEnd(24)} ${`${P.rmqGame}/tcp`.padEnd(8)} OK`,
    `${"RabbitMQ game HTTP".padEnd(24)} ${`${P.rmqGameHttp}/tcp`.padEnd(8)} OK`,
    `${"TextRouter".padEnd(24)} ${`${P.textRouter}/tcp`.padEnd(8)} OK`,
    `${"Director".padEnd(24)} ${`${P.director}/tcp`.padEnd(8)} OK`,
    `${"Overmap clients".padEnd(24)} ${`${P.clientBase}/udp`.padEnd(8)} OK`,
    `${"Survival_1 clients".padEnd(24)} ${`${P.clientBaseSecondary}/udp`.padEnd(8)} OK`,
    `${"Survival_1 S2S".padEnd(24)} ${`${P.igwBase}/udp`.padEnd(8)} OK`,
    `${"Overmap S2S".padEnd(24)} ${`${P.igwBaseSecondary}/udp`.padEnd(8)} OK`,
    "",
    "=== Database ===",
    "World partitions: 32",
    "",
    "=== Game servers ===",
    "MAP                      STATE         UPTIME",
    ...MAPS.map((m) => `${m.padEnd(24)} ${"READY".padEnd(13)} Up 5 hours`),
    "",
    "=== RabbitMQ game connections ===",
    "RabbitMQ connection details: Checked by readiness",
    "",
    "=== Funcom/FLS summary ===",
    "Director heartbeat:       OK",
    "Population declaration:   OK",
    "Max capacity declaration: OK",
    "Gateway DB monitoring:    OK",
    ""
  ].join("\n");
}

// Take a container down the way it really goes down: its row goes missing AND
// everything downstream of it fails too. Mutating only the container row would
// prove nothing, because in reality the listener stops answering at the same
// moment.
const OUTAGES: Record<string, (t: string) => string> = {
  "dune-postgres": (t) =>
    t.replace(new RegExp(`(Postgres localhost\\s+${P.postgres}/tcp)\\s+OK`), "$1 MISSING").replace(/^World partitions: \d+$/m, "World partitions: 0"),
  "dune-rmq-admin": (t) => t.replace(new RegExp(`(RabbitMQ admin\\s+${P.rmqAdmin}/tcp)\\s+OK`), "$1 MISSING"),
  "dune-rmq-game": (t) =>
    t
      .replace(new RegExp(`(RabbitMQ game\\s+${P.rmqGame}/tcp)\\s+OK`), "$1 MISSING")
      .replace(new RegExp(`(RabbitMQ game HTTP\\s+${P.rmqGameHttp}/tcp)\\s+OK`), "$1 MISSING")
      .replace(/^RabbitMQ connection details: .*$/m, "RabbitMQ game is not running"),
  "dune-text-router": (t) => t.replace(new RegExp(`(TextRouter\\s+${P.textRouter}/tcp)\\s+OK`), "$1 MISSING"),
  "dune-director": (t) =>
    t.replace(new RegExp(`(Director\\s+${P.director}/tcp)\\s+OK`), "$1 MISSING").replace(/^Director heartbeat:(\s+)OK$/m, "Director heartbeat:$1WAIT"),
  // The gateway has no listener anywhere in status.sh; its only signal is the
  // FLS row, which gates on is_running dune-server-gateway (status.sh:661).
  "dune-server-gateway": (t) => t.replace(/^Gateway DB monitoring:(\s+)OK$/m, "Gateway DB monitoring:$1WAIT"),
  "dune-server-survival-1": (t) =>
    t
      .replace(new RegExp(`(Survival_1 clients\\s+${P.clientBaseSecondary}/udp)\\s+OK`), "$1 MISSING")
      .replace(new RegExp(`(Survival_1 S2S\\s+${P.igwBase}/udp)\\s+OK`), "$1 MISSING")
      .replace(/^(Survival_1\s+)READY(\s+)Up .*$/m, "$1NOT RUNNING$2missing"),
  "dune-server-overmap": (t) =>
    t
      .replace(new RegExp(`(Overmap clients\\s+${P.clientBase}/udp)\\s+OK`), "$1 MISSING")
      .replace(new RegExp(`(Overmap S2S\\s+${P.igwBaseSecondary}/udp)\\s+OK`), "$1 MISSING")
      .replace(/^(Overmap\s+)READY(\s+)Up .*$/m, "$1NOT RUNNING$2missing")
};

// The row that OWNS each container -- the one home it has.
const OWNER: Record<string, string> = {
  "dune-postgres": "Database",
  "dune-rmq-admin": "Messaging",
  "dune-rmq-game": "Messaging",
  "dune-text-router": "Messaging",
  "dune-director": "Battlegroup services",
  "dune-server-gateway": "Battlegroup services",
  "dune-server-survival-1": "Game servers",
  "dune-server-overmap": "Game servers"
};

// Rows that legitimately also react, for a DIFFERENT reason. This is cascade,
// not duplication: the director and gateway are the services that register the
// battlegroup with Funcom, so losing either genuinely lapses registration.
// Funcom/FLS is saying "we are no longer advertised", not "the container is
// gone" -- a distinct fact an operator needs.
const CASCADE: Record<string, string[]> = {
  "dune-director": ["Funcom/FLS"],
  "dune-server-gateway": ["Funcom/FLS"]
};

function flagged(status: string) {
  // Readiness is empty on purpose: a "READY:" reading triggers readyOverride,
  // which rewrites every row to OK and would make this test vacuous.
  return summarizeHomeStatus(status, "", "", false)
    .health.filter((row) => !/^OK$/i.test(String(row.value)))
    .map((row) => row.label);
}

function withoutContainer(text: string, name: string) {
  const dropped = text.replace(new RegExp(`^${name}\\s+Up .*$`, "m"), name.padEnd(26) + " missing");
  if (dropped === text) throw new Error(`container row not replaced: ${name}`);
  return dropped;
}

describe("every battlegroup container has exactly one home", () => {
  it("is healthy to begin with", () => {
    expect(flagged(healthyStatus())).toEqual([]);
  });

  for (const name of BATTLEGROUP) {
    it(`${name} is reported by ${OWNER[name]}${CASCADE[name] ? ` (and ${CASCADE[name].join(", ")})` : ""} and nothing else`, () => {
      const status = OUTAGES[name](withoutContainer(healthyStatus(), name));
      const rows = flagged(status);
      expect(rows).toContain(OWNER[name]);
      expect([...rows].sort()).toEqual([OWNER[name], ...(CASCADE[name] || [])].sort());
    });
  }

  // Stated as its own assertion so the ownership table cannot quietly grow a
  // second owner for a container.
  it("names one owner per container", () => {
    expect(Object.keys(OWNER).sort()).toEqual([...BATTLEGROUP].sort());
    for (const owner of Object.values(OWNER)) expect(typeof owner).toBe("string");
  });
});

// Two checks that only matter when nothing else is broken, so the outage cases
// above cannot reach them: in those, the map is already NOT RUNNING and the
// partitions already read 0, which trips the row for a coarser reason.
describe("rows own their ports and containers even when the obvious signal is fine", () => {
  // Once the flat Listeners row went away, every map client and S2S port would
  // have been unowned unless Game servers took them. A map can be READY while
  // its port stopped answering.
  it("Game servers owns a map port that stops answering", () => {
    const status = healthyStatus().replace(
      new RegExp(`(Overmap clients\\s+${P.clientBase}/udp)\\s+OK`),
      "$1 MISSING"
    );
    expect(status).toMatch(/Overmap clients\s+\S+\s+MISSING/);
    expect(flagged(status)).toEqual(["Game servers"]);
  });

  // Database owns dune-postgres outright, so a stale partition count must not
  // cover for the container being gone.
  it("Database owns its container even when the partition count still reads", () => {
    const status = withoutContainer(healthyStatus(), "dune-postgres");
    expect(status).toMatch(/World partitions: 32/);
    expect(flagged(status)).toEqual(["Database"]);
  });

  // The same, one layer out: the port shut but the container still listed.
  it("Database owns its port", () => {
    const status = healthyStatus().replace(
      new RegExp(`(Postgres localhost\\s+${P.postgres}/tcp)\\s+OK`),
      "$1 MISSING"
    );
    expect(flagged(status)).toEqual(["Database"]);
  });
});
