import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { IamPolicyEditor } from "./IamPolicyEditor";
// Vite raw-import suffix, resolved by Vite's transform pipeline at build/test
// time. Vite 8's own bundled types now declare "*?raw" as an ambient module
// (confirmed: the @ts-expect-error this line previously needed -- to suppress
// a real TS error under Vite 6 -- became a TS2578 "unused directive" error
// the moment the Vite 6 -> 8 upstream bump landed, since TS no longer errors
// on this import at all).
import iamPolicyEditorSource from "./IamPolicyEditor.tsx?raw";

// Regression tests for three IAM-editor contract bugs found in review:
//   (a) save issued POST {tier,statements} but the route is PUT {whole store}
//   (b) the Test tab called a server route whose contract it did not match
//   (c) the owner tier's string Action ("*") crashed toggleAction, and a
//       wildcard-granted checkbox silently snapped back
vi.mock("../../api/client", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const CATALOG = {
  policies: {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] }, // STRING Action -> case (c)
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["server:*"] }, { Effect: "Deny", Action: ["settings:*"] }] },
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
    player: { version: 1, tier: "player", statements: [{ Effect: "Allow", Action: ["server:read"] }] },
  },
  actions: ["POST /api/server/restart", "GET /api/server", "POST /api/settings/admin-password"],
  actionMap: {
    "POST /api/server/restart": "server:restart",
    "GET /api/server": "server:read",
    "POST /api/settings/admin-password": "settings:change-password",
  },
  // players:kick is a parameterized-route action: it has NO literal actionMap
  // key, so it exists only here. regression -- the grid must still show it.
  allActions: ["server:restart", "server:read", "settings:change-password", "players:kick"],
  namespaces: {},
};

function mockLoad() {
  mockApi.mockImplementation((path: string, opts?: RequestInit) => {
    if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) {
      return Promise.resolve(structuredClone(CATALOG) as never);
    }
    if (path === "/api/settings/iam/policy" && opts?.method === "PUT") {
      return Promise.resolve({ ok: true, policies: JSON.parse(String(opts.body)) } as never);
    }
    return Promise.reject(new Error(`unexpected api call: ${opts?.method || "GET"} ${path}`));
  });
}

