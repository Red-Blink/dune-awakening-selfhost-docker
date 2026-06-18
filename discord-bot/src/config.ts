export type BotConfig = {
  discordBotTokenFile: string;
  duneBotApiTokenFile: string;
  duneConsoleApiUrl: string;
  discordClientId: string;
  discordGuildId: string;
  observerRoleIds: string[];
  moderatorRoleIds: string[];
  adminRoleIds: string[];
  ownerRoleIds: string[];
  publicStatusChannelId?: string;
  adminAlertChannelId?: string;
  discordWritesEnabled: false;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalCsv(name: string): string[] {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function loadConfig(): BotConfig {
  return {
    discordBotTokenFile: requiredEnv("DISCORD_BOT_TOKEN_FILE"),
    duneBotApiTokenFile: requiredEnv("DUNE_BOT_API_TOKEN_FILE"),
    duneConsoleApiUrl: requiredEnv("DUNE_CONSOLE_API_URL"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID"),
    observerRoleIds: optionalCsv("DISCORD_OBSERVER_ROLE_IDS"),
    moderatorRoleIds: optionalCsv("DISCORD_MODERATOR_ROLE_IDS"),
    adminRoleIds: optionalCsv("DISCORD_ADMIN_ROLE_IDS"),
    ownerRoleIds: optionalCsv("DISCORD_OWNER_ROLE_IDS"),
    publicStatusChannelId: optionalEnv("DISCORD_PUBLIC_STATUS_CHANNEL_ID"),
    adminAlertChannelId: optionalEnv("DISCORD_ADMIN_ALERT_CHANNEL_ID"),
    discordWritesEnabled: false
  };
}

export function validateConfig(config: BotConfig): void {
  const url = new URL(config.duneConsoleApiUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("DUNE_CONSOLE_API_URL must use http or https.");
  if (!config.ownerRoleIds.length) throw new Error("At least one owner role ID must be configured.");
}
