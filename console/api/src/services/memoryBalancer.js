import { spawn } from "node:child_process";
import { buildDuneArgs, runDune } from "../runner.js";
import { parseMemoryStatusRows } from "../statusParsers.js";
import { redact } from "../redact.js";

const MEMORY_BALANCER_INTERVAL_MS = 10000;
const MEMORY_BALANCER_HIGH_WATERMARK = 90;
const MEMORY_BALANCER_DONOR_MAX_PERCENT = 55;
const MEMORY_BALANCER_EMERGENCY_DONOR_MAX_PERCENT = 70;
const MEMORY_BALANCER_DONOR_POST_TRANSFER_MAX_PERCENT = 80;
const MEMORY_BALANCER_CHUNK_BYTES = 1024 ** 3;
const MEMORY_BALANCER_MIN_HEADROOM_BYTES = 1024 ** 3;

export function createMemoryBalancer(config) {
  const state = {
    enabled: false,
    running: false,
    baselineLimits: new Map(),
    lastMessage: "Memory Balancer is off.",
    lastAction: "",
    lastError: "",
    updatedAt: null
  };

  async function readLiveRows() {
    const stdout = await runProcessText(config, "docker", ["stats", "--no-stream", "--format", "{{json .}}"], 10000);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseDockerStatsRow).filter(Boolean);
  }

  async function captureBaseline() {
    const rows = await readLiveRows().catch(() => []);
    for (const row of rows) {
      if (row.limitBytes > 0 && !state.baselineLimits.has(row.container)) {
        state.baselineLimits.set(row.container, row.limitBytes);
      }
    }
  }

  async function restoreBaseline() {
    const configuredLimits = await configuredMemoryLimitsByContainer(config, readLiveRows).catch(() => new Map());
    const restoreTargets = new Map(state.baselineLimits);
    for (const [container, limitBytes] of configuredLimits.entries()) {
      restoreTargets.set(container, limitBytes);
    }
    for (const [container, limitBytes] of restoreTargets.entries()) {
      if (limitBytes > 0) {
        await dockerUpdateMemoryLimit(config, container, limitBytes).catch((error) => {
          state.lastError = redact(error.message || error);
        });
      }
    }
    state.updatedAt = new Date().toISOString();
  }

  async function tick() {
    if (!state.enabled || state.running) return;
    state.running = true;
    try {
      const rows = (await readLiveRows()).filter((row) => row.usedBytes > 0 && row.limitBytes > 0);
      for (const row of rows) {
        if (!state.baselineLimits.has(row.container)) state.baselineLimits.set(row.container, row.limitBytes);
      }
      const target = rows.filter((row) => row.percent >= MEMORY_BALANCER_HIGH_WATERMARK).sort((a, b) => b.percent - a.percent)[0];
      if (!target) {
        state.lastMessage = "Memory Balancer is monitoring running maps";
        state.lastAction = "";
        state.lastError = "";
        state.updatedAt = new Date().toISOString();
        return;
      }

      const donor = selectMemoryBalancerDonor(rows, target);

      if (!donor) {
        state.lastMessage = `${target.map} is above ${MEMORY_BALANCER_HIGH_WATERMARK}% memory, but no running map has enough spare memory to donate safely`;
        state.lastAction = "";
        state.lastError = "";
        state.updatedAt = new Date().toISOString();
        return;
      }

      const donorLimit = donor.limitBytes - MEMORY_BALANCER_CHUNK_BYTES;
      const targetLimit = target.limitBytes + MEMORY_BALANCER_CHUNK_BYTES;
      await dockerUpdateMemoryLimit(config, target.container, targetLimit);
      await dockerUpdateMemoryLimit(config, donor.container, donorLimit);
      state.lastMessage = `Moved 1 GB from ${donor.map} to ${target.map}`;
      state.lastAction = `${donor.container} -> ${target.container}`;
      state.lastError = "";
      state.updatedAt = new Date().toISOString();
    } catch (error) {
      state.lastError = redact(error.message || error);
      state.lastMessage = "Memory Balancer could not rebalance memory.";
      state.updatedAt = new Date().toISOString();
    } finally {
      state.running = false;
    }
  }

  async function setEnabled(enabled) {
    state.enabled = enabled;
    state.lastError = "";
    state.updatedAt = new Date().toISOString();

    if (enabled) {
      state.baselineLimits.clear();
      state.lastMessage = "Memory Balancer is monitoring running maps";
      await captureBaseline();
      void tick();
    } else {
      state.lastMessage = "Restoring configured memory limits.";
      await restoreBaseline();
      state.baselineLimits.clear();
      state.lastMessage = "Memory Balancer is off. Configured memory limits are active.";
    }

    return publicState();
  }

  function publicState() {
    return {
      enabled: state.enabled,
      running: state.running,
      lastMessage: state.lastMessage,
      lastAction: state.lastAction,
      lastError: state.lastError,
      updatedAt: state.updatedAt
    };
  }

  return {
    intervalMs: MEMORY_BALANCER_INTERVAL_MS,
    publicState,
    readLiveRows,
    setEnabled,
    tick
  };
}

async function configuredMemoryLimitsByContainer(config, readLiveRows) {
  const [rows, result] = await Promise.all([
    readLiveRows(),
    runDune(config, buildDuneArgs("memoryStatus"), { timeoutMs: 10000 })
  ]);
  const configuredRows = parseMemoryStatusRows(result.stdout || "");
  const byMap = new Map(configuredRows.map((row) => [String(row.map), parseMemorySettingBytes(row.memory)]).filter(([, bytes]) => bytes > 0));
  const limits = new Map();
  for (const row of rows) {
    const key = memoryTargetForContainer(row.container);
    const partitionId = partitionIdFromContainer(row.container);
    const configured = byMap.get(key) || (partitionId ? configuredMemoryForPartition(byMap, partitionId) : 0);
    if (configured > 0) limits.set(row.container, configured);
  }
  return limits;
}

