// Real HTTP integration coverage for the 5 base-container mutation routes
// added alongside the raw-resource catalog work (issue #347): give-item,
// give-items, fill-item, bulk-delete-items, delete-all-items.
//
// Resolves issue #353 (found during PR #349's own Layer 3 audit, QA hat,
// HIGH severity per the original finding): baseContainerMutationRoutes.test.js
// is entirely "structural" -- it reads server.js as source text and asserts
// regex patterns exist in each route handler's function body, but never
// actually invokes any of the 5 handlers with a real request/response. That
// test file's own header comment explains why (server.js is an entrypoint --
// importing it starts a listener), following operationsPermissionMatrix.
// test.js's precedent. This file takes the OTHER precedent already
// established in this repo instead -- bridgeActionDispatch.test.js's
// approach of spawning the real src/server.js as a child process and hitting
// it over real HTTP -- because that is the only way to prove the actual
// dispatch -> route handler -> duneDb wiring for these 5 endpoints, not just
// that certain string tokens exist somewhere in each function body.
//
// Real PostgreSQL (via withIsolatedDatabase, same as baseContainerItemDelete.
// integration.test.js) rather than a mock: the guarantees that matter here --
// that the HTTP layer's own guards (phrase confirmation, map-safety,
// pending-delete/backed-up checks, batch-size validation) actually run in
// the real dispatch chain, in the real order, before ever reaching duneDb --
// are exactly the kind a string-matched structural test cannot prove, and a
// unit test of duneDb.js's functions directly (db.test.js) never exercises
// the HTTP/route layer at all.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pgConnectionConfig, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";
import { getFreePort } from "../test-support/consoleHarness.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(API_ROOT, "../..");
let PORT;
let BASE;

const CLAIM_ACTOR = 40001;
const BUILDING_ACTOR = 40002;
const ENTITY_ID = 40003;
const CHEST = 40004; // storagecontainer_placeable, on the allowlist
const REFINERY = 40005; // smallorerefinery_placeable, "refining" group -- read-only

const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.world_partition (partition_id bigint primary key, map text, dimension_index integer default 0, server_id text);
  create table dune.buildings (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.building_instances (
    building_id bigint not null references dune.actors(id) on delete cascade,
    instance_id integer not null,
    owner_entity_id bigint
  );
  create table dune.actor_fgl_entities (
    entity_id bigint,
    actor_id bigint references dune.actors(id) on delete cascade,
    slot_name text not null default '',
    constraint actor_fgl_entities_entity_id_key unique (entity_id),
    constraint actor_fgl_no_slot_duplication unique (actor_id, slot_name)
  );
  create table dune.placeables (
    id bigint primary key references dune.actors(id) on delete cascade,
    owner_entity_id bigint,
    building_type text,
    is_hologram boolean not null default false
  );
  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint references dune.actors(id) on delete cascade,
    max_item_count integer,
    max_item_volume real
  );
  create sequence dune.items_id_seq;
  create table dune.items (
    id bigint primary key default nextval('dune.items_id_seq'),
    inventory_id bigint references dune.inventories(id) on delete cascade,
    stack_size bigint not null,
    position_index bigint not null,
    template_id text not null,
    stats jsonb not null default '{}'::jsonb,
    quality_level bigint not null default 0,
    volume_override real,
    constraint items_position_index_check check (position_index >= 0),
    constraint items_stack_size_check check (stack_size > 0)
  );

  create function dune._add_item_delete_log(in_item_id bigint, in_inventory_id bigint, in_template_id text)
  returns void language plpgsql as $$ begin return; end $$;

  create function dune.delete_item(in_id bigint) returns void
  language sql as $$
    delete from dune.items i
    using dune.inventories inv
    where i.inventory_id = inv.id
      and i.id = in_id
    returning dune._add_item_delete_log(i.id, inv.id, i.template_id);
  $$;
