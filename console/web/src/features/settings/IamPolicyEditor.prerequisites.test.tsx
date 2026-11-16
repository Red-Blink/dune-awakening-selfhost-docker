import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { IamPolicyEditor, readPrerequisite } from "./IamPolicyEditor";

// A role cannot be given actions in an area it cannot open (the API refuses the
// save, policy.js missingPrerequisites). The grid enforces the same rule, so an
// owner cannot build a draft the save will reject.
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

function catalogWith(moderator: string[]) {
  return {
    policies: {
      owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: ["*"] }] },
      admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
      moderator: { version: 1, tier: "moderator", statements: moderator.length ? [{ Effect: "Allow", Action: moderator }] : [] },
      player: { version: 1, tier: "player", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
    },
    actions: ["GET /api/server", "POST /api/server/stop"],
    actionMap: { "GET /api/server": "server:read", "POST /api/server/stop": "server:stop" },
    allActions: ["server:read", "server:stop", "community:suggest-translation"],
    namespaces: {},
  };
}

async function open(moderator: string[]) {
  mockApi.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(catalogWith(moderator) as never);
    return Promise.reject(new Error(`unexpected api call: ${opts?.method || "GET"} ${path}`));
  });
  render(<IamPolicyEditor />);
  fireEvent.click(await screen.findByText("Moderator"));
  await waitFor(() => expect(screen.getAllByText("Read").length).toBe(1));
}

const box = (label: string) => screen.getByText(label).closest("label")!.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe("IamPolicyEditor: permission prerequisites", () => {
  beforeEach(() => vi.clearAllMocks());

  it("readPrerequisite maps an action to its own area's read action, only when that exists", () => {
    const known = new Set(["server:read", "server:stop", "admin:motd:read", "admin:motd:write", "admin:broadcast", "community:suggest-translation"]);
    expect(readPrerequisite("server:stop", known)).toBe("server:read");
    expect(readPrerequisite("admin:motd:write", known)).toBe("admin:motd:read");
    expect(readPrerequisite("server:read", known)).toBeNull();
    expect(readPrerequisite("admin:broadcast", known)).toBeNull();
    expect(readPrerequisite("community:suggest-translation", known)).toBeNull();
  });

  it("refuses to grant an action while the role lacks the area's read grant, and says what to grant first", async () => {
    await open([]);
    fireEvent.click(box("Stop"));
    expect(box("Stop").checked).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("server:stop needs server:read first");
  });

  it("allows the same grant once the area is granted first", async () => {
    await open(["server:read"]);
    fireEvent.click(box("Stop"));
    await waitFor(() => expect(box("Stop").checked).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refuses to remove the read grant while other grants in that area depend on it", async () => {
    await open(["server:read", "server:stop"]);
    fireEvent.click(box("Read"));
    expect(box("Read").checked).toBe(true);
    expect(await screen.findByRole("status")).toHaveTextContent("server:read is needed by server:stop. Remove those first.");
    fireEvent.click(box("Stop"));
    await waitFor(() => expect(box("Stop").checked).toBe(false));
    fireEvent.click(box("Read"));
    await waitFor(() => expect(box("Read").checked).toBe(false));
  });
});
