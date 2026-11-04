import { api, post } from "./client";

// Realtime Data position agent (console/api/src/services/realtimeAgent.js).
export type RealtimeAgentStatus = {
  available: boolean;
  installed: boolean;
  running: boolean;
  state: string;
  reachable: boolean;
  reason: "" | "not-running" | "misconfigured";
  busy: "install" | "remove" | null;
};

export const realtimeAgentApi = {
  status: () => api<RealtimeAgentStatus>("/api/settings/realtime-agent", { cache: "no-store" }),
  install: () => post<RealtimeAgentStatus>("/api/settings/realtime-agent", { enabled: true, confirmed: true }),
  remove: () => post<RealtimeAgentStatus>("/api/settings/realtime-agent", { enabled: false })
};