`;

const SEED = `
  insert into dune.actors (id, map, partition_id) values (${CLAIM_ACTOR}, 'HaggaBasin', 3);
  insert into dune.actor_fgl_entities (entity_id, actor_id) values (${ENTITY_ID}, ${CLAIM_ACTOR});
  insert into dune.permission_actor (actor_id, actor_name) values (${CLAIM_ACTOR}, 'Test Base ${CLAIM_ACTOR}');

  insert into dune.actors (id, map, partition_id) values (${BUILDING_ACTOR}, 'HaggaBasin', 3);
  insert into dune.buildings (id) values (${BUILDING_ACTOR});
  insert into dune.building_instances (building_id, instance_id, owner_entity_id) values (${BUILDING_ACTOR}, 0, ${ENTITY_ID});

  insert into dune.actors (id, map, partition_id) values (${CHEST}, 'HaggaBasin', 3);
  insert into dune.placeables (id, owner_entity_id, building_type) values (${CHEST}, ${ENTITY_ID}, 'storagecontainer_placeable');
  insert into dune.inventories (id, actor_id, max_item_count, max_item_volume) values (${CHEST} * 10, ${CHEST}, 45, 500);
  insert into dune.items (inventory_id, template_id, stack_size, position_index) values
    (${CHEST} * 10, 'ScrapMetal', 500, 0),
    (${CHEST} * 10, 'MagnetiteOre', 200, 1);

  insert into dune.actors (id, map, partition_id) values (${REFINERY}, 'HaggaBasin', 3);
  insert into dune.placeables (id, owner_entity_id, building_type) values (${REFINERY}, ${ENTITY_ID}, 'smallorerefinery_placeable');
  insert into dune.inventories (id, actor_id, max_item_count) values (${REFINERY} * 10, ${REFINERY}, 5);
  insert into dune.items (inventory_id, template_id, stack_size, position_index) values
    (${REFINERY} * 10, 'MagnetiteOre', 50, 0);

  -- server_id is left unassigned here; this no longer affects delete-route
  -- behavior at all (baseContainerDeleteSafety's map-liveness check was
  -- removed 2026-08-19 -- delete no longer requires a stopped map, see its
  -- own comment in server.js), but the row is still inserted for realism
  -- and in case a future test needs a real world_partition row present.
  insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null);
`;

// Sets up a throwaway repo root the spawned server can use for config/
// secrets, while symlinking the real runtime/data (admin-items.json) and
// VERSION from this actual checkout -- resolveCatalogItem/resolveItemVolume
// read runtime/data/admin-items.json directly by path, and copying/faking a
// ~2600-item catalog would risk drifting from the real one this route
// actually ships against.
function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-base-container-http-"));
  mkdirSync(join(repoRoot, "runtime"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  symlinkSync(resolve(REPO_ROOT, "runtime/data"), join(repoRoot, "runtime/data"));
  writeFileSync(join(repoRoot, "VERSION"), "test\n");
  return repoRoot;
}

function startServer(repoRoot, database) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist"),
      ...pgEnv(database)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`API did not start listening.\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolveReady();
        }
      } catch {
        // Not listening yet.
      }
    }, 150);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready, getOutput: () => output };
}

// pgConnectionConfig() already resolves ADMIN_DATABASE_URL / DUNE_DB_* /
// PG* env vars the same way db.js's discoverDbConfig() does -- reusing it
// here (rather than re-deriving connection env vars a second, possibly
// drifting way) is what guarantees the spawned server connects to the exact
// same isolated database withIsolatedDatabase() created, not the real
// shared "dune" database this repo's own scripts point at by default.
function pgEnv(database) {
  const cfg = pgConnectionConfig(database);
  if (cfg.connectionString) {
    const url = new URL(cfg.connectionString);
    url.pathname = `/${database}`;
    return { ADMIN_DATABASE_URL: url.toString() };
  }
  return {
    DUNE_DB_HOST: cfg.host,
    DUNE_DB_PORT: String(cfg.port),
    DUNE_DB_NAME: database,
    DUNE_DB_USER: cfg.user,
    DUNE_DB_PASSWORD: cfg.password
  };
}

async function withServer(t, fn) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_base_container_http",
    unavailableLabel: "the base container mutation routes HTTP integration test"
  }, async (pool, database) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);

    const repoRoot = makeRepoRoot();
    // A PID-derived port can collide with a parallel HTTP fixture or an
    // ephemeral PostgreSQL client connection. Allocate a real free port for
    // each server instead of failing every case on the same occupied port.
    PORT = await getFreePort();
    BASE = `http://127.0.0.1:${PORT}`;
    const { child, ready, getOutput } = startServer(repoRoot, database);
    try {
      await ready;
      await fn({ pool, getOutput });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        child.on("exit", resolveExit);
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit();
        }, 3000).unref?.();
      });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

async function itemsIn(pool, inventoryId) {
  const result = await pool.query(
    "select id, template_id, stack_size, position_index from dune.items where inventory_id = $1 order by position_index",
    [inventoryId]);
  return result.rows;
}

