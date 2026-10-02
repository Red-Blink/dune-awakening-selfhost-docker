import { api, post } from "./client";

// Encrypted API access (console/api/src/services/encryptedApi.js). The fingerprint is public
// by design: it is what clients compare before they pin the key.
export type EncryptedApiStatus = {
  available: boolean;
  enabled: boolean;
  running: boolean;
  state: string;
  health: string;
  port: number;
  fingerprint: string;
};

export const encryptedApiApi = {
  status: () => api<EncryptedApiStatus>("/api/settings/encrypted-api", { cache: "no-store" }),
  setEnabled: (enabled: boolean) => post<EncryptedApiStatus>("/api/settings/encrypted-api", { enabled })
};
