import { api, post } from "./client";
import type { Task } from "./setup";

export type DiscordBotSettingsState = {
  enabled: boolean;
  roleIds: { player: string[]; moderator: string[]; admin: string[] };
  tokenConfigured: boolean;
  // Task 2 (hosted-bot console-initiated OAuth registration plan): the
  // real, persisted, server-readable source of truth for the hosted/
  // self-hosted `choice` toggle -- null when never set. Superset of what
  // the frontend used to hold only in localStorage.
  deploymentChoice?: "hosted" | "self-hosted" | null;
  // Final integration review (Important #5): persisted by the /register
  // route (server.js) on a successful mentat response, via
  // adapterSettings.js's persistHostedBotConnectedGuild() -- lets
  // DiscordBotSection show a real "Connected to hosted bot for {name}"
  // across a page reload instead of losing that state the moment the
  // in-memory React state is gone.
  hostedBotConnectedGuildId?: string | null;
  hostedBotConnectedGuildName?: string | null;
  // Real UAT finding (2026-09-09): "Connect to hosted bot" needs its own,
  // independent Discord Application -- deliberately separate from Settings
  // -> Discord OAuth's console-sign-in credentials ("we have OAuth without
  // bot and bot without OAuth"). Client ID/Redirect URI are safe to show
  // back (same non-secret status tokenConfigured already reports); the
  // client secret itself is never returned.
  hostedBotOAuthConfigured?: boolean;
  hostedBotOAuthClientId?: string | null;
  hostedBotOAuthRedirectUri?: string | null;
  // dune-awakening-selfhost-docker#903: the auto-invite flow's Discord
  // Application ID (config.js's autoInviteDiscordClientId) -- env-
  // overridable, defaults to Sahir Venn. Safe to return (a Discord
  // client_id is not a secret, same status as hostedBotOAuthClientId
  // above); the frontend uses it to build the OLD/Advanced flow's own
  // "Add to Discord" invite link instead of hardcoding the same value
  // a second time, so overriding the backend's env var can never leave
  // that button silently pointed at a different bot than the one the
  // one-click flow actually authorizes.
  autoInviteDiscordClientId?: string;
};

export const discordAdapterSettingsApi = {
  getState: () => api<DiscordBotSettingsState>("/api/settings/discord-bot"),
  // Real UAT finding (2026-09-09): enable() used to also trigger the
  // console restart in the same call, so a freshly-minted token could
  // only ever be shown at the exact moment the restart was already under
  // way. It now only persists config (.env + token file) and mints the
  // token -- restart() below is a separate, explicit call the frontend
  // makes only once the operator has had a chance to see/copy the token.
  // token is optional: the server omits it entirely when nothing was
  // minted (the already-enabled/role-ids-only path through
  // applyDiscordBotEnableRequest() -- see server.js's /enable handler,
  // which only sets `responseBody.token` when `result.tokenMinted`).
  enable: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ token?: string }>("/api/settings/discord-bot/enable", roleIds),
  updateRoleIds: (roleIds: { playerRoleIds: string; moderatorRoleIds: string; adminRoleIds: string; deploymentChoice?: "hosted" | "self-hosted" | null }) =>
    post<{ task: Task }>("/api/settings/discord-bot/role-ids", roleIds),
  regenerateToken: () => post<{ ok: boolean; token: string }>("/api/settings/discord-bot/regenerate-token", {}),
  // Triggers the actual console restart that applies whatever /enable or
  // /role-ids just persisted -- see those handlers' own comments in
  // server.js for why this is now a separate call.
  restart: () => post<{ task: Task }>("/api/settings/discord-bot/restart", {}),
  // Real UAT finding (2026-09-09, "I see no path to remove the bot"):
  // resets the adapter back to "never configured" (see
  // disableDiscordBotAdapter()'s own comment in adapterSettings.js for
  // exactly what it wipes). Like enable(), does not restart itself --
  // the caller follows up with restart() once ready.
  disable: () => post<{ ok: boolean }>("/api/settings/discord-bot/disable", {}),
  // Real UAT finding (2026-09-09): the hosted-bot connection's own,
  // independent Discord Application config -- see this file's own
  // DiscordBotSettingsState comment for why it's separate from Settings ->
  // Discord OAuth. Split into config (non-secret) + secret the same way
  // Settings -> Discord OAuth's own save flow already is.
  saveOAuthConfig: (config: { clientId?: string; redirectUri?: string }) =>
    post<{ ok: boolean }>("/api/settings/discord-bot/oauth-config", config),
  saveOAuthSecret: (secret: string) =>
    post<{ ok: boolean }>("/api/settings/discord-bot/oauth-secret", { secret }),
  // Real UAT finding (2026-09-10): the 3-step wizard's step 1 ("Add bot to
  // Discord") needs deploymentChoice persisted immediately on picking
  // "Hosted bot" -- see server.js's own comment on this route for why.
  setChoice: (deploymentChoice: "hosted" | "self-hosted") =>
    post<{ ok: boolean }>("/api/settings/discord-bot/choice", { deploymentChoice })
};