// Regression test for the exact bug Red-Blink reported on upstream PR #202
// (2026-09-06): when the initial GET /api/settings/iam/policies request
// fails, the component used to `return` its "Failed to load" error section
// immediately after the load effect -- BEFORE the several useMemo Hooks
// declared further down the component body. The very first render (catalog
// and loadError both still their initial falsy values) always fell through
// past that early return and called every Hook; the RE-render triggered by
// the failed fetch's setLoadError(true) then hit the early return and
// called fewer Hooks than the first render did, which React detects and
// throws "Rendered fewer hooks than expected" for -- crashing the one render
// that was supposed to show Retry, instead of showing it.
describe("IamPolicyEditor: a failed initial load shows Retry instead of crashing (review finding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the Failed-to-load / Retry section, without throwing a hooks-order error, when the policy fetch rejects", async () => {
    mockApi.mockImplementation(() => Promise.reject(new Error("network error")));
    render(<IamPolicyEditor />);
    // Before the fix, this render throws ("Rendered fewer hooks than
    // expected") instead of ever reaching this text.
    expect(await screen.findByText("Failed to load IAM policies")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("IamPolicyEditor server contracts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a checkbox for a parameterized-route action present only in allActions (players:kick)", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    // players:kick has no actionMap route key; before the fix the grid iterated
    // only actionMap values and this action never appeared (raw-JSON only).
    expect(await screen.findByText("players:kick")).toBeTruthy();
  });

  it("#5 save PUTs the whole tier-keyed store, not POST {tier, statements}", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Save admin policy"));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/settings/iam/policy",
        expect.objectContaining({ method: "PUT" })
      )
    );
    const putCall = mockApi.mock.calls.find(([p, o]) => p === "/api/settings/iam/policy" && (o as RequestInit)?.method === "PUT")!;
    const body = JSON.parse(String((putCall[1] as RequestInit).body));
    // Every tier is present (whole store), with admin's edited document in place.
    expect(Object.keys(body).sort()).toEqual(["admin", "moderator", "owner", "player"]);
    expect(body.admin.statements).toEqual(CATALOG.policies.admin.statements);
    // Never the broken POST-single-document shape.
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "POST" }));
  });

  it("Test tab evaluates the draft locally and honors Deny, with no /policy/test call", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Test"));

    // admin: server:* -> server:restart + server:read allowed (2); settings:* Deny -> change-password
    // denied, and players:kick is neither allowed nor denied so it default-denies too (2 denied).
    expect(await screen.findByText("2 allowed")).toBeTruthy();
    expect(screen.getByText("2 denied")).toBeTruthy();
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy/test", expect.anything());
  });

  it("#7 the owner tier's string Action does not crash the grid, and a wildcard grant surfaces a hint instead of snapping back", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Owner")); // string Action "*" -> would throw before the fix

    // The grid renders (owner sees everything allowed via "*") without throwing;
    // before the fix, toggleAction's s.Action.filter on the string "*" threw.
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]); // wildcard-granted: cannot be toggled off by checkbox
    expect(await screen.findByText(/granted by a wildcard rule/i)).toBeTruthy();
  });

  it("action-centric grid: many routes sharing one IAM action render ONE checkbox (unchecking no longer clears siblings)", async () => {
    // GET /api/server, /status, /health all map to server:read. The old
    // route-centric grid drew THREE "Read" checkboxes and unchecking one cleared
    // the others (the reported bug). Action-centric => one "Read" checkbox.
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.actions = ["GET /api/server", "GET /api/server/status", "GET /api/server/health", "POST /api/server/restart"];
    dup.actionMap = {
      "GET /api/server": "server:read",
      "GET /api/server/status": "server:read",
      "GET /api/server/health": "server:read",
      "POST /api/server/restart": "server:restart",
    };
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      if (path === "/api/settings/iam/policy" && opts?.method === "PUT") return Promise.resolve({ ok: true, policies: JSON.parse(String(opts.body)) } as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Moderator")); // moderator allows exactly server:read (exact literal, toggleable)

    // 3 read routes collapse to ONE "Read" checkbox; one "Restart" too.
    await waitFor(() => expect(screen.getAllByText("Read").length).toBe(1));
    expect(screen.getAllByText("Restart").length).toBe(1);

    // Unchecking Read removes only server:read; save PUTs moderator without it.
    const readRow = screen.getByText("Read").closest("label")!;
    fireEvent.click(readRow.querySelector('input[type="checkbox"]')!);
    fireEvent.click(screen.getByText("Save moderator policy"));
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "PUT" })));
    const put = mockApi.mock.calls.find(([p, o]) => p === "/api/settings/iam/policy" && (o as RequestInit)?.method === "PUT")!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    const modActions = body.moderator.statements.flatMap((st: { Action: string[] }) => st.Action);
    expect(modActions).not.toContain("server:read");
  });

  it("#10 toggleAction's grant/revoke branch decision reads the freshly-parsed statements, not the outer allowedActions memo (review finding, source pin)", () => {
    // A DOM-event-timing reproduction of "two toggles fired before React
    // re-renders between them" is not reliably reproducible under jsdom/RTL
    // (each dispatched event is independently flushed by React's per-event
    // batching in this environment, even nested inside one act() call) --
    // actionGrantedByStatements' own behavior across chained statement lists
    // is covered directly in IamPolicyEditor.grouping.test.ts. This pins the
    // actual regression: toggleAction's branch decision must call
    // actionGrantedByStatements(stmts, ...) -- the freshly-parsed, in-flight
    // statement list -- never allowedActions.has(...), the memoized value
    // from the last completed render, which the first fix (c3b416d4) left in
    // place when it moved only the text mutation to a functional update.
    const src = iamPolicyEditorSource as string;
    const toggleActionStart = src.indexOf("const toggleAction = (iamAction: string) => {");
    expect(toggleActionStart).toBeGreaterThan(-1);
    const toggleActionBody = src.slice(toggleActionStart, toggleActionStart + 1200);
    expect(toggleActionBody).toMatch(/actionGrantedByStatements\(stmts,\s*iamAction\)/);
    expect(toggleActionBody).not.toMatch(/allowedActions\.has\(iamAction\)/);
  });
});