test("real HTTP: give-item inserts a real row through the full dispatch chain", async (t) => {
  await withServer(t, async ({ pool, getOutput }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-item`, {
      confirmation: "GIVE ITEM TO STORAGE",
      itemId: "AzuriteOre",
      quantity: 20
    });
    assert.equal(status, 200, `unexpected status ${status}. Server output:\n${getOutput()}`);
    assert.equal(body?.supported, true);
    assert.equal(body?.result?.ok, true);

    const rows = await itemsIn(pool, CHEST * 10);
    assert.ok(rows.some((row) => row.template_id === "AzuriteOre" && Number(row.stack_size) === 20),
      "the real row must exist in the real database, not just in the HTTP response");
  });
});

// Position-index collision mitigation (2026-08-19, see
// docs/incidents/INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION.md),
// proven against real Postgres, not a fake db: CHEST's real
// max_item_count is 45 (SEED above) with existing rows at position_index
// 0 and 1 -- a real nextHighPositionIndex call must land the new row at
// 44 (the highest unused slot below 45), not 2 (the old lowest-next-free
// behavior).
test("real HTTP: give-item lands the new row at the highest unused slot, not the lowest-next-free one", async (t) => {
  await withServer(t, async ({ pool, getOutput }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-item`, {
      confirmation: "GIVE ITEM TO STORAGE",
      itemId: "AzuriteOre",
      quantity: 5
    });
    assert.equal(status, 200, `unexpected status ${status}. Server output:\n${getOutput()}`);
    assert.equal(body?.result?.ok, true);

    const rows = await itemsIn(pool, CHEST * 10);
    const inserted = rows.find((row) => row.template_id === "AzuriteOre");
    assert.ok(inserted, "the real row must exist");
    assert.equal(Number(inserted.position_index), 44, "must land at the highest unused slot (max_item_count 45, slots 0/1 taken), not the lowest-next-free slot 2");
  });
});

// CORRECTED 2026-08-19 (issue #347 follow-up): give-item used to accept any
// catalog item at all -- a real catalog item, "Robe of the Sisterhood"
// (clothing, no group), showed up in the Give combobox despite this
// feature being intended for raw/refined resources and components only.
// give-item and give-items now resolve through resolveFillableCatalogItem(),
// the same function fill-item already used, and must reject a non-fillable
// item exactly the way fill-item's own rejection test below proves.
test("real HTTP: give-item rejects a non-fillable (clothing/weapon) item", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-item`, {
      confirmation: "GIVE ITEM TO STORAGE",
      itemId: "Combat_Light_Unique_BeneGeserit_Top",
      quantity: 1
    });
    assert.equal(status, 400);
    assert.match(body?.error || "", /not allowed for fill operation/);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 2, "nothing must be inserted for a rejected item");
  });
});

test("real HTTP: give-items rejects a batch containing a non-fillable item, inserting nothing", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-items`, {
      confirmation: "GIVE ITEMS TO STORAGE",
      items: [
        { itemId: "AzuriteOre", quantity: 10 },
        { itemId: "Combat_Light_Unique_BeneGeserit_Top", quantity: 1 }
      ]
    });
    assert.equal(status, 400);
    assert.match(body?.error || "", /not allowed for fill operation/);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 2,
      "the whole batch must insert nothing when any item in it is rejected -- items are resolved before any insert runs");
  });
});

test("real HTTP: give-item requires the exact confirmation phrase", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-item`, {
      confirmation: "wrong phrase",
      itemId: "AzuriteOre",
      quantity: 20
    });
    assert.equal(status, 400);
    assert.match(body?.error || "", /Confirmation phrase required/);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 2, "nothing must be inserted without the real phrase");
  });
});

test("real HTTP: give-item refuses to reach a refining-group container", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${REFINERY}/give-item`, {
      confirmation: "GIVE ITEM TO STORAGE",
      itemId: "AzuriteOre",
      quantity: 20
    });
    assert.equal(status, 400);
    // CORRECTED 2026-08-19 (code-review follow-up, issue #347): this group
    // check used to run in baseContainerOwnedStorageId (server.js), which
    // shared one generic "given or filled into" wording across Give and
    // Fill. It now runs inside resolveOwnedStorageContainer (duneDb.js),
    // shared with Delete too, so the wording is action-specific ("given
    // to" / "filled into" / "deleted from") via its actionLabel parameter.
    assert.match(body?.error || "", /can only be given to Storage containers/);
    assert.equal((await itemsIn(pool, REFINERY * 10)).length, 1, "the refinery's real inventory must be untouched");
  });
});

