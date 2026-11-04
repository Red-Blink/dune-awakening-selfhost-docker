import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getAdminPort, getServerPorts, resetServerPortsForTests, setAdminPort } from "./api/serverPorts";

// Regression coverage for the /api/auth/state -> setServerPorts/setAdminPort
// wiring added alongside console/api/src/config.js's resolvePorts() (see
// PR history) -- confirmed via a Requirement 20 Layer 1 audit that this
// exact call path had zero test coverage before this file was added.
afterEach(() => {
  resetServerPortsForTests();
  setAdminPort(8088);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App populates the shared serverPorts cache from /api/auth/state", () => {
  it("stores real, non-default port values and the admin port from the response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (String(path).includes("/api/auth/state")) {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: false,
          csrfToken: null,
          config: {
            port: 9088,
            ports: {
              postgres: 16432,
              rmqGame: 32982,
              rmqGameHttp: 32983,
              clientBase: 8777,
              igwBase: 8888
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }));

    render(<App />);

    await waitFor(() => {
      expect(getServerPorts().postgres).toBe(16432);
    });
    expect(getServerPorts().rmqGame).toBe(32982);
    expect(getServerPorts().rmqGameHttp).toBe(32983);
    expect(getServerPorts().clientBase).toBe(8777);
    expect(getServerPorts().igwBase).toBe(8888);
    expect(getAdminPort()).toBe(9088);
  });

  it("keeps stock defaults when the server response has no ports field at all (older build during a rolling upgrade)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (String(path).includes("/api/auth/state")) {
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: false,
          csrfToken: null
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }));

    render(<App />);

    await waitFor(() => {
      // Nothing to await on directly here since there's no change --
      // this just confirms the app doesn't crash/error on a response
      // missing the new field, and the cache stays at its defaults.
      expect(getServerPorts().postgres).toBe(15432);
    });
    expect(getAdminPort()).toBe(8088);
  });
});

describe("sidebar version badge", () => {
  it("marks community support links with a trailing external-link icon", async () => {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      if (String(path).includes("/api/auth/state")) return json({ authenticated: true, csrfToken: "t" });
      if (String(path).includes("/api/setup/state")) return json({ files: { complete: true }, config: {} });
      return json({ error: "unavailable" }, 500);
    }));
    render(<App />);
    for (const name of ["Requests", "Report Issues", "Get Help"]) {
      const link = await screen.findByRole("link", { name });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
      expect(link).toHaveAttribute("href", "https://discord.gg/duneawakeningdocker");
      expect(link.lastElementChild).toHaveClass("lucide-external-link", "sidebar-external-link");
      expect(link.lastElementChild).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("shows the installed version from /api/auth/state when the update check fails", async () => {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      const url = String(path);
      if (url.includes("/api/auth/state")) return json({ authenticated: true, csrfToken: "t", config: { version: "1.4.44" } });
      if (url.includes("/api/setup/state")) return json({ files: { complete: true }, config: {} });
      return json({ error: "unavailable" }, 500);
    }));

    render(<App />);

    const badge = await screen.findByRole("button", { name: "Open Updates" });
    await waitFor(() => expect(badge).toHaveTextContent("v1.4.44"));
  });

  it("keeps the Updates page result when the sidebar's own check fails afterwards", async () => {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const task = (id: string, status: string, lines: string[] = []) => ({ task: { id, type: "updates", operation: "selfUpdateCheck", status, currentStep: "", progressMessage: "", warnings: [], startedAt: "", finishedAt: null, errorMessage: null, logLines: lines.map((line) => ({ timestamp: "", stream: "stdout", line })) } });
    let stackChecks = 0;
    let failSidebarPoll = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((path: string) => {
      const url = String(path);
      if (url.includes("/api/auth/state")) return json({ authenticated: true, csrfToken: "t", config: { version: "1.4.43" } });
      if (url.includes("/api/setup/state")) return json({ files: { complete: true }, config: {} });
      if (url.includes("/api/updates/check-stack")) {
        stackChecks += 1;
        return stackChecks === 1 ? json(task("slow", "running")) : json(task("done", "succeeded", ["Current stack version: v1.4.43", "Latest release:        v1.4.44", "A newer stack version is available."]));
      }
      if (url.includes("/api/setup/tasks/slow")) return failSidebarPoll ? json({ error: "unavailable" }, 500) : json(task("slow", "running"));
      return json({ error: "unavailable" }, 500);
    }));

    render(<App />);
    const badge = await screen.findByRole("button", { name: "Open Updates" });
    await waitFor(() => expect(stackChecks).toBe(1));
    fireEvent.click(badge);
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Available" }).textContent).toBe("v1.4.43 > v1.4.44"), { timeout: 5000 });

    const pollsBefore = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("/tasks/slow")).length;
    failSidebarPoll = true;
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("/tasks/slow")).length).toBeGreaterThan(pollsBefore), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("button", { name: "Update Available" }).textContent).toBe("v1.4.43 > v1.4.44");
  }, 15000);
});
