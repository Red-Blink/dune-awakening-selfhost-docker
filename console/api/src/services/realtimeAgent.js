// Realtime Data position agent: shows whether the optional `mvagent` runs on this
// host and turns it on (build + start) or off (stop + remove) from Settings.
//
// The agent (services/realtime.js talks to it) reads game server memory, so it
// runs as root with ptrace rights in its own container. That is why this is an
// owner action (settings:write, like the encrypted API access), never something
// an API key or an addon can start, and never done on its own when a key is
// granted "Realtime Data": the owner has to ask for it and confirm it.
//
// Fixed inputs only: the compose file, Dockerfile and script ship with the
// Console and nothing the caller sends reaches Docker.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const REALTIME_AGENT_CONTAINER = "dune-realtime-agent";
const COMPOSE_FILE = "docker-compose.realtime-agent.yml";
const SCRIPT_PATH = ["runtime", "scripts", "realtime-agent.sh"];
const DOCKERFILE_PATH = ["runtime", "realtime-agent", "Dockerfile"];
const ENABLE_TIMEOUT_MS = 15 * 60 * 1000; // the first start builds the image from source

export class RealtimeAgentError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "RealtimeAgentError";
    this.status = status;
  }
}

export function createRealtimeAgent({ repoRoot, health, run = execFileOutput, exists = existsSync } = {}) {
  let busy = null; // "install" | "remove" while one is running

  const present = () => [COMPOSE_FILE, SCRIPT_PATH.join("/"), DOCKERFILE_PATH.join("/")].every((file) => exists(resolve(repoRoot, file)));

  async function container() {
    try {
      const out = await run("docker", ["inspect", "--format", "{{.State.Status}}", REALTIME_AGENT_CONTAINER], { timeout: 10_000 });
      return { exists: true, state: String(out).trim().toLowerCase() };
    } catch {
      return { exists: false, state: "" };
    }
  }

  // Does the agent answer? Asked through the same service the API uses, so a
  // wrong DUNE_REALTIME_AGENT_URL shows up here too.
  async function reachable() {
    try {
      const answer = await health();
      return { reachable: Boolean(answer?.available), reason: "" };
    } catch (error) {
      return { reachable: false, reason: error?.status === 500 ? "misconfigured" : "not-running" };
    }
  }

  return {
    // Contains nothing secret.
    async status() {
      const available = present();
      const [c, h] = await Promise.all([available ? container() : { exists: false, state: "" }, reachable()]);
      return {
        available,
        installed: c.exists,
        running: c.exists && c.state === "running",
        state: c.state,
        reachable: h.reachable,
        reason: h.reachable ? "" : h.reason,
        busy
      };
    },

    // Installing builds the image from source and starts a root container; it
    // needs `confirmed: true` as an explicit act, on top of the Settings
    // permission. Serialized: a second call while one runs is refused.
    async setEnabled(enabled, { confirmed } = {}) {
      if (typeof enabled !== "boolean") throw new RealtimeAgentError("Send { \"enabled\": true, \"confirmed\": true } or { \"enabled\": false }.", 400);
      if (enabled && confirmed !== true) throw new RealtimeAgentError("Installing the agent has to be confirmed.", 400);
      if (!present()) throw new RealtimeAgentError("This installation does not include the Realtime Data agent setup.", 404);
      if (busy) throw new RealtimeAgentError("The Realtime Data agent is being changed. Try again in a moment.", 409);
      busy = enabled ? "install" : "remove";
      try {
        await run(resolve(repoRoot, ...SCRIPT_PATH), [enabled ? "enable" : "disable"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: ENABLE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        throw new RealtimeAgentError(enabled
          ? "The Realtime Data agent could not be set up, or it started but did not answer in time. Check the output with: runtime/scripts/realtime-agent.sh enable"
          : "The Realtime Data agent could not be removed.", 502);
      } finally {
        busy = null;
      }
      return this.status();
    }
  };
}

function execFileOutput(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, shell: false, ...options }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout || "");
    });
  });
}