test("real HTTP: give-items batches several real inserts in one call", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-items`, {
      confirmation: "GIVE ITEMS TO STORAGE",
      items: [{ itemId: "AzuriteOre", quantity: 10 }, { itemId: "PlantFiber", quantity: 5 }]
    });
    assert.equal(status, 200);
    assert.equal(body?.result?.ok, true);

    const rows = await itemsIn(pool, CHEST * 10);
    assert.ok(rows.some((row) => row.template_id === "AzuriteOre" && Number(row.stack_size) === 10));
    assert.ok(rows.some((row) => row.template_id === "PlantFiber" && Number(row.stack_size) === 5));
  });
});

// DBA hat finding (Layer 2 audit, 2026-08-19): the round-trip fix in
// giveMultipleItemsToBaseContainer computes count/volume/position ONCE per
// batch and tracks them in memory afterward -- correct by inspection, but
// the give-items test above never proves it against a real Postgres
// instance because both its items fit easily inside CHEST's real
// max_item_volume (500) with no clamping at all. This test uses three
// distinct fillable items chosen for real-catalog per-unit volumes clean
// enough to keep the arithmetic exact (SteelBar 0.5, FremenComponent1 0.1,
// T6RefinedResourceA 1.0 -- externally re-verified 2026-08-20, issue #440;
// this test originally relied on all three being 1.0/unit, which the #440
// fix corrected SteelBar and FremenComponent1 away from -- quantities below
// were recomputed against the real values, not the old placeholder). The
// seeded 500 ScrapMetal and 200 MagnetiteOre are normal game-created rows
// with NULL overrides, so their catalog volumes now correctly consume 135
// of the chest's 500 capacity before this batch starts (500*0.15 +
// 200*0.3). The requested quantities below make the final clamp reachable
// ONLY if both that initial volume and the earlier batch items are
// genuinely carried forward in memory. Every requested quantity stays at or
// under each item's curated 500 stack size, so no row splits into multiple
// stacks here -- that behavior has its own dedicated coverage elsewhere.
test("real HTTP: give-items correctly clamps a later item based on earlier items' real, carried-forward volume consumption", async (t) => {
  await withServer(t, async ({ pool, getOutput }) => {
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-items`, {
      confirmation: "GIVE ITEMS TO STORAGE",
      items: [
        { itemId: "SteelBar", quantity: 100 },
        { itemId: "FremenComponent1", quantity: 300 },
        { itemId: "T6RefinedResourceA", quantity: 400 }
      ]
    });
    assert.equal(status, 200, `unexpected status ${status}. Server output:\n${getOutput()}`);
    assert.equal(body?.result?.ok, true);
    const results = body.result.results;
    // 500 remaining after the 135-volume seed; item 1 consumes 100*0.5=50.
    assert.equal(results[0].given, 100, "item 1 fits fully after the seeded stacks' real 135 volume");
    assert.equal(results[0].clamped, false);
    // 365-50=315 remaining; item 2 consumes 300*0.1=30, well inside it.
    assert.equal(results[1].given, 300, "item 2 sees item 1's just-inserted 50 volume and still fits fully");
    assert.equal(results[1].clamped, false);
    // 315-30=285 remaining; item 3 (1.0/unit) requests 400, clamps to 285.
    assert.equal(results[2].given, 285, "item 3 sees the seeded 135 plus items 1+2's 80 volume and clamps to the real remaining 285");
    assert.equal(results[2].clamped, true);
    assert.equal(results[2].clampReason, "volume");

    const rows = await itemsIn(pool, CHEST * 10);
    assert.ok(rows.some((row) => row.template_id === "SteelBar" && Number(row.stack_size) === 100));
    assert.ok(rows.some((row) => row.template_id === "FremenComponent1" && Number(row.stack_size) === 300));
    assert.ok(rows.some((row) => row.template_id === "T6RefinedResourceA" && Number(row.stack_size) === 285));
  });
});

