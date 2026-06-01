import { api, post } from "./client";
import type { Task } from "./setup";

export const mapsApi = {
  maps: () => api<{ stdout: string }>("/api/maps"),
  status: () => api<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>("/api/map/status"),
  mode: (map = "") => api<{ stdout: string }>(`/api/maps/mode${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  setMode: (body: { map: string; mode: string; confirmation: string }) => post<{ task: Task }>("/api/maps/mode", body),
  reconcile: (confirmation: string) => post<{ task: Task }>("/api/maps/reconcile", { confirmation }),
  spawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/spawn", { target, confirmation }),
  despawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/despawn", { target, confirmation }),
  autoscaler: () => api<{ stdout: string }>("/api/maps/autoscaler"),
  autoscalerAction: (action: string, confirmation: string) => post<{ task: Task }>("/api/maps/autoscaler", { action, confirmation }),
  memory: () => api<{ stdout: string }>("/api/maps/memory"),
  setMemory: (body: { map: string; memory: string; confirmation: string }) => post<{ task: Task }>("/api/maps/memory", { ...body, action: "set" }),
  unsetMemory: (body: { map: string; confirmation: string }) => post<{ task: Task }>("/api/maps/memory", { ...body, action: "unset" }),
  sietches: () => api<{ stdout: string }>("/api/sietches"),
  updateSietches: (body: Record<string, unknown>) => post<{ task: Task }>("/api/sietches/update", body),
  deepdesert: () => api<{ stdout: string }>("/api/deepdesert"),
  updateDeepdesert: (body: { action: string; confirmation: string }) => post<{ task: Task }>("/api/deepdesert/update", body)
};
