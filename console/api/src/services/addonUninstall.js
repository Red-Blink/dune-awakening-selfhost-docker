import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const AIRDROP_ID = "dune-airdrop-addon";
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}';

export function addonUninstallNotice(id) {
  return id === AIRDROP_ID
    ? "This stops and removes this server's Airdrop companion containers and deletes its reward queues, settings, and database triggers before removing the addon files."
    : "This removes the addon files, Console jobs, and stored addon data. Any manually installed external services must be removed separately.";
}

function cleanupError(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function dockerRun(args) {
  try {
    return await execFileAsync("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  } catch {
    // Docker errors can include local paths or command output. Keep those out
    // of the response, and never delete the addon after an incomplete cleanup.
    throw cleanupError("Airdrop companion cleanup failed. Check Docker access and retry Uninstall. The addon files have been retained.");
  }
}

export function airdropContainerBelongsToProject(container, hostRoot) {
  const mounts = Array.isArray(container.mounts) ? container.mounts : [];
  const mounted = (source, destination) => mounts.some((mount) => mount.Type === "bind" &&
    resolve(String(mount.Source || "/")) === resolve(hostRoot, source) && mount.Destination === destination);
  const labels = container.labels || {};
  return (mounted(".env", "/repo/.env") && mounted("runtime/scripts", "/repo/runtime/scripts")) ||
    (labels["io.dunedocker.addon.id"] === AIRDROP_ID &&
      labels["io.dunedocker.project.root"] === hostRoot);
}

async function companionContainers(config, run) {
  const ids = new Set();
  for (const filter of ["name=airdrop", `label=io.dunedocker.addon.id=${AIRDROP_ID}`]) {
    const { stdout } = await run(["ps", "--all", "--filter", filter, "--format", "{{.ID}}"]);
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw cleanupError("Docker returned an invalid companion identifier. The addon was not removed.");
      ids.add(id);
    }
  }
  const hostRoot = resolve(config.hostRepoRoot || process.env.DUNE_HOST_REPO_ROOT || config.repoRoot);
  const owned = [];
  for (const id of ids) {
    const { stdout } = await run(["inspect", "--format", INSPECT, id]);
    let container;
    try { container = JSON.parse(stdout); } catch { throw cleanupError("The Airdrop companion could not be identified. The addon was not removed."); }
    const name = String(container.name || "").replace(/^\//, "");
    const belongs = airdropContainerBelongsToProject(container, hostRoot);
    if (!belongs) {
      if (name === "airdrop-daemon") throw cleanupError("The airdrop-daemon container could not be matched to this server. Verify its project mounts or remove it manually before retrying Uninstall.");
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(container.id) || !container.id.startsWith(id) ||
        /^(?:dune-(?:server|postgres|rmq|director|gateway|autoscaler|orchestrator|text-router|coriolis)|redblink-dune-docker-console)(?:$|-)/.test(name) ||
        /registry\.funcom\.com\//.test(String(container.image || ""))) {
      throw cleanupError("Airdrop cleanup refused to modify a core service. The addon was not removed.");
    }
    owned.push(container.id);
  }
  return owned;
}

// These are core-reviewed statements for the legacy Airdrop integration, not
// scripts supplied by an addon. Legacy dune.* tables may be shared and stay.
export async function cleanupAirdropDatabase(db, { apply = false } = {}) {
  if (!db?.transaction) throw cleanupError("The database must be available to remove Airdrop safely. The addon files have been retained.");
  return db.transaction(async (tx) => {
    await tx.query("set local lock_timeout = '5s'");
    await tx.query("set local statement_timeout = '15s'");
    const schema = await tx.query("select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'dune_airdrop'");
    if (schema.rows.some((row) => row.owner !== "dune")) {
      throw cleanupError("The dune_airdrop schema has an unexpected owner. Review it manually before uninstalling.");
    }
    const triggers = await tx.query(`
      select c.relname as table_name, p.proname as function_name, pn.nspname as function_schema
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace pn on pn.oid = p.pronamespace
      where n.nspname = 'dune' and c.relname in ('player_state', 'encrypted_player_state')
        and t.tgname = 'trg_player_state_playtime' and not t.tgisinternal
    `);
    for (const row of triggers.rows) {
      if (!["player_state", "encrypted_player_state"].includes(row.table_name) ||
          !["dune_airdrop", "dune"].includes(row.function_schema) ||
          !["trg_track_playtime", "trg_track_playtime_v2"].includes(row.function_name)) {
        throw cleanupError("The playtime trigger does not match the Airdrop addon. Review it manually before uninstalling.");
      }
    }
    if (!apply) return;
    for (const row of triggers.rows) await tx.query(`drop trigger trg_player_state_playtime on dune.${row.table_name}`);
    await tx.query("drop schema if exists dune_airdrop cascade");
  });
}

export async function cleanupAddonCompanions(config, id, { db, runDocker = dockerRun } = {}) {
  if (id !== AIRDROP_ID) return;
  // Complete all identification/database checks before touching any service.
  const containers = await companionContainers(config, runDocker);
  try {
    await cleanupAirdropDatabase(db);
    for (const container of containers) {
      await runDocker(["update", "--restart=no", container]);
      await runDocker(["stop", "--time", "15", container]);
    }
    await cleanupAirdropDatabase(db, { apply: true });
    for (const container of containers) await runDocker(["rm", container]);
  } catch (error) {
    if (error?.statusCode === 409) throw error;
    throw cleanupError("Airdrop database or companion cleanup failed. The addon is still installed and disabled. Check database access and retry Uninstall.");
  }
}
