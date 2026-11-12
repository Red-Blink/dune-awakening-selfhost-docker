import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildDuneArgs, runDune } from "../runner.js";
import { parseMemoryStatusRows } from "../statusParsers.js";
import { redact } from "../redact.js";
import { writeDiagnostic } from "./diagnosticLog.js";

const MEMORY_BALANCER_INTERVAL_MS = 10000;
const MEMORY_BALANCER_HIGH_WATERMARK = 90;
const MEMORY_BALANCER_DONOR_MAX_PERCENT = 55;
const MEMORY_BALANCER_EMERGENCY_DONOR_MAX_PERCENT = 70;
const MEMORY_BALANCER_DONOR_POST_TRANSFER_MAX_PERCENT = 80;
const MEMORY_BALANCER_CHUNK_BYTES = 1024 ** 3;
const MEMORY_BALANCER_MIN_HEADROOM_BYTES = 1024 ** 3;
const LIVE_MEMORY_CACHE_MS = 10000;
const SWAP_SAMPLE_CONCURRENCY = 4;
const SWAP_SAMPLE_TIMEOUT_MS = 3000;
const CONTAINER_SWAP_STAT_SCRIPT = `if [ -r /sys/fs/cgroup/memory.swap.current ]; then
  current=$(cat /sys/fs/cgroup/memory.swap.current 2>/dev/null) || exit 1
  maximum=$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null) || exit 1
  printf 'v2|%s|%s\\n' "$current" "$maximum"
elif [ -r /sys/fs/cgroup/memory/memory.memsw.usage_in_bytes ] && [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
  memory_current=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null) || exit 1
  combined_current=$(cat /sys/fs/cgroup/memory/memory.memsw.usage_in_bytes 2>/dev/null) || exit 1
  memory_max=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null) || exit 1
  combined_max=$(cat /sys/fs/cgroup/memory/memory.memsw.limit_in_bytes 2>/dev/null) || exit 1
  printf 'v1|%s|%s|%s|%s\\n' "$memory_current" "$combined_current" "$memory_max" "$combined_max"
else
  exit 2
fi`;

