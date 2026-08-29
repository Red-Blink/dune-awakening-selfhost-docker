import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiKeysSection } from "./ApiKeysSection";
import type { ApiKey, ScopeCatalogEntry } from "../../api/apiKeys";

vi.mock("../../api/apiKeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/apiKeys")>();
  return {
    ...actual,
    apiKeysApi: {
      list: vi.fn(),
      catalog: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      revoke: vi.fn()
    }
  };
});

vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

import { apiKeysApi } from "../../api/apiKeys";

const CATALOG: ScopeCatalogEntry[] = [
  { namespace: "players", readActions: ["players:read"], writeActions: ["players:moderate", "players:reset", "players:delete-item"], supportsWrite: true },
  { namespace: "bases", readActions: ["bases:read"], writeActions: ["bases:mutate"], supportsWrite: true },
  // logs has no write action; updates has several but they are denied to keys.
  // Both must render two segments, not three.
  { namespace: "logs", readActions: ["logs:read"], writeActions: [], supportsWrite: false },
  { namespace: "updates", readActions: ["updates:read", "updates:check"], writeActions: [], supportsWrite: false }
];

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "7f3c1a9b",
    name: "Grafana",
    prefix: "dak_7f3c1a9b",
    scopes: { players: "read" },
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    rateLimitPerMinute: 60,
    expired: false,
    ...overrides
  };
}

const mocked = apiKeysApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function renderSection(keys: ApiKey[] = [], confirmAction = vi.fn().mockResolvedValue(true)) {
  mocked.list.mockResolvedValue({ keys });
  mocked.catalog.mockResolvedValue({ namespaces: CATALOG });
  render(<ApiKeysSection confirmAction={confirmAction} />);
  return { confirmAction };
}

