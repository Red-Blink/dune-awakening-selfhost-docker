import { api, post } from "./client";

// Outgoing webhooks (console/api/src/services/webhookNotifier.js). Stored URLs
// are secrets: the API returns only `hasUrl` and a short `urlHint`. Saving a
// webhook without `url` keeps the stored one.
export type WebhookEvent = "serverRestart" | "gameUpdate" | "consoleUpdate";
export type WebhookType = "discord" | "generic";

export type WebhookDelivery = { at: string; event: string; ok: boolean; status: number; error: string };

export type Webhook = {
  id: string;
  name: string;
  type: WebhookType;
  enabled: boolean;
  events: WebhookEvent[];
  includeMapRestarts: boolean;
  hasUrl: boolean;
  urlHint: string;
  lastDelivery: WebhookDelivery | null;
};

export type WebhookSettings = {
  updateCheckMinutes: number;
  webhooks: Webhook[];
  limits: { maxWebhooks: number; updateCheckMinutes: { min: number; max: number } };
};

export type WebhookDraft = Omit<Webhook, "id" | "hasUrl" | "urlHint" | "lastDelivery"> & { id?: string; url?: string };

export const webhooksApi = {
  settings: () => api<WebhookSettings>("/api/settings/webhooks", { cache: "no-store" }),
  save: (updateCheckMinutes: number, webhooks: WebhookDraft[]) =>
    post<WebhookSettings>("/api/settings/webhooks", { updateCheckMinutes, webhooks }),
  test: (id: string) => post<{ ok: boolean; status: number; error: string }>("/api/settings/webhooks/test", { id })
};