export function createDockerStatsSampler(config, options = {}) {
  const collect = options.collect || (async () => {
    const stdout = await runProcessText(config, "docker", ["stats", "--no-stream", "--format", "{{json .}}"], 10000);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseDockerStatsRow).filter(Boolean);
  });
  // Injected RAM collectors are used by unit tests and callers that do not own
  // Docker access. They opt into swap enrichment by injecting collectSwap too.
  const collectSwap = options.collectSwap || (options.collect ? async () => new Map() : (rows) => collectContainerSwapStats(config, rows));
  const now = options.now || Date.now;
  const cacheMs = Math.max(0, Number(options.cacheMs ?? LIVE_MEMORY_CACHE_MS));
  let cached = null;
  let inFlight = null;

  async function read(readOptions = {}) {
    const currentTime = now();
    if (!readOptions.fresh && cached && currentTime - cached.sampledAtMs < cacheMs) return cached;
    if (inFlight) return inFlight;

    inFlight = Promise.resolve()
      .then(collect)
      .then(async (rows) => applyContainerSwapStats(rows, await collectSwap(rows)))
      .then((rows) => {
        const sampledAtMs = now();
        cached = {
          rows,
          sampledAt: new Date(sampledAtMs).toISOString(),
          sampledAtMs
        };
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { read };
}

export async function collectContainerSwapStats(config, rows, options = {}) {
  if (readMemorySwapAllowanceBytes(config) <= 0) return new Map();
  const run = options.run || ((container) => runProcessText(config, "docker", ["exec", container, "sh", "-c", CONTAINER_SWAP_STAT_SCRIPT], SWAP_SAMPLE_TIMEOUT_MS));
  const concurrency = Math.max(1, Math.min(16, Number(options.concurrency) || SWAP_SAMPLE_CONCURRENCY));
  const queue = [...new Set((rows || []).map((row) => String(row?.container || "")).filter((name) => /^dune-server-[a-z0-9-]+$/i.test(name)))];
  const result = new Map();

  for (let index = 0; index < queue.length; index += concurrency) {
    await Promise.all(queue.slice(index, index + concurrency).map(async (container) => {
      try {
        const output = await run(container);
        const parsed = parseContainerSwapStats(output);
        if (parsed.supported) result.set(container, parsed);
      } catch {
        // A container may stop between docker stats and this sample. RAM data
        // remains valid while swap simply renders as unavailable for this poll.
      }
    }));
  }
  return result;
}

export function applyContainerSwapStats(rows, swapByContainer) {
  return (rows || []).map((row) => {
    const swap = swapByContainer?.get?.(row.container);
    return {
      ...row,
      swapUsedBytes: swap?.supported ? swap.usedBytes : 0,
      swapLimitBytes: swap?.supported ? swap.limitBytes : 0,
      swapSupported: Boolean(swap?.supported)
    };
  });
}

export function parseContainerSwapStats(value) {
  const parts = String(value || "").trim().split("|");
  if (parts[0] === "v2" && parts.length === 3) {
    const usedBytes = parseCgroupByteCounter(parts[1]);
    const limitBytes = parseCgroupByteCounter(parts[2], { allowMax: true });
    if (usedBytes === null || limitBytes === null) return unsupportedSwapStats();
    return { supported: true, cgroupVersion: 2, usedBytes, limitBytes };
  }
  if (parts[0] === "v1" && parts.length === 5) {
    const memoryUsed = parseCgroupByteCounter(parts[1]);
    const combinedUsed = parseCgroupByteCounter(parts[2]);
    const memoryLimit = parseCgroupByteCounter(parts[3]);
    const combinedLimit = parseCgroupByteCounter(parts[4], { allowMax: true });
    if ([memoryUsed, combinedUsed, memoryLimit, combinedLimit].some((entry) => entry === null)) return unsupportedSwapStats();
    return {
      supported: true,
      cgroupVersion: 1,
      usedBytes: Math.max(0, combinedUsed - memoryUsed),
      limitBytes: Math.max(0, combinedLimit - memoryLimit)
    };
  }
  return unsupportedSwapStats();
}

function parseCgroupByteCounter(value, options = {}) {
  const text = String(value || "").trim();
  if (options.allowMax && text === "max") return 0;
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function unsupportedSwapStats() {
  return { supported: false, cgroupVersion: 0, usedBytes: 0, limitBytes: 0 };
}

export function createMemoryBalancer(config, options = {}) {
  const persisted = readMemoryBalancerSettings(config);
  const liveMemorySampler = options.sampler || createDockerStatsSampler(config);
  const applyMemoryLimit = options.applyMemoryLimit || ((container, limitBytes) => dockerUpdateMemoryLimit(config, container, limitBytes));
  const write = options.writeDiagnostic || writeDiagnostic;
  const state = {
    enabled: persisted.enabled,
    running: false,
    baselineLimits: new Map(),
    lastMessage: persisted.enabled ? "Memory Balancer is monitoring running maps" : "Memory Balancer is off.",
    lastAction: "",
    lastError: "",
    updatedAt: null
  };

  async function changeMemoryLimit(container, limitBytes, reason, previousLimitBytes = null) {
    const started = performance.now();
    const record = (outcome) => {
      try {
        write({ at: new Date().toISOString(), event: "memory.limit", container,
          previousLimitBytes, limitBytes, reason, outcome,
          durationMs: Math.round((performance.now() - started) * 100) / 100 });
      } catch {
        // A diagnostic sink failure must never prevent a memory operation.
      }
    };
    record("requested");
    try {
      await applyMemoryLimit(container, limitBytes);
      record("applied");
    } catch (error) {
      record("failed");
      throw error;
    }
  }

  async function readLiveSnapshot(options = {}) {
    return liveMemorySampler.read(options);
  }

  async function readLiveRows(options = {}) {
    return (await readLiveSnapshot(options)).rows;
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
        await changeMemoryLimit(container, limitBytes, "restore-configured").catch((error) => {
          state.lastError = redact(error?.message || "Unexpected error.");
        });
      }
    }
    state.updatedAt = new Date().toISOString();
  }

  async function tick() {
    if (!state.enabled || state.running) return;
    state.running = true;
    try {
      const rows = (await readLiveRows({ fresh: true })).filter((row) => row.usedBytes > 0 && row.limitBytes > 0);
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
      await changeMemoryLimit(target.container, targetLimit, "rebalance-receiver", target.limitBytes);
      await changeMemoryLimit(donor.container, donorLimit, "rebalance-donor", donor.limitBytes);
      state.lastMessage = `Moved 1 GB from ${donor.map} to ${target.map}`;
      state.lastAction = `${donor.container} -> ${target.container}`;
      state.lastError = "";
      state.updatedAt = new Date().toISOString();
    } catch (error) {
      state.lastError = redact(error?.message || "Unexpected error.");
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
    writeMemoryBalancerSettings(config, { enabled });

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
    readLiveSnapshot,
    readLiveRows,
    setEnabled,
    tick
  };
}

function memoryBalancerSettingsPath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime/generated"), "memory-balancer.json");
}

function readMemoryBalancerSettings(config) {
  const path = memoryBalancerSettingsPath(config);
  try {
    if (!existsSync(path)) return { enabled: false };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { enabled: parsed?.enabled === true };
  } catch {
    return { enabled: false };
  }
}

function writeMemoryBalancerSettings(config, settings) {
  const path = memoryBalancerSettingsPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ enabled: settings.enabled === true }, null, 2)}\n`, { mode: 0o664 });
  try { chmodSync(path, 0o664); } catch {}
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
  const swapAllowanceBytes = readMemorySwapAllowanceBytes(config);
  await runProcessText(config, "docker", dockerMemoryUpdateArgs(container, limitBytes, swapAllowanceBytes), 15000);
}

export function dockerMemoryUpdateArgs(container, limitBytes, swapAllowanceBytes = 0) {
  const memory = dockerMemoryArg(limitBytes);
  // With managed swap disabled, retain Docker's historical default of an
  // additional swap allowance equal to the RAM limit. Docker updates require
  // an explicit total so an old swap ceiling is not left behind.
  const additionalSwapBytes = swapAllowanceBytes > 0 ? swapAllowanceBytes : limitBytes;
  const memorySwap = dockerMemoryArg(limitBytes + additionalSwapBytes);
  return ["update", "--memory", memory, "--memory-swap", memorySwap, "--memory-reservation", memory, container];
}

export function readMemorySwapAllowanceBytes(config) {
  try {
    const env = readFileSync(resolve(config.repoRoot, ".env"), "utf8");
    const values = Object.fromEntries(env.split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key, value]) => key && value !== undefined));
    if (values.DUNE_MEMORY_SWAP_ENABLED !== "1") return 0;
    const gib = Number(values.DUNE_MEMORY_SWAP_PER_SERVER_GIB || 0);
    return Number.isInteger(gib) && gib >= 1 && gib <= 16 ? gib * (1024 ** 3) : 0;
  } catch {
    return 0;
  }
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
  if (/^dune-server-deepdesert-1(?:-\d+)?$/.test(name)) return "DeepDesert_1";
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
