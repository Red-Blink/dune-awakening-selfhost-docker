import { post } from "../api/client";

// #676 §6.3: disable/enable/forget must restart the console immediately and
// non-skippably -- unlike DiscordSetupWizard's own optional "restart later"
// pattern for a benign credential rotation, presenting "disabled" as fait
// accompli before the restart actually happens is misleading specifically
// during the scenario (suspected compromise) the disable/forget actions
// exist for. This mirrors the polling technique DiscordSetupWizard's own
// restartNow() already uses -- keying on the NEW process reporting the
// awaited condition, never on the connection dropping, which is what makes
// it correct behind a reverse proxy/tunnel (a mid-recreate 502 is a
// resolved fetch response, not a thrown error).
export async function restartConsoleAndReload(
  matchConfig: (config: Record<string, unknown>) => boolean,
  { onRestarting, onTimeout }: { onRestarting?: () => void; onTimeout?: (message: string) => void } = {}
): Promise<void> {
  onRestarting?.();
  try {
    await post("/api/setup/discord-restart", {});
  } catch { /* the container may drop the connection mid-response; expected */ }
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch("/api/auth/state", { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        if (matchConfig((body as { config?: Record<string, unknown> }).config || {})) {
          window.location.replace("/");
          return;
        }
      }
    } catch { /* container mid-recreate; keep polling */ }
  }
  onTimeout?.("The console is taking longer than expected to restart. Give it another minute and reload this page, or run `dune console restart` on the host.");
}
