import { ApiError, post } from "../api/client";

type ConsoleState = { instanceId?: string; config?: Record<string, unknown> };
async function readState(): Promise<ConsoleState> {
  const response = await fetch("/api/auth/state", { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("The Console is reconnecting.");
  return response.json();
}

// A restart is ready only when a different API process reports the saved
// configuration. The old process and proxy error pages cannot complete it.
export async function restartConsoleAndReload(
  matchConfig: (config: Record<string, unknown>) => boolean,
  { onRestarting, onTimeout }: { onRestarting?: () => void; onTimeout?: (message: string) => void } = {}
): Promise<void> {
  const before = await readState();
  if (!before.instanceId) throw new Error("Reload the Console before restarting it.");
  onRestarting?.();
  try {
    await post("/api/setup/discord-restart", {});
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    // The helper may have started even if its response was interrupted.
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  for (let i = 0; i < 300 && Date.now() < deadline; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const state = await readState();
      if (state.instanceId && state.instanceId !== before.instanceId && matchConfig(state.config || {})) {
        window.location.replace("/");
        return;
      }
    } catch { /* container mid-recreate; keep polling */ }
  }
  onTimeout?.("The Console is taking longer than expected to rebuild. Check the server, then reload this page when the Console is ready.");
}