describe("IamPolicyEditor: ambiguous action labels get a plain-language explanation (live-testing finding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives the Deny-locked, jargon-adjacent action players:give-item a description tooltip", async () => {
    // players:give-item is one of the players:mutate economy successors
    // (policy.js's CROWN_JEWEL_DENY_ACTIONS) -- its bare mechanical label
    // ("Give Item") is clear enough on its own that it isn't relabeled the
    // way the old, un-split "Mutate" was, but it still gets a tooltip so an
    // operator can see why it's blocked without leaving the grid.
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.policies.admin = {
      version: 1, tier: "admin",
      statements: [{ Effect: "Allow", Action: ["players:*"] }, { Effect: "Deny", Action: ["players:give-item"] }],
    };
    dup.actions = ["POST /api/players/give-item"];
    dup.actionMap = { "POST /api/players/give-item": "players:give-item" };
    dup.allActions = ["players:give-item"];
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));

    const label = await screen.findByText("Give Item");
    expect(label.getAttribute("title")).toMatch(/economy-inflation/i);
    const row = label.closest("label")!;
    expect(row.getAttribute("title")).toMatch(/economy-inflation/i);
    expect(row.getAttribute("title")).toMatch(/blocked by a deny rule/i);
  });

  it("relabels admin:vehicles:read so it doesn't read as the unrelated live-Vehicles-panel permission", async () => {
    const dup = structuredClone(CATALOG) as { policies: typeof CATALOG.policies; actions: string[]; actionMap: Record<string, string>; allActions: string[]; namespaces: Record<string, unknown> };
    dup.policies.admin = { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: ["admin:vehicles:read"] }] };
    dup.actions = ["GET /api/admin/vehicles/structured"];
    dup.actionMap = { "GET /api/admin/vehicles/structured": "admin:vehicles:read" };
    dup.allActions = ["admin:vehicles:read"];
    mockApi.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === "/api/settings/iam/policies" && (!opts || opts.method === undefined)) return Promise.resolve(dup as never);
      return Promise.reject(new Error("unexpected"));
    });
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));

    expect(await screen.findByText("Vehicle Catalog")).toBeTruthy();
    expect(screen.queryByText("Vehicles Read")).toBeNull();
  });
});

describe("IamPolicyEditor: the Permissions grid is read-only while the JSON tab holds invalid JSON", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not replace the draft with a single Allow when a box is clicked over unparseable JSON", async () => {
    mockLoad();
    render(<IamPolicyEditor />);
    fireEvent.click(await screen.findByText("Admin"));
    fireEvent.click(await screen.findByText("JSON"));
    const textarea = document.querySelector("textarea.iam-json-textarea") as HTMLTextAreaElement;
    const broken = '[{"Effect":"Allow","Action":["server:*"]},{"Effect":"Deny","Action":["settings:*"]},]'; // trailing comma
    fireEvent.change(textarea, { target: { value: broken } });
    fireEvent.click(screen.getByText("Permissions"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid JSON/i);
    const boxes = document.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toBeDisabled();
    fireEvent.click(boxes[0]);

    fireEvent.click(screen.getByText("JSON"));
    const after = document.querySelector("textarea.iam-json-textarea") as HTMLTextAreaElement;
    expect(after.value).toBe(broken); // the operator's draft -- Deny block included -- is untouched
    expect(mockApi).not.toHaveBeenCalledWith("/api/settings/iam/policy", expect.objectContaining({ method: "PUT" }));
  });
});