// Issue #352's own fix (batch-size validation runs BEFORE any per-item
// catalog resolution) is asserted textually in baseContainerMutationRoutes.
// test.js already; this proves the OUTCOME through the real HTTP path --
// an oversized batch is rejected with the real 400, and genuinely inserts
// nothing, rather than the structural test's proof that a check merely
// exists somewhere in the function body.
test("real HTTP: give-items rejects a batch above the real 50-item cap without inserting anything", async (t) => {
  await withServer(t, async ({ pool }) => {
    const items = Array.from({ length: 51 }, () => ({ itemId: "AzuriteOre", quantity: 1 }));
    const { status, body } = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/give-items`, {
      confirmation: "GIVE ITEMS TO STORAGE",
      items
    });
    assert.equal(status, 400);
    assert.match(body?.error || "", /1-50 items/);
    assert.equal((await itemsIn(pool, CHEST * 10)).length, 2, "an oversized batch must insert nothing");
  });
});

test("real HTTP: fill-item accepts a fillable resource and rejects a non-fillable one", async (t) => {
  await withServer(t, async ({ pool }) => {
    const fillable = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/fill-item`, {
      confirmation: "FILL ITEM TO STORAGE",
      itemId: "AzuriteOre",
      quantity: 10
    });
    assert.equal(fillable.status, 200, JSON.stringify(fillable.body));
    assert.equal(fillable.body?.result?.ok, true);

    // A weapon (non-fillable group) must be refused by the real
    // resolveFillableCatalogItem() call, not silently accepted.
    const nonFillable = await call("POST", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/fill-item`, {
      confirmation: "FILL ITEM TO STORAGE",
      itemId: "SilverSword_Ranger",
      quantity: 1
    });
    assert.equal(nonFillable.status, 400);
    assert.match(nonFillable.body?.error || "", /not allowed for fill operation/);

    const rows = await itemsIn(pool, CHEST * 10);
    assert.ok(rows.some((row) => row.template_id === "AzuriteOre"));
    assert.equal(rows.some((row) => row.template_id === "SilverSword_Ranger"), false);
  });
});

test("real HTTP: bulk-delete-items removes only the requested rows that actually exist", async (t) => {
  await withServer(t, async ({ pool }) => {
    const before = await itemsIn(pool, CHEST * 10);
    const scrapId = before.find((row) => row.template_id === "ScrapMetal").id;

    const { status, body } = await call("DELETE", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/items`, {
      confirmation: "DELETE ITEMS",
      itemIds: [scrapId, "999999999"]
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body?.result?.removed?.length, 1, "the nonexistent id must be skipped, not errored");
    assert.match(body?.result?.message || "", /1 of 2 requested item\(s\)/);

    const after = await itemsIn(pool, CHEST * 10);
    assert.equal(after.length, 1);
    assert.equal(after[0].template_id, "MagnetiteOre");
  });
});

test("real HTTP: delete-all-items clears every real row in the container", async (t) => {
  await withServer(t, async ({ pool }) => {
    const { status, body } = await call("DELETE", `/api/bases/${BUILDING_ACTOR}/containers/${CHEST}/all-items`, {
      confirmation: "DELETE ALL ITEMS"
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body?.result?.removed?.length, 2);

    assert.equal((await itemsIn(pool, CHEST * 10)).length, 0);
    // The refinery's own inventory, reached through a different container,
    // must be completely unaffected by a delete-all on the chest.
    assert.equal((await itemsIn(pool, REFINERY * 10)).length, 1);
  });
});

test("real HTTP: bulk-delete-items and delete-all-items refuse a refining-group container", async (t) => {
  await withServer(t, async ({ pool }) => {
    const items = await call("DELETE", `/api/bases/${BUILDING_ACTOR}/containers/${REFINERY}/items`, {
      confirmation: "DELETE ITEMS",
      itemIds: [(await itemsIn(pool, REFINERY * 10))[0].id]
    });
    assert.equal(items.status, 400);
    assert.match(items.body?.error || "", /only be deleted from Storage containers/);

    const all = await call("DELETE", `/api/bases/${BUILDING_ACTOR}/containers/${REFINERY}/all-items`, {
      confirmation: "DELETE ALL ITEMS"
    });
    assert.equal(all.status, 400);
    assert.match(all.body?.error || "", /only be deleted from Storage containers/);

    assert.equal((await itemsIn(pool, REFINERY * 10)).length, 1, "the refinery's real inventory must survive both attempts");
  });
});

test("real HTTP: an invalid base or container id 400s before any route-specific logic runs", async (t) => {
  await withServer(t, async () => {
    const { status, body } = await call("POST", "/api/bases/not-a-number/containers/1/give-item", {
      confirmation: "GIVE ITEM TO STORAGE",
      itemId: "AzuriteOre",
      quantity: 1
    });
    assert.equal(status, 400);
    assert.match(body?.error || "", /Invalid base or container ID/);
  });
});