async function openCreateForm() {
  fireEvent.click(await screen.findByRole("button", { name: /create key/i }));
  await screen.findByLabelText("Access level for players");
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("shows an empty state before any key exists", async () => {
  renderSection([]);
  expect(await screen.findByText(/No API keys yet/i)).toBeVisible();
});

test("lists keys with their scopes and status", async () => {
  renderSection([
    makeKey({ id: "a1", name: "Grafana", scopes: { players: "read", bases: "write" } }),
    makeKey({ id: "b2", name: "Stats site", enabled: false }),
    makeKey({ id: "c3", name: "Old bot", expiresAt: "2020-01-01T00:00:00.000Z", expired: true })
  ]);
  expect(await screen.findByText("Grafana")).toBeVisible();
  expect(screen.getByText("Bases RW, Players R")).toBeVisible();
  expect(screen.getByText("Active")).toBeVisible();
  expect(screen.getByText("Disabled")).toBeVisible();
  // Expiry comes from the server's own verdict, so the UI can never disagree
  // with what the API will actually do with the key.
  expect(screen.getByText("Expired")).toBeVisible();
});

describe("the create form", () => {
  test("opens with every namespace on None and Create disabled", async () => {
    renderSection([]);
    await openCreateForm();

    for (const namespace of ["players", "bases", "logs", "updates"]) {
      const group = screen.getByLabelText(`Access level for ${namespace}`);
      expect(within(group).getByLabelText(new RegExp(`no access to ${namespace}`, "i"))).toBeChecked();
      expect(within(group).getByLabelText(`Read ${namespace}`)).not.toBeChecked();
    }

    expect(screen.getByText(/Grant at least one namespace first/i)).toBeVisible();
    const submit = screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!;
    expect(submit).toBeDisabled();
  });

  test("Create stays disabled with a name but no grant, and enables once one is given", async () => {
    renderSection([]);
    await openCreateForm();
    const submit = () => screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!;

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grafana" } });
    expect(submit()).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Read players"));
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByText(/Grant at least one namespace first/i)).toBeNull();
  });

  test("offers no write segment for a namespace that has no write actions", async () => {
    renderSection([]);
    await openCreateForm();

    for (const namespace of ["logs", "updates"]) {
      const group = screen.getByLabelText(`Access level for ${namespace}`);
      expect(within(group).queryByLabelText(new RegExp(`Read\\+write for ${namespace}`, "i"))).toBeNull();
    }

    const players = screen.getByLabelText("Access level for players");
    expect(within(players).getByLabelText(/Read\+write for players/i)).toBeInTheDocument();
  });

  test("offers Custom only where there is more than one action to choose between", async () => {
    renderSection([]);
    await openCreateForm();

    // logs has exactly one action, so Custom there would be Read under another
    // name -- the same catalog-driven rule that hides Read+write.
    const logs = screen.getByLabelText("Access level for logs");
    expect(within(logs).queryByLabelText(/Custom actions for logs/i)).toBeNull();
    expect(within(logs).getAllByRole("radio")).toHaveLength(2);

    // updates has two read actions and no writes: no Read+write segment, but
    // Custom is still meaningful.
    const updates = screen.getByLabelText("Access level for updates");
    expect(within(updates).getByLabelText(/Custom actions for updates/i)).toBeInTheDocument();
    expect(within(updates).getAllByRole("radio")).toHaveLength(3);

    expect(within(screen.getByLabelText("Access level for players")).getAllByRole("radio")).toHaveLength(4);
  });

  test("sends only the granted namespaces, with None as absence", async () => {
    renderSection([]);
    mocked.create.mockResolvedValue({ key: makeKey(), secret: "dak_7f3c1a9b_supersecretvalue" });
    await openCreateForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grafana" } });
    fireEvent.click(screen.getByLabelText("Read players"));
    fireEvent.click(screen.getByLabelText(/Read\+write for bases/i));
    // Granted then taken back: must not appear in the payload at all.
    fireEvent.click(screen.getByLabelText("Read logs"));
    fireEvent.click(screen.getByLabelText(/no access to logs/i));

    fireEvent.click(screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!);

    await waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
    expect(mocked.create.mock.calls[0][0]).toMatchObject({
      name: "Grafana",
      scopes: { players: "read", bases: "write" }
    });
    expect(mocked.create.mock.calls[0][0].scopes).not.toHaveProperty("logs");
    expect(mocked.create.mock.calls[0][0].scopes).not.toHaveProperty("updates");
  });

  test("Clear all returns every namespace to None", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.click(screen.getByLabelText("Read players"));
    fireEvent.click(screen.getByLabelText("Read bases"));
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));

    await waitFor(() => expect(screen.getByLabelText(/no access to players/i)).toBeChecked());
    expect(screen.getByLabelText(/no access to bases/i)).toBeChecked();
    expect(screen.getByText(/Grant at least one namespace first/i)).toBeVisible();
  });

  test("offers no bulk-grant control", async () => {
    // Deliberate: a one-click grant-everything button would turn the
    // per-namespace opt-in into a formality.
    renderSection([]);
    await openCreateForm();
    expect(screen.queryByRole("button", { name: /set all|grant all|select all/i })).toBeNull();
  });

  test("Custom seeds from the level it replaces, so switching does not drop access", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.click(screen.getByLabelText(/Read\+write for players/i));
    fireEvent.click(screen.getByLabelText("Custom actions for players"));

    // Seeded from Read+write, which is every action in the namespace.
    for (const action of ["players:read", "players:moderate", "players:reset", "players:delete-item"]) {
      expect(screen.getByRole("checkbox", { name: action })).toBeChecked();
    }
    expect(screen.getByText(/4 of 4 actions selected/i)).toBeInTheDocument();
  });

  test("Custom seeded from Read carries only the read actions", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.click(screen.getByLabelText("Read players"));
    fireEvent.click(screen.getByLabelText("Custom actions for players"));

    expect(screen.getByRole("checkbox", { name: "players:read" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "players:moderate" })).not.toBeChecked();
    expect(screen.getByText(/1 of 4 actions selected/i)).toBeInTheDocument();
  });

  test("a Custom namespace sends the ticked actions, not a level", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: "moderation bot" } });
    fireEvent.click(screen.getByLabelText("Custom actions for players"));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:read" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:moderate" }));

    fireEvent.click(screen.getByRole("button", { name: /Create Key/i }));

    await waitFor(() => expect(mocked.create).toHaveBeenCalled());
    const [sent] = mocked.create.mock.calls[0];
    // The whole point: the destructive actions are absent, not merely unticked.
    expect(sent.scopes.players).toEqual(["players:moderate", "players:read"]);
  });

  test("unticking an action removes it from what is sent", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: "narrower" } });
    fireEvent.click(screen.getByLabelText(/Read\+write for players/i));
    fireEvent.click(screen.getByLabelText("Custom actions for players"));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:reset" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:delete-item" }));

    fireEvent.click(screen.getByRole("button", { name: /Create Key/i }));

    await waitFor(() => expect(mocked.create).toHaveBeenCalled());
    const [sent] = mocked.create.mock.calls[0];
    expect(sent.scopes.players).toEqual(["players:moderate", "players:read"]);
  });

  test("a Custom row with nothing ticked does not count as a grant", async () => {
    // The server drops an empty action list, so Create must not be enabled for
    // a key that would reach nothing.
    renderSection([]);
    await openCreateForm();

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: "empty" } });
    fireEvent.click(screen.getByLabelText("Custom actions for players"));

    expect(screen.getByText(/0 of 4 actions selected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create Key/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "players:read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Create Key/i })).toBeEnabled());
  });

  test("an empty Custom row is not highlighted as granted", async () => {
    // The .granted class and grantedCount must agree, or the grid claims
    // access the key does not have. Asserted through the class because that is
    // what paints it -- jsdom has no layout engine, so the rendered colour
    // stays a browser check.
    renderSection([]);
    await openCreateForm();

    const row = () => screen.getByLabelText("Access level for players").closest(".api-key-scope-row")!;

    fireEvent.click(screen.getByLabelText("Read players"));
    expect(row().className).toContain("granted");

    // Custom seeds from the level it replaces, so this arrives with
    // players:read already ticked -- still granted, now as a list.
    fireEvent.click(screen.getByLabelText("Custom actions for players"));
    expect(screen.getByRole("checkbox", { name: "players:read" })).toBeChecked();
    expect(row().className).toContain("granted");

    // Untick the only seeded action: still Custom, but reaching nothing.
    fireEvent.click(screen.getByRole("checkbox", { name: "players:read" }));
    expect(screen.getByText(/0 of 4 actions selected/i)).toBeInTheDocument();
    expect(row().className).not.toContain("granted");
    expect(screen.getByRole("button", { name: /Create Key/i })).toBeDisabled();
  });

  test("switching a Custom namespace back to a level sends the level", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: "relevelled" } });
    fireEvent.click(screen.getByLabelText("Custom actions for players"));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:read" }));
    fireEvent.click(screen.getByLabelText("Read players"));

    // The checklist is gone and the stored value is a level again, so the key
    // keeps the auto-covering behaviour a level carries.
    expect(screen.queryByRole("checkbox", { name: "players:read" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Create Key/i }));
    await waitFor(() => expect(mocked.create).toHaveBeenCalled());
    expect(mocked.create.mock.calls[0][0].scopes.players).toBe("read");
  });

  test("Clear All removes a Custom selection too", async () => {
    renderSection([]);
    await openCreateForm();

    fireEvent.click(screen.getByLabelText("Custom actions for players"));
    fireEvent.click(screen.getByRole("checkbox", { name: "players:moderate" }));
    fireEvent.click(screen.getByRole("button", { name: /Clear All/i }));

    expect(screen.queryByRole("checkbox", { name: "players:moderate" })).toBeNull();
    expect(screen.getByRole("button", { name: /Create Key/i })).toBeDisabled();
  });
});

