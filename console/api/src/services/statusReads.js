import { redact } from "../redact.js";
import { buildServerStatusResponse } from "../statusParsers.js";

// Home's status and readiness reads. `?fresh=1` skips stored snapshots while a
// start or restart is being watched, and `sampledAt` dates the reading from when
// the command ran. Readiness keeps its own short cache: callers that never send
// `fresh` must not be handed a stale "READY" mid-restart.
export function createStatusReads({ statusCache, readinessCache, argsFor, runArgs }) {
  async function read(operation, url, cache) {
    const fresh = url?.searchParams?.get("fresh") === "1";
    const args = argsFor(operation);
    try {
      const stamped = await cache.runStamped(JSON.stringify(args), () => runArgs(args), { fresh });
      const result = stamped.value;
      return {
        result: { operation, stdout: result.stdout, stderr: result.stderr, exitCode: result.code },
        // A failed command has no sample time, so only successes are stamped.
        stamp: { sampledAt: new Date(stamped.sampledAtMs).toISOString(), fromCache: stamped.fromCache }
      };
    } catch (error) {
      return {
        result: { operation, stdout: redact(error.stdout || ""), stderr: redact(error.stderr || error?.message || "Unexpected error."), exitCode: error.code || 1 },
        stamp: {}
      };
    }
  }

  return {
    async status(url, { includeRaw = true } = {}) {
      const { result, stamp } = await read("status", url, statusCache);
      return { ...buildServerStatusResponse(result, { includeRaw }), ...stamp };
    },
    async readiness(url) {
      const { result, stamp } = await read("readiness", url, readinessCache);
      return { ...result, ...stamp };
    },
    // For a start, stop or restart: anything cached describes the old state.
    invalidate() {
      statusCache.invalidate();
      readinessCache.invalidate();
    }
  };
}