function memoryTargetForContainer(container) {
  if (container === "dune-server-survival-1") return "Survival_1";
  const survivalPartition = String(container || "").match(/^dune-server-survival-1-(\d+)$/);
  if (survivalPartition) return `Survival_1:${survivalPartition[1]}`;
  if (container === "dune-server-overmap") return "Overmap";
  return mapFromContainerName(container);
}

function partitionIdFromContainer(container) {
  const match = String(container || "").match(/^dune-server-.+-(\d+)$/);
  return match ? match[1] : "";
}

function configuredMemoryForPartition(byMap, partitionId) {
  const suffix = `:${partitionId}`;
  for (const [map, bytes] of byMap.entries()) {
    if (String(map).endsWith(suffix) && bytes > 0) return bytes;
  }
  return 0;
}

function parseMemorySettingBytes(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*([KMGT]i?B|[KMGT]B?|[kmgt]i?b|[kmgt]b?)/);
  return match ? parseDockerBytes(`${match[1]}${match[2]}`) : 0;
}

function selectMemoryBalancerDonor(rows, target) {
  const candidates = rows
    .filter((row) => row.container !== target.container)
    .filter((row) => row.limitBytes - MEMORY_BALANCER_CHUNK_BYTES >= minimumBalancerLimit(row))
    .filter((row) => percentAfterMemoryDonation(row) <= MEMORY_BALANCER_DONOR_POST_TRANSFER_MAX_PERCENT);
  const normal = candidates
    .filter((row) => row.percent <= MEMORY_BALANCER_DONOR_MAX_PERCENT)
    .sort((a, b) => a.percent - b.percent || b.limitBytes - a.limitBytes)[0];
  if (normal) return normal;
  return candidates
    .filter((row) => row.percent <= MEMORY_BALANCER_EMERGENCY_DONOR_MAX_PERCENT)
    .sort((a, b) => a.percent - b.percent || b.limitBytes - a.limitBytes)[0] || null;
}

function percentAfterMemoryDonation(row) {
  const nextLimit = row.limitBytes - MEMORY_BALANCER_CHUNK_BYTES;
  return nextLimit > 0 ? (row.usedBytes / nextLimit) * 100 : 100;
}

function minimumBalancerLimit(row) {
  return Math.max(row.usedBytes + MEMORY_BALANCER_MIN_HEADROOM_BYTES, Math.ceil(row.usedBytes * 1.25), MEMORY_BALANCER_CHUNK_BYTES);
}

async function dockerUpdateMemoryLimit(config, container, limitBytes) {
  await runProcessText(config, "docker", dockerMemoryUpdateArgs(container, limitBytes), 15000);
}

export function dockerMemoryUpdateArgs(container, limitBytes) {
  const memory = dockerMemoryArg(limitBytes);
  return ["update", "--memory", memory, "--memory-swap", memory, "--memory-reservation", memory, container];
}

function dockerMemoryArg(bytes) {
  return `${Math.max(256, Math.round(bytes / (1024 ** 2)))}m`;
}

export function parseDockerStatsRow(line) {
  try {
    const row = JSON.parse(line);
    const name = String(row.Name || row.Container || "");
    if (!name.startsWith("dune-server-")) return null;
    const memory = parseMemoryUsage(row.MemUsage || row.MemUsageBytes || "");
    return {
      container: name,
      map: mapFromContainerName(name),
      usedBytes: memory.usedBytes,
      limitBytes: memory.limitBytes,
      percent: Number.parseFloat(String(row.MemPerc || "").replace(/%/g, "")) || memory.percent || 0,
      raw: String(row.MemUsage || "")
    };
  } catch {
    return null;
  }
}

function parseMemoryUsage(value) {
  const [usedRaw, limitRaw] = String(value || "").split("/").map((part) => part.trim());
  const usedBytes = parseDockerBytes(usedRaw);
  const limitBytes = parseDockerBytes(limitRaw);
  return {
    usedBytes,
    limitBytes,
    percent: limitBytes > 0 ? roundPercent((usedBytes / limitBytes) * 100) : 0
  };
}

export function parseDockerBytes(value) {
  const match = String(value || "").match(/^[\d.]+\s*([KMGTPE]?i?B)?$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(String(value).replace(/[^\d.]/g, "")) || 0;
  const unit = String(match[1] || "B").toLowerCase();
  const multipliers = { b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2, gb: 1000 ** 3, gib: 1024 ** 3, tb: 1000 ** 4, tib: 1024 ** 4 };
  return Math.round(amount * (multipliers[unit] || 1));
}

function mapFromContainerName(name) {
  if (name === "dune-server-survival-1") return "Survival_1";
  if (/^dune-server-survival-1-\d+$/.test(name)) return `Survival_1 partition ${name.split("-").pop()}`;
  if (name === "dune-server-overmap") return "Overmap";
  return name.replace(/^dune-server-/, "");
}

function runProcessText(config, command, args, timeoutMs = 10000) {
  return new Promise((resolveText, rejectText) => {
    const child = spawn(command, args, {
      cwd: config.repoRoot,
      env: process.env,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectText(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectText(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveText(stdout);
      else rejectText(new Error(stderr || stdout || `${command} exited ${code}`));
    });
  });
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