describe("the one-time key reveal", () => {
  test("shows the secret once, with a copy button, then dismisses", async () => {
    renderSection([]);
    mocked.create.mockResolvedValue({ key: makeKey(), secret: "dak_7f3c1a9b_supersecretvalue" });
    await openCreateForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grafana" } });
    fireEvent.click(screen.getByLabelText("Read players"));
    fireEvent.click(screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!);

    const field = await screen.findByLabelText(/API key for Grafana/i);
    expect(field).toHaveValue("dak_7f3c1a9b_supersecretvalue");
    expect(screen.getByText(/will not be shown again/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /copied/i })).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: /saved it/i }));
    await waitFor(() => expect(screen.queryByLabelText(/API key for Grafana/i)).toBeNull());
  });
});

describe("revoking", () => {
  test("asks for confirmation with the danger flag and only then deletes", async () => {
    const { confirmAction } = renderSection([makeKey({ name: "Grafana" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Grafana" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[0][0]).toMatch(/Grafana/);
    // "revoke" is not in ConfirmDialog's danger auto-detect regex, so this has
    // to be passed explicitly or the dialog renders as a neutral prompt.
    expect(confirmAction.mock.calls[0][1]).toMatchObject({ danger: true, confirmLabel: "Revoke" });
    await waitFor(() => expect(mocked.revoke).toHaveBeenCalledWith("7f3c1a9b"));
  });

  test("does nothing when the operator cancels", async () => {
    renderSection([makeKey({ name: "Grafana" })], vi.fn().mockResolvedValue(false));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Grafana" }));
    await waitFor(() => expect(mocked.revoke).not.toHaveBeenCalled());
  });
});

test("toggling a key enabled sends only the enabled flag", async () => {
  renderSection([makeKey({ name: "Grafana", enabled: true })]);
  mocked.update.mockResolvedValue({ key: makeKey({ enabled: false }) });

  fireEvent.click(await screen.findByRole("button", { name: "Disable Grafana" }));
  await waitFor(() => expect(mocked.update).toHaveBeenCalledWith("7f3c1a9b", { enabled: false }));
});

// The three tests below are regressions. Every outcome the operator can trigger
// has to render somewhere: InlineActionResult only draws when result.key equals
// a mounted resultKey, and these outcomes were keyed by key.id, which nothing
// mounts -- so they silently rendered nothing at all.

test("a toggle outcome is shown to the operator, not swallowed", async () => {
  renderSection([makeKey({ name: "Grafana", enabled: true })]);
  mocked.update.mockResolvedValue({ key: makeKey({ enabled: false }) });

  fireEvent.click(await screen.findByRole("button", { name: "Disable Grafana" }));
  expect(await screen.findByText(/Grafana disabled/i)).toBeVisible();
});

test("a failed toggle surfaces the server's reason", async () => {
  renderSection([makeKey({ name: "Grafana", enabled: true })]);
  mocked.update.mockRejectedValue(new Error("Key is in use by an active session"));

  fireEvent.click(await screen.findByRole("button", { name: "Disable Grafana" }));
  expect(await screen.findByText(/in use by an active session/i)).toBeVisible();
});

test("a failed revoke surfaces the server's reason after the operator confirmed", async () => {
  // The worst case: the operator cleared a danger dialog, the delete failed,
  // and nothing at all was rendered — so the key looked revoked but was not.
  renderSection([makeKey({ name: "Grafana" })]);
  mocked.revoke.mockRejectedValue(new Error("Key is referenced by a running task"));

  fireEvent.click(await screen.findByRole("button", { name: "Revoke Grafana" }));
  await waitFor(() => expect(mocked.revoke).toHaveBeenCalled());
  expect(await screen.findByText(/referenced by a running task/i)).toBeVisible();
});

test("a refresh failure after a successful create is reported, and the secret is still shown", async () => {
  // create() succeeded, so the key exists on the server and its secret can never
  // be recovered — the reveal must survive, and the stale table must be called
  // out rather than silently left in place.
  mocked.list.mockResolvedValueOnce({ keys: [] });
  mocked.catalog.mockResolvedValue({ namespaces: CATALOG });
  render(<ApiKeysSection confirmAction={vi.fn().mockResolvedValue(true)} />);

  mocked.create.mockResolvedValue({ key: makeKey(), secret: "dak_7f3c1a9b_supersecretvalue" });
  mocked.list.mockRejectedValue(new Error("Postgres is not running"));

  fireEvent.click(await screen.findByRole("button", { name: /create key/i }));
  await screen.findByLabelText("Access level for players");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grafana" } });
  fireEvent.click(screen.getByLabelText("Read players"));
  fireEvent.click(screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!);

  expect(await screen.findByText(/could not be refreshed/i)).toBeVisible();
  expect(screen.getByLabelText(/API key for Grafana/i)).toHaveValue("dak_7f3c1a9b_supersecretvalue");
});

test("the one-time reveal is announced and takes focus", async () => {
  // The secret cannot be recovered, and the button the operator activated is
  // unmounted at this point — without this the appearance is silent for a
  // screen reader and focus drops to the body.
  renderSection([]);
  mocked.create.mockResolvedValue({ key: makeKey(), secret: "dak_7f3c1a9b_supersecretvalue" });
  await openCreateForm();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grafana" } });
  fireEvent.click(screen.getByLabelText("Read players"));
  fireEvent.click(screen.getAllByRole("button", { name: /^create key$/i }).at(-1)!);

  const field = await screen.findByLabelText(/API key for Grafana/i);
  const region = field.closest(".api-key-reveal") as HTMLElement;
  expect(region).toHaveAttribute("role", "alert");
  expect(region).toHaveAttribute("aria-live", "assertive");
  // The accessible name has to carry the warning: the visible text sits in a
  // sibling node a screen reader will not tie to the field.
  expect(field).toHaveAccessibleName(/will not be shown again/i);
  expect(document.activeElement).toBe(field);
});

test("a refresh failure after a successful revoke still says the key is gone", async () => {
  // The worst case: the revoke is irreversible, so reporting a bare error over
  // a stale table that still lists the key as Active tells the operator the
  // opposite of what happened.
  renderSection([makeKey({ name: "Grafana" })]);
  mocked.revoke.mockResolvedValue({ ok: true });
  mocked.list.mockRejectedValue(new Error("Postgres is not running"));

  fireEvent.click(await screen.findByRole("button", { name: "Revoke Grafana" }));
  await waitFor(() => expect(mocked.revoke).toHaveBeenCalled());
  expect(await screen.findByText(/Grafana revoked/i)).toBeVisible();
  expect(screen.getByText(/could not be refreshed/i)).toBeVisible();
});

test("a refresh failure after a successful toggle does not report the toggle as failed", async () => {
  renderSection([makeKey({ name: "Grafana", enabled: true })]);
  mocked.update.mockResolvedValue({ key: makeKey({ enabled: false }) });
  mocked.list.mockRejectedValue(new Error("Postgres is not running"));

  fireEvent.click(await screen.findByRole("button", { name: "Disable Grafana" }));
  await waitFor(() => expect(mocked.update).toHaveBeenCalled());
  expect(await screen.findByText(/Grafana disabled/i)).toBeVisible();
  expect(screen.getByText(/could not be refreshed/i)).toBeVisible();
});

test("every segment's accessible name contains its visible label", async () => {
  // WCAG 2.5.3 Label in Name: a voice-control user says what they can see, so
  // "None" must appear in the name, not be replaced by "No access to bases".
  renderSection([]);
  await openCreateForm();

  for (const group of screen.getAllByRole("radiogroup")) {
    for (const radio of within(group).getAllByRole("radio")) {
      const visible = radio.parentElement?.querySelector("span")?.textContent ?? "";
      const accessible = radio.getAttribute("aria-label") ?? "";
      expect(visible.length).toBeGreaterThan(0);
      expect(accessible.toLowerCase()).toContain(visible.toLowerCase());
    }
  }
});

test("the actions cell is styled, so the row icons are not flush together", async () => {
  // Without actionClassName the <td> has no class and the only rule sizing the
  // icon group (.actions-column .icon-toggle-group) never matches.
  renderSection([makeKey({ name: "Grafana" })]);
  const revoke = await screen.findByRole("button", { name: "Revoke Grafana" });
  const cell = revoke.closest("td");
  expect(cell).not.toBeNull();
  expect(cell).toHaveClass("actions-column");
});

test("a catalog failure explains itself instead of leaving the form a dead end", async () => {
  // list and catalog fail for different reasons. Promise.all used to reject the
  // whole refresh on a catalog failure, blank the key list, and leave the create
  // form with an empty scope grid and Create permanently disabled -- with only
  // "Grant at least one namespace first" to explain it.
  mocked.list.mockResolvedValue({ keys: [makeKey({ name: "Grafana" })] });
  mocked.catalog.mockRejectedValue(new Error("Catalog unavailable"));
  render(<ApiKeysSection confirmAction={vi.fn()} />);

  // The key list still renders -- a catalog failure is not a list failure.
  expect(await screen.findByText("Grafana")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /create key/i }));
  expect(await screen.findByText(/could not be loaded/i)).toBeVisible();
  expect(screen.getByText(/Catalog unavailable/i)).toBeVisible();
});

test("a catalog refresh failure says the list may be stale, not that nothing can be chosen", async () => {
  // refresh() also runs after every mutation. A failure there leaves the
  // previously loaded catalog fully rendered, so claiming "no permissions can
  // be chosen" while 18 rows sit on screen with Create enabled is simply false.
  renderSection([makeKey({ name: "Grafana", enabled: true })]);
  mocked.update.mockResolvedValue({ key: makeKey({ enabled: false }) });

  fireEvent.click(await screen.findByRole("button", { name: /create key/i }));
  await screen.findByLabelText("Access level for players");

  // Catalog starts healthy, then fails on the post-mutation refresh.
  mocked.catalog.mockRejectedValue(new Error("SIMULATED outage"));
  fireEvent.click(screen.getByRole("button", { name: "Disable Grafana" }));

  expect(await screen.findByText(/could not be refreshed, so it may be out of date/i)).toBeVisible();
  expect(screen.queryByText(/no permissions can be chosen/i)).toBeNull();
  // The grid really is still usable, which is why the other wording would lie.
  expect(screen.getByLabelText("Access level for players")).toBeInTheDocument();
});

test("the scopes cell carries a title so long grants stay readable", async () => {
  // The global `td { max-width: 360px }` ellipses this column, and it is the one
  // that says what the key can actually do.
  renderSection([makeKey({ name: "Grafana", scopes: { players: "read", bases: "write", maps: "read" } })]);
  const cell = await screen.findByTitle("Bases RW, Maps R, Players R");
  expect(cell).toBeVisible();
  expect(cell).toHaveTextContent("Bases RW, Maps R, Players R");
});

test("surfaces a load failure instead of rendering an empty list as success", async () => {
  mocked.list.mockRejectedValue(new Error("Postgres is not running"));
  mocked.catalog.mockResolvedValue({ namespaces: CATALOG });
  render(<ApiKeysSection confirmAction={vi.fn()} />);
  expect(await screen.findByText(/Postgres is not running/i)).toBeVisible();
});
